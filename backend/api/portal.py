"""/api/portal — the CLIENT-FACING slice of PMO 360. A separate namespace.

WHY A SEPARATE NAMESPACE AND NOT A FILTER ON THE INTERNAL API
-------------------------------------------------------------
Every internal GET is deliberately ungated (change_orders.py:547) and there
are 170 of them. Retrofitting a client filter onto each one has a silent
failure mode: endpoint 171, added next quarter without the filter, leaks and
nothing tells anyone. A separate namespace has a visible failure mode: the
client cannot see something they should, which is harmless and fixed in an
afternoon. An endpoint that does not exist cannot leak. Pick the architecture
whose failure mode is annoying rather than the one whose failure mode is a
margin disclosure.

THREE RULES, ALL ENFORCED IN THIS FILE
--------------------------------------
1. Every route depends on ``require_portal_client`` — and every DATA route on
   ``require_settled_portal_client``, which additionally refuses a session
   that is still on a temporary password. There is no anonymous portal route
   and no way to reach one with an internal Bearer token.
2. Every query starts from ``portal_portfolios``/``scoped_portfolio``. Nothing
   in this module takes a client_id from the request — scope comes from the
   token, full stop.
3. Every response is an ALLOWLIST projection: an explicit Pydantic model with
   ``extra="forbid"``, constructed field by field, never ``from_orm`` of an ORM
   row. A column added to a model next year is therefore invisible here until
   somebody deliberately adds it. Denylists (``exclude={...}``) are banned in
   this file for exactly that reason — they make new internal fields public by
   default.

WHAT THE SURFACES ARE COMPUTED FROM — AND WHAT THEY DELIBERATELY ARE NOT
-----------------------------------------------------------------------
Every figure below is computed from the ISSUED subset only: meetings the
client has actually received (``Meeting.stage == "sent"``) and change orders
that were approved AND sent. Nothing here reuses the internal metrics or
dashboard endpoints. An adversarial audit refuted every "it is already on
their minutes" claim on the same ground: the internal rollups count drafts,
internal meetings, and actions moved in from other clients' portfolios. What a
client sees here is what a client was sent, and nothing else.

Omitted on purpose, each for a reason the audit established:

  * meeting counts, completed-action counts, overdue, days-since-last-meeting
    — any two of them, sampled weekly, recover Castillo's action close rate
    and drafting cadence, which are vendor scorecards, not project status.
  * risks — agendas carry no "issued" marker, so the latest risk register may
    be one the client was never sent.
  * deliverables — ``Deliverable`` rows are the priced proposal work-breakdown
    with the price column removed; with the contract total they yield a
    per-task rate.
  * ``co_number`` / ``co_version`` in a LIST — a dense per-portfolio sequence
    reveals how many change orders were raised and never shown.
  * per-line change-order amounts, hours, rates — paired with the hour bullets
    already on the client's PDF they yield the margin adder to the cent.
  * "amounts due" — PMO 360 holds pricing and no invoicing. There is no
    Invoice, Payment or balance model anywhere; any figure under that label
    would be fabricated. The change-orders surface says so rather than
    inventing one.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import DateTime, case, func, literal, select, update
from sqlalchemy.orm import Session

from auth.passwords import (
    hash_password, needs_rehash, validate_new_password, verify_password,
)
from auth.portal import (
    PortalPrincipal, hash_token, new_raw_token, portal_portfolios,
    require_portal_client, require_settled_portal_client, scoped_portfolio,
)
from core.deps import get_db
from db.models import (
    ActionItem, ChangeOrder, ClientPortalAccount, ClientPortalToken, Meeting,
    MeetingRFI, PortfolioProject,
)

router = APIRouter(prefix="/api/portal", tags=["portal"])


# ---------------------------------------------------------------- projections
# ALLOWLISTS. Add a field here only after deciding a client may see it.

class PortalMeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_name: str
    label: str
    expires_at: Optional[datetime]
    #: "invite" or "session". The UI shows a logout button and a
    #: change-password screen only for sessions.
    kind: str
    email: Optional[str]
    must_change_password: bool


# ---------------------------------------------------------------- login
# A password login MINTS a portal session token. It does not create a new kind
# of credential: the browser stores the returned token exactly as it would an
# invite link, and every scope rule and allowlist below applies unchanged.

_SESSION_HOURS = 12
_LOCKOUT_ATTEMPTS = 5
_LOCKOUT_MINUTES = 15
#: Longest password accepted on the wire. Enforced in the handlers rather than
#: as a Field constraint: a Pydantic 422 echoes the rejected value back in the
#: response body, and a password must never appear in a response.
_PASSWORD_WIRE_MAX = 256
#: ClientPortalToken.label is String(120); an email can be 255.
_LABEL_MAX = 120
#: One message for every failure — unknown email, wrong password, inactive,
#: locked. Distinguishing them tells an attacker which emails have accounts.
_BAD_LOGIN = "Incorrect email or password."


class PortalLoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=1)


class PortalLoginOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str
    expires_at: datetime
    must_change_password: bool


class PortalChangePasswordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=1)


# ---------------------------------------------------------------- throttle
# Per-account lockout on its own is not enough. It does nothing for unknown
# emails, each of which still costs a full argon2 verify (~50 ms, 64 MiB), and
# "five failures per fifteen minutes" is exactly the budget an attacker needs
# to keep ONE account locked indefinitely. A per-source ceiling bounds both.
#
# In-process and per worker: with N uvicorn workers the real ceiling is N×.
# That is fine for a login form — the point is to make floods and sustained
# re-locking expensive, not to count exactly.

class _SlidingWindow:
    """At most ``limit`` hits per key per rolling ``window`` seconds."""

    def __init__(self, limit: int, window_seconds: int) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> Optional[int]:
        """Record one hit. None when allowed; otherwise seconds until a slot
        frees up, for a Retry-After header."""
        now = time.monotonic()
        cutoff = now - self.window
        with self._lock:
            q = self._hits.get(key)
            if q is None:
                q = self._hits[key] = deque()
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= self.limit:
                return max(1, int(q[0] + self.window - now) + 1)
            q.append(now)
            if len(self._hits) > 5000:   # opportunistic sweep of idle keys
                for k in [k for k, v in self._hits.items() if not v or v[-1] <= cutoff]:
                    del self._hits[k]
            return None

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


#: 20 attempts a minute per source address, 10 per email — whether or not the
#: email exists, so the throttle itself cannot be used to enumerate.
login_ip_limiter = _SlidingWindow(limit=20, window_seconds=60)
login_email_limiter = _SlidingWindow(limit=10, window_seconds=60)


def _client_ip(request: Request) -> str:
    """The caller's address as the ingress saw it.

    Behind Container Apps the ingress APPENDS the real peer to X-Forwarded-For,
    so the last entry is the one a client cannot forge; the first entry is
    whatever the client chose to send. (uvicorn's --proxy-headers takes the
    first, which is why this reads the header itself.) With no proxy header at
    all — local dev — the socket peer."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        last = xff.rsplit(",", 1)[-1].strip()
        if last:
            return last
    return request.client.host if request.client else "unknown"


def _too_many(retry_after: int, detail: str = "Too many sign-in attempts. Try again in a minute.") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=detail,
        headers={"Retry-After": str(retry_after)},
    )


def _bad_login() -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_BAD_LOGIN)


def _mint_session(db: Session, acct: ClientPortalAccount, now: datetime) -> tuple[str, datetime]:
    raw = new_raw_token()
    expires = now + timedelta(hours=_SESSION_HOURS)
    db.add(ClientPortalToken(
        client_id=acct.client_id,
        contact_id=acct.contact_id,
        account_id=acct.id,
        kind="session",
        label=f"session · {acct.email}"[:_LABEL_MAX],
        token_hash=hash_token(raw),
        expires_at=expires,
    ))
    return raw, expires


def _revoke_sessions(db: Session, account_id: int, now: datetime, keep_token_id: Optional[int] = None) -> None:
    q = db.query(ClientPortalToken).filter(
        ClientPortalToken.account_id == account_id,
        ClientPortalToken.kind == "session",
        ClientPortalToken.revoked_at.is_(None),
    )
    if keep_token_id is not None:
        q = q.filter(ClientPortalToken.id != keep_token_id)
    q.update({"revoked_at": now}, synchronize_session=False)


def _record_failure(db: Session, account_id: int, now: datetime) -> bool:
    """Count one wrong password and lock at the threshold — in ONE statement.

    Read-increment-write through the ORM is a lost update: concurrent requests
    each read the same starting value during their ~50 ms verify and each
    write start+1, so twelve parallel guesses left failed_attempts at 1 and no
    lock. Doing the arithmetic in SQL makes the increment atomic on SQLite and
    Postgres alike. Committed here, before the caller raises, because get_db
    rolls back on an exception — and a rolled-back counter is a lockout that
    never fires. Returns True when the account is locked after this failure."""
    nxt = func.coalesce(ClientPortalAccount.failed_attempts, 0) + 1
    tripped = nxt >= _LOCKOUT_ATTEMPTS
    db.execute(
        update(ClientPortalAccount)
        .where(ClientPortalAccount.id == account_id)
        .values(
            failed_attempts=case((tripped, 0), else_=nxt),
            locked_until=case(
                (tripped, literal(now + timedelta(minutes=_LOCKOUT_MINUTES), DateTime())),
                else_=ClientPortalAccount.locked_until,
            ),
        )
        .execution_options(synchronize_session=False)
    )
    db.commit()
    locked_until = db.execute(
        select(ClientPortalAccount.locked_until).where(ClientPortalAccount.id == account_id)
    ).scalar_one()
    return locked_until is not None and locked_until > now


@router.post("/login", response_model=PortalLoginOut)
def login(body: PortalLoginIn, request: Request, db: Session = Depends(get_db)) -> PortalLoginOut:
    """Verify a client's password and mint a 12-hour portal session.

    The argon2 verify runs BEFORE any account-state branch, against a dummy
    hash when there is no account, so the hashing step costs the same on every
    path. That is not a complete timing blind: a wrong password on a live
    account also writes and commits the failure counter, which an unknown
    email does not, and that difference is measurable in a few dozen samples.
    The per-source throttle is what bounds how many samples anybody gets; the
    message is identical on every path regardless.
    """
    wait = login_ip_limiter.hit(_client_ip(request))
    if wait is not None:
        raise _too_many(wait)
    email = body.email.strip().lower()
    wait = login_email_limiter.hit(email)
    if wait is not None:
        raise _too_many(wait)
    if len(body.password) > _PASSWORD_WIRE_MAX:
        raise _bad_login()

    now = datetime.utcnow()
    acct = (
        db.query(ClientPortalAccount)
        .filter(ClientPortalAccount.email == email)
        .one_or_none()
    )
    ok = verify_password(acct.password_hash if acct else None, body.password)

    if acct is None or not acct.is_active or acct.is_locked:
        raise _bad_login()

    if not ok:
        _record_failure(db, acct.id, now)
        raise _bad_login()

    acct.failed_attempts = 0
    acct.locked_until = None
    acct.last_login_at = now
    if needs_rehash(acct.password_hash):
        acct.password_hash = hash_password(body.password)

    raw, expires = _mint_session(db, acct, now)
    return PortalLoginOut(token=raw, expires_at=expires, must_change_password=bool(acct.must_change_password))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    principal: PortalPrincipal = Depends(require_portal_client),
    db: Session = Depends(get_db),
) -> None:
    """Revoke THIS token. Works for invite links too — a client who wants a
    shared link dead can kill it from the page they opened it on."""
    row = db.get(ClientPortalToken, principal.token_id)
    if row is not None and row.revoked_at is None:
        row.revoked_at = datetime.utcnow()


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    body: PortalChangePasswordIn,
    principal: PortalPrincipal = Depends(require_portal_client),
    db: Session = Depends(get_db),
) -> None:
    """Set a new password on the account behind this session.

    Re-verifies the current password even though the caller holds a live
    session — a stolen session must not be enough to take the account over.
    That re-verify is a login in disguise, so it gets every login control:
    refused while the account is locked, each miss counted through the same
    atomic counter as the login form, and when the misses trip the lock THIS
    session is revoked along with the rest — a session guessing at its own
    password is the signal of theft, not of a forgetful owner.

    Order matters. The new password is checked against policy BEFORE the
    current one is verified, so a deliberately bad new password can never be
    used to test a guess for free (the old 400-then-422 ordering was a
    password oracle). On success every OTHER session on the account is
    revoked; this one survives.
    """
    if principal.kind != "session" or principal.account_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This link is not a password account.")
    acct = db.get(ClientPortalAccount, principal.account_id)
    if acct is None or not acct.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "A valid portal session is required.")

    now = datetime.utcnow()
    if acct.is_locked:
        wait = max(1, int((acct.locked_until - now).total_seconds()) + 1)
        raise _too_many(wait, "Too many attempts. Try again later.")

    # Policy first — see the docstring. Neither check touches the stored hash.
    problem = validate_new_password(body.new_password, email=acct.email)
    if problem:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, problem)
    if body.new_password == body.current_password:
        # Once current_password is verified below this is exactly
        # verify(hash, new_password), for free. Without it a temporary
        # password can be "changed" to itself, clearing must-change while the
        # admin who issued it still knows it.
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "The new password must be different from the current one.",
        )

    if (
        len(body.current_password) > _PASSWORD_WIRE_MAX
        or not verify_password(acct.password_hash, body.current_password)
    ):
        if _record_failure(db, acct.id, now):
            _revoke_sessions(db, acct.id, now)   # every session, this one included
            db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The current password is incorrect.")

    acct.password_hash = hash_password(body.new_password)
    acct.must_change_password = False
    acct.password_changed_at = now
    acct.failed_attempts = 0
    acct.locked_until = None
    _revoke_sessions(db, acct.id, now, keep_token_id=principal.token_id)


class PortalSubProjectOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int
    name: str


class PortalPortfolioOut(BaseModel):
    """A portfolio as a client sees it.

    Deliberately omitted: ``scope`` (free text that has carried internal notes),
    ``schedule_version`` and ``sub_projects_json`` (internal bookkeeping),
    ``created_at`` (tells a client when we set them up, which is nobody's
    business but ours)."""
    model_config = ConfigDict(extra="forbid")
    id: int
    name: str
    location: Optional[str]
    state: Optional[str]
    size_mw: Optional[str]
    projects: list[PortalSubProjectOut]


# ---------------------------------------------------------------- routes

@router.get("/me", response_model=PortalMeOut)
def me(principal: PortalPrincipal = Depends(require_portal_client)) -> PortalMeOut:
    """Who am I, and how long does this link last. Lets the portal UI show a
    'link expires on …' notice instead of failing cold on the day."""
    return PortalMeOut(
        client_name=principal.client_name,
        label=principal.label,
        expires_at=principal.expires_at,
        kind=principal.kind,
        email=principal.email,
        must_change_password=principal.must_change_password,
    )


@router.get("/projects", response_model=list[PortalPortfolioOut])
def projects(
    principal: PortalPrincipal = Depends(require_settled_portal_client),
    db: Session = Depends(get_db),
) -> list[PortalPortfolioOut]:
    """The client's portfolios and the sub-projects under each. This is the
    navigation root of the portal; every other surface hangs off one of these
    ids and is re-scoped on every request."""
    rows = portal_portfolios(db, principal).all()
    if not rows:
        return []

    ids = [p.id for p in rows]
    subs = (
        db.query(PortfolioProject)
        .filter(PortfolioProject.portfolio_id.in_(ids))
        .order_by(PortfolioProject.name)
        .all()
    )
    by_portfolio: dict[int, list[PortalSubProjectOut]] = {}
    for s in subs:
        by_portfolio.setdefault(s.portfolio_id, []).append(
            PortalSubProjectOut(id=s.id, name=s.name)
        )

    return [
        PortalPortfolioOut(
            id=p.id,
            name=p.name,
            location=p.location,
            state=p.state,
            size_mw=p.size_mw,
            projects=by_portfolio.get(p.id, []),
        )
        for p in rows
    ]


# ============================================================================
# The four client surfaces
# ============================================================================

#: RFI response-owner labels (monday's vocabulary) that mean "the client owes
#: this". Used ONLY as a filter; response_owner itself is internal and never
#: leaves the server.
_CLIENT_OWNER_LABELS = frozenset({"client data needed", "client response"})
_OPEN_ACTION_STATUSES = ("open", "pending")
#: monday's status vocabulary is not enforced anywhere, so "open" is defined
#: negatively: anything not recognisably closed is open.
_CLOSED_RFI_STATUSES = frozenset({"completed", "done", "closed"})


def _sent_meeting_ids(db: Session, portfolio_id: int) -> list[int]:
    """Meetings the client has actually received. The root of every surface."""
    rows = (
        db.query(Meeting.id)
        .filter(Meeting.project_id == portfolio_id, Meeting.stage == "sent")
        .all()
    )
    return [r[0] for r in rows]


def _rfi_is_open(status: Optional[str]) -> bool:
    return (status or "").strip().lower() not in _CLOSED_RFI_STATUSES


def _issued_rfis(db: Session, portfolio_id: int, sent_ids: list[int]) -> list[MeetingRFI]:
    """Latest snapshot of each RFI that appeared on an ISSUED set of minutes.

    Every meeting re-save rebuilds its RFI rows, so the same monday item can
    appear under several meetings. Newest issued meeting wins."""
    if not sent_ids:
        return []
    rows = (
        db.query(MeetingRFI)
        .join(Meeting, Meeting.id == MeetingRFI.meeting_id)
        .filter(MeetingRFI.meeting_id.in_(sent_ids))
        .order_by(Meeting.meeting_date.desc(), MeetingRFI.order_index.asc())
        .all()
    )
    seen: set[int] = set()
    out: list[MeetingRFI] = []
    for r in rows:
        if r.monday_item_id in seen:
            continue
        seen.add(r.monday_item_id)
        out.append(r)
    return out


def _sub_project_name(r: MeetingRFI, portfolio_id: int) -> Optional[str]:
    """The sub-project heading, ONLY if that sub-project belongs to this
    portfolio. The relationship is not scoped on its own."""
    pp = r.portfolio_project
    if pp is not None and pp.portfolio_id == portfolio_id:
        return pp.name
    return None


# ---------------------------------------------------------------- projections

class PortalRfiOut(BaseModel):
    """An RFI as printed on the client's minutes: item, description, needed-by,
    open/closed, sub-project heading. Exactly the columns both document
    renderers print, and no ids — a bare sub-project id is a global counter."""
    model_config = ConfigDict(extra="forbid")
    item: str
    description: Optional[str]
    needed_by: Optional[date]
    is_open: bool
    project_name: Optional[str]


class PortalActionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    due_date: Optional[date]
    is_open: bool


class PortalMeetingRefOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    meeting_date: Optional[date]
    title: Optional[str]


class PortalChangeOrderOut(BaseModel):
    """No co_number, no version, no lines. Title, date, and the total the client
    was sent — and for hourly orders no total at all, because the stored
    total_amount is not the figure printed on an hourly change order."""
    model_config = ConfigDict(extra="forbid")
    title: Optional[str]
    request_date: Optional[date]
    total: Optional[float]
    is_hourly: bool


class PortalChangeOrderSummaryOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    count: int
    approved_total: float
    hourly_count: int


class PortalDashboardOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    portfolio_name: str
    last_issued_meeting: Optional[PortalMeetingRefOut]
    open_actions: int
    waiting_on_you: int
    approved_change_orders: PortalChangeOrderSummaryOut


class PortalWaitingOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rfis: list[PortalRfiOut]
    actions: list[PortalActionOut]
    note: Optional[str]


class PortalChangeOrdersOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[PortalChangeOrderOut]
    summary: PortalChangeOrderSummaryOut
    #: Always null. PMO 360 has no invoicing model; the field exists so the
    #: UI can render the explanation rather than an empty number.
    amounts_due: None
    note: str


# ---------------------------------------------------------------- builders

def _rfi_out(r: MeetingRFI, portfolio_id: int) -> PortalRfiOut:
    return PortalRfiOut(
        item=r.item_equipment or r.name or "",
        description=(r.description or r.question or None),
        needed_by=r.response_needed_by,
        is_open=_rfi_is_open(r.status),
        project_name=_sub_project_name(r, portfolio_id),
    )


def _sort_rfis(rows: list[PortalRfiOut]) -> list[PortalRfiOut]:
    # Open first; then by needed-by with undated last; then by item.
    return sorted(
        rows,
        key=lambda x: (not x.is_open, x.needed_by is None, x.needed_by or date.max, x.item.lower()),
    )


def _client_owed_actions(db: Session, portfolio_id: int, sent_ids: list[int]) -> list[ActionItem]:
    if not sent_ids:
        return []
    return (
        db.query(ActionItem)
        .filter(
            ActionItem.project_id == portfolio_id,
            ActionItem.originating_meeting_id.in_(sent_ids),
            ActionItem.client_owed.is_(True),
            ActionItem.status.in_(_OPEN_ACTION_STATUSES),
        )
        .order_by(ActionItem.due_date.asc().nulls_last(), ActionItem.id.asc())
        .all()
    )


def _client_owed_rfis(db: Session, portfolio_id: int, sent_ids: list[int]) -> list[MeetingRFI]:
    return [
        r for r in _issued_rfis(db, portfolio_id, sent_ids)
        if _rfi_is_open(r.status)
        and (r.response_owner or "").strip().lower() in _CLIENT_OWNER_LABELS
    ]


def _issued_change_orders(db: Session, portfolio_id: int) -> list[ChangeOrder]:
    """Approved AND sent. A change order the client has not received is not
    theirs to see, whatever its status."""
    return (
        db.query(ChangeOrder)
        .filter(
            ChangeOrder.project_id == portfolio_id,
            ChangeOrder.status == "approved",
            ChangeOrder.sent_at.isnot(None),
        )
        .order_by(ChangeOrder.request_date.asc().nulls_last(), ChangeOrder.id.asc())
        .all()
    )


def _co_summary(rows: list[ChangeOrder]) -> PortalChangeOrderSummaryOut:
    hourly = [c for c in rows if (c.rate_type or "").strip().lower() == "hourly"]
    fixed = [c for c in rows if c not in hourly]
    return PortalChangeOrderSummaryOut(
        count=len(rows),
        approved_total=round(sum(float(c.total_amount or 0.0) for c in fixed), 2),
        hourly_count=len(hourly),
    )


# ---------------------------------------------------------------- routes

@router.get("/projects/{portfolio_id}/dashboard", response_model=PortalDashboardOut)
def dashboard(
    portfolio_id: int,
    principal: PortalPrincipal = Depends(require_settled_portal_client),
    db: Session = Depends(get_db),
) -> PortalDashboardOut:
    p = scoped_portfolio(db, principal, portfolio_id)
    sent_ids = _sent_meeting_ids(db, p.id)

    last = None
    if sent_ids:
        m = (
            db.query(Meeting)
            .filter(Meeting.id.in_(sent_ids))
            .order_by(Meeting.meeting_date.desc(), Meeting.id.desc())
            .first()
        )
        if m is not None:
            last = PortalMeetingRefOut(meeting_date=m.meeting_date, title=m.title)

    open_actions = 0
    if sent_ids:
        open_actions = (
            db.query(ActionItem)
            .filter(
                ActionItem.project_id == p.id,
                ActionItem.originating_meeting_id.in_(sent_ids),
                ActionItem.status.in_(_OPEN_ACTION_STATUSES),
            )
            .count()
        )

    waiting = len(_client_owed_actions(db, p.id, sent_ids)) + len(_client_owed_rfis(db, p.id, sent_ids))

    return PortalDashboardOut(
        portfolio_name=p.name,
        last_issued_meeting=last,
        open_actions=open_actions,
        waiting_on_you=waiting,
        approved_change_orders=_co_summary(_issued_change_orders(db, p.id)),
    )


@router.get("/projects/{portfolio_id}/rfis", response_model=list[PortalRfiOut])
def rfis(
    portfolio_id: int,
    principal: PortalPrincipal = Depends(require_settled_portal_client),
    db: Session = Depends(get_db),
) -> list[PortalRfiOut]:
    p = scoped_portfolio(db, principal, portfolio_id)
    sent_ids = _sent_meeting_ids(db, p.id)
    return _sort_rfis([_rfi_out(r, p.id) for r in _issued_rfis(db, p.id, sent_ids)])


@router.get("/projects/{portfolio_id}/waiting-on-you", response_model=PortalWaitingOut)
def waiting_on_you(
    portfolio_id: int,
    principal: PortalPrincipal = Depends(require_settled_portal_client),
    db: Session = Depends(get_db),
) -> PortalWaitingOut:
    """What the CLIENT owes Castillo: RFIs monday marks as waiting on the
    client, plus actions a PM has flagged `client_owed`. The RFI filter reads
    response_owner server-side and never returns it."""
    p = scoped_portfolio(db, principal, portfolio_id)
    sent_ids = _sent_meeting_ids(db, p.id)
    rfis_out = _sort_rfis([_rfi_out(r, p.id) for r in _client_owed_rfis(db, p.id, sent_ids)])
    actions_out = [
        PortalActionOut(text=a.text, due_date=a.due_date, is_open=True)
        for a in _client_owed_actions(db, p.id, sent_ids)
    ]
    note = None
    if not actions_out:
        note = (
            "Action items appear here once your project manager marks them as "
            "yours to close."
        )
    return PortalWaitingOut(rfis=rfis_out, actions=actions_out, note=note)


@router.get("/projects/{portfolio_id}/change-orders", response_model=PortalChangeOrdersOut)
def change_orders(
    portfolio_id: int,
    principal: PortalPrincipal = Depends(require_settled_portal_client),
    db: Session = Depends(get_db),
) -> PortalChangeOrdersOut:
    p = scoped_portfolio(db, principal, portfolio_id)
    rows = _issued_change_orders(db, p.id)
    items = [
        PortalChangeOrderOut(
            title=c.title,
            request_date=c.request_date,
            total=(None if (c.rate_type or "").strip().lower() == "hourly"
                   else round(float(c.total_amount or 0.0), 2)),
            is_hourly=(c.rate_type or "").strip().lower() == "hourly",
        )
        for c in rows
    ]
    return PortalChangeOrdersOut(
        items=items,
        summary=_co_summary(rows),
        amounts_due=None,
        note=(
            "PMO 360 records approved change orders and their values. Invoices, "
            "payments and balances are not held here — for amounts due, refer to "
            "your invoices."
        ),
    )
