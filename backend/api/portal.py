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
1. Every route depends on ``require_portal_client``. There is no anonymous
   portal route and no way to reach one with an internal Bearer token.
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

from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from auth.portal import (
    PortalPrincipal, portal_portfolios, require_portal_client, scoped_portfolio,
)
from core.deps import get_db
from db.models import ActionItem, ChangeOrder, Meeting, MeetingRFI, PortfolioProject

router = APIRouter(prefix="/api/portal", tags=["portal"])


# ---------------------------------------------------------------- projections
# ALLOWLISTS. Add a field here only after deciding a client may see it.

class PortalMeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_name: str
    label: str
    expires_at: Optional[datetime]


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
    )


@router.get("/projects", response_model=list[PortalPortfolioOut])
def projects(
    principal: PortalPrincipal = Depends(require_portal_client),
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
    principal: PortalPrincipal = Depends(require_portal_client),
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
    principal: PortalPrincipal = Depends(require_portal_client),
    db: Session = Depends(get_db),
) -> list[PortalRfiOut]:
    p = scoped_portfolio(db, principal, portfolio_id)
    sent_ids = _sent_meeting_ids(db, p.id)
    return _sort_rfis([_rfi_out(r, p.id) for r in _issued_rfis(db, p.id, sent_ids)])


@router.get("/projects/{portfolio_id}/waiting-on-you", response_model=PortalWaitingOut)
def waiting_on_you(
    portfolio_id: int,
    principal: PortalPrincipal = Depends(require_portal_client),
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
    principal: PortalPrincipal = Depends(require_portal_client),
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
