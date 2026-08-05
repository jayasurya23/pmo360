"""Per-module write permissions — the vocabulary and the one check helper.

The model is "can look, can't touch". Reads stay open (they are already
filtered by portfolio membership), and each permission gates the WRITES in one
module. Unticking a box must never blank a screen or hide a nav tab — that
would turn a permission system into a support queue.

PERMISSIONS ARE COMPANY-WIDE. The permission says WHAT; nothing says WHERE.
Castillo's rule, handed down after the first release: a PM has access to all
portfolios, not only the ones they are assigned to. `is_portfolio_member` below
is deliberately disabled and is the single switch if that is ever revisited.

This docstring used to claim the opposite — "scope is BOTH", a write allowed
only for a member of that portfolio — and was left saying so for a while after
the code stopped doing it. Read `is_portfolio_member`, not this paragraph, if
they ever disagree again.

`require_project(...)` calls therefore still appear on portfolio-scoped routes
and are currently no-ops. They are kept so re-enabling the WHERE half is one
function, not an archaeology exercise across forty endpoints — but do not read
them as evidence that a check is happening.

`timeline`, `user_mgmt` and `client_mgmt` are declared global for a different
reason that still holds: their tables carry no portfolio column at all, so
there was never anything to be a member of, and they take no project_id.

`is_admin` stays the super-role: an admin implicitly holds every permission
and can always edit the grid. That is the break-glass the ADMIN_EMAILS floor
exists to protect (see auth/dependencies.py::_upsert_user_row) — a bad grant
can never leave the app with nobody able to fix it. The `user_mgmt` permission
gives the same console access WITHOUT making someone a full admin.

THE BACKEND IS THE BOUNDARY. Disabling a button in React is presentation; a
hand-crafted request must still be refused here. Every gate in this module runs
server-side and reads the DB row, never the token or a client-supplied flag.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Union

from fastapi import Depends, HTTPException, Request, status

from auth.dependencies import require_db_user


# ============================================================
# The vocabulary
# ============================================================
@dataclass(frozen=True)
class PermissionDef:
    """One column of the User Management grid.

    `name` is the wire/API identifier, `label` is the grid's column header, and
    `column` is the User model attribute — derived, not stored, so a new
    permission cannot drift between the two names.
    """
    name: str
    label: str
    scope: str  # "portfolio" | "global"

    @property
    def column(self) -> str:
        return f"can_{self.name}"

    @property
    def is_global(self) -> bool:
        return self.scope == "global"


# Names are also exported as constants so routers reference a symbol rather
# than a string literal — a typo then fails at import instead of silently
# gating nothing. Order matches the grid the user sketched.
MEETING_MINUTES = "meeting_minutes"
CO_CREATION = "co_creation"
CO_APPROVAL = "co_approval"
AGENDA = "agenda"
PROPOSALS = "proposals"
TIMELINE = "timeline"
USER_MGMT = "user_mgmt"
CLIENT_MGMT = "client_mgmt"

PERMISSIONS: tuple[PermissionDef, ...] = (
    PermissionDef(MEETING_MINUTES, "Meeting Minutes", "portfolio"),
    PermissionDef(CO_CREATION, "CO Creation", "portfolio"),
    PermissionDef(CO_APPROVAL, "CO Approval", "portfolio"),
    PermissionDef(AGENDA, "Agenda", "portfolio"),
    PermissionDef(PROPOSALS, "Proposals", "portfolio"),
    # THE TIMELINE IS COMPANY-WIDE. Not an oversight and not a stopgap: the
    # capacity board plans PEOPLE, and none of its five tables carries — or
    # could carry — a portfolio. Resources are engineers, time-off is somebody's
    # vacation, the client list is free text; only TimelineProject even points
    # at anything, and only sometimes (`source_proposal_id`, null for the
    # hand-built projects that make up most of the board). Adding a FK there
    # would portfolio-scope a third of the module and leave the rest global
    # anyway, i.e. a scope label that is still a lie for most of its routes.
    # So `timeline` is the WHAT with no WHERE: holding it lets you staff the
    # whole board, which is what a shared capacity plan means.
    PermissionDef(TIMELINE, "Timeline", "global"),
    # Console permissions. Global on purpose: managing people and clients is
    # not portfolio work, so there is no portfolio to be a member of.
    PermissionDef(USER_MGMT, "User Mgmt", "global"),
    PermissionDef(CLIENT_MGMT, "Client Mgmt", "global"),
)

PERMISSIONS_BY_NAME: dict[str, PermissionDef] = {p.name: p for p in PERMISSIONS}

PERMISSION_NAMES: tuple[str, ...] = tuple(p.name for p in PERMISSIONS)

# Defaults a brand-new row gets, mirrored from db.models.User. Kept here as
# well so the seed scripts and the admin console can answer "what would a new
# hire get?" without importing the ORM.
DEFAULT_GRANTS: dict[str, bool] = {
    MEETING_MINUTES: True,
    CO_CREATION: True,
    CO_APPROVAL: True,
    AGENDA: True,
    PROPOSALS: True,
    TIMELINE: True,
    USER_MGMT: False,
    CLIENT_MGMT: False,
}


_model_verified = False


def verify_permission_model() -> None:
    """Fail at boot if the vocabulary and the User model disagree.

    prestart.py builds a FRESH database with `create_all` and stamps head — it
    never replays migrations — so the model columns are the only thing a new
    deployment ever sees. A permission listed here with no matching column (or
    with a different default) would then behave one way on a migrated database
    and another on a fresh one, and nothing would say so until someone got an
    unexplained 403. Cheap assertion, run once when the first gated router is
    imported, so the container refuses to boot instead of drifting.
    """
    global _model_verified
    if _model_verified:
        return
    # Lazy import: auth/ deliberately stays free of model imports at module
    # load time so the import graph stays a DAG (auth -> db -> ... -> routers).
    from db.models import User as UserModel

    for perm in PERMISSIONS:
        column = getattr(UserModel, perm.column, None)
        if column is None:
            raise RuntimeError(
                f"Permission {perm.name!r} has no User.{perm.column} column. "
                "Add the column to db/models.py AND a migration; a fresh DB "
                "is built from the model, an existing one from the migration."
            )
        default = getattr(column.default, "arg", None)
        if bool(default) != DEFAULT_GRANTS[perm.name]:
            raise RuntimeError(
                f"User.{perm.column} defaults to {default!r} but "
                f"DEFAULT_GRANTS says {DEFAULT_GRANTS[perm.name]!r}. "
                "New users would land with the wrong access."
            )
    _model_verified = True


# ============================================================
# The predicates
# ============================================================
def has_permission(user, name: str) -> bool:
    """Does this user hold `name`? Admins implicitly hold everything.

    Portfolio-blind on purpose — this is the WHAT half. Callers that gate a
    portfolio write must also check membership; `require_permission` does both.
    """
    perm = PERMISSIONS_BY_NAME.get(name)
    if perm is None:
        raise ValueError(f"Unknown permission {name!r}")
    if user is None:
        return False
    if getattr(user, "is_admin", False):
        return True
    return bool(getattr(user, perm.column, False))


def effective_permissions(user) -> dict[str, bool]:
    """Every permission as the user actually experiences it — admin folded in.

    This is what /api/me and the grid should render. Handing the SPA the raw
    columns would make it reimplement the admin bypass, and a second copy of an
    authorization rule is a second place for it to be wrong.
    """
    return {p.name: has_permission(user, p.name) for p in PERMISSIONS}


def is_portfolio_member(db, user, project_id: int) -> bool:
    """The WHERE half — DELIBERATELY DISABLED. Every PM reaches every portfolio.

    Castillo's rule, handed down after this shipped: a PM has access to all
    portfolios, not only the ones they are assigned to. So permissions are
    company-wide. The eight grants still decide WHAT somebody may do; nothing
    decides WHERE, because the business does not want that line drawn.

    Kept as a function rather than deleted at the two call sites, so the WHERE
    half is one obvious switch if that rule is ever revisited — and so nobody
    reading `require_project(...)` in a route concludes a check is happening
    that is not.

    It is worth recording why this is also the safer shape. Scoping writes to
    `project_members` took production down the morning it shipped: that table
    had only ever filtered READS, the read path defaults to my_only=false, and
    so nothing had ever forced anyone to populate it — 42 imported portfolios,
    zero membership rows between them. Every non-admin could read everything
    and save nothing, and the one route that could have fixed it needed a
    permission the same migration had just set to FALSE. An authorization rule
    whose data nobody maintains is not a control, it is an outage waiting for a
    deploy.

    `ProjectMember` is untouched and still does its real jobs: the Mine/all
    filter, the dashboard scope toggle, and Manage Team. Assignment now means
    "this is my portfolio", not "this is the only portfolio I may write to".
    """
    return user is not None


# ============================================================
# The FastAPI dependency
# ============================================================
class PermissionGrant:
    """What a passed check hands back to the route.

    Carries the resolved user so a route doesn't need a second identity
    dependency, and `require_project` for the routes whose portfolio isn't in
    the URL — a change order's project_id, for instance, comes off the row the
    route just loaded, so the dependency cannot have checked it in advance.
    Forgetting that call still leaves the permission half enforced; it can only
    ever widen scope, never grant a permission the user doesn't hold.
    """

    def __init__(self, user, permission: PermissionDef, db, checked: bool):
        self.user = user
        self.permission = permission
        self._db = db
        # True when the dependency already resolved a portfolio for this
        # request, so a belt-and-braces second call is free rather than a
        # duplicate query.
        self.project_checked = checked

    @property
    def is_admin(self) -> bool:
        return bool(getattr(self.user, "is_admin", False))

    def require_project(self, project_id: Optional[int]) -> None:
        """403 unless the caller may write in this portfolio."""
        if project_id is None:
            # A portfolio write with no portfolio is a bug in the route, not a
            # user error — refusing is the safe direction.
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=_membership_detail(self.permission),
            )
        if not is_portfolio_member(self._db, self.user, project_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=_membership_detail(self.permission),
            )
        self.project_checked = True


def _missing_detail(perm: PermissionDef) -> str:
    """Refusal text that names the missing permission — "you cannot do that"
    with no reason is a support call."""
    return (
        f'Your account does not have the "{perm.label}" permission '
        f"({perm.name}), which is required to make this change. Ask an "
        "administrator to grant it in Settings -> Users."
    )


def _membership_detail(perm: PermissionDef) -> str:
    """Unreachable while `is_portfolio_member` is disabled, except through
    `require_project(None)` — a route that resolved no portfolio at all.

    So it deliberately no longer tells anyone they are "not assigned to this
    portfolio" and to ask an admin for access: portfolio assignment grants no
    access any more, so that advice would send someone to an administrator who
    could not help them and would leave both of them believing the permission
    model works differently than it does. What is left says the honest thing —
    the request could not be tied to a portfolio, which is a bug in the route,
    not something the caller can fix.
    """
    return (
        f'This request could not be tied to a portfolio, so the "{perm.label}" '
        f"({perm.name}) check could not be completed. That is a fault in the "
        "app rather than anything you did — please report it."
    )


def require_permission(
    name: str,
    project_id: Union[int, str, None] = None,
):
    """Build the FastAPI dependency that gates one module's writes.

    Usage::

        @router.post("/api/clients")
        def create_client(guard=Depends(require_permission(CLIENT_MGMT))):
            ...

        # portfolio in the path or query -> checked before the handler runs
        @router.post("/api/projects/{project_id}/meetings")
        def create(project_id: int,
                   guard=Depends(require_permission(MEETING_MINUTES))):
            ...

        # portfolio only known after loading the row
        @router.post("/api/change-orders/{co_id}/approve")
        def approve(co_id: int, db=Depends(get_db),
                    guard=Depends(require_permission(CO_APPROVAL))):
            co = db.get(ChangeOrder, co_id)
            guard.require_project(co.project_id)

    `project_id` selects where the portfolio comes from:
      * None (default) — look for a `project_id` path or query param and check
        it automatically; if the request has none, the route must call
        `guard.require_project(...)`.
      * str            — the name of the path/query param holding it, for
        routes that call it something else.
      * int            — a fixed portfolio (rare; mostly tests).

    Being a dependency is the point: the check runs before the handler body, so
    a route cannot fall through to the write by forgetting a line. The one case
    that can't work that way — a portfolio derived from a row the route hasn't
    loaded yet — degrades to `guard.require_project`, and even then the WHAT
    half is already enforced.
    """
    perm = PERMISSIONS_BY_NAME.get(name)
    if perm is None:
        raise ValueError(
            f"Unknown permission {name!r}. Known: {', '.join(PERMISSION_NAMES)}"
        )
    if perm.is_global and project_id is not None:
        raise ValueError(
            f"{perm.name!r} is globally scoped and takes no project_id: "
            "its tables carry no portfolio to be a member of."
        )
    # Router import time, i.e. app boot: cheap place to discover that the
    # vocabulary and the ORM have drifted apart.
    verify_permission_model()
    # Lazy so this module stays importable without the DB layer; by the time a
    # router calls require_permission(), core.deps is loaded.
    from core.deps import get_db

    def _dependency(
        request: Request,
        user=Depends(require_db_user),
        db=Depends(get_db),
    ) -> PermissionGrant:
        # require_db_user has already 401'd anonymous callers and 403'd
        # deactivated ones, so `user` here is a live account.
        if not has_permission(user, perm.name):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=_missing_detail(perm),
            )
        checked = False
        if not perm.is_global:
            resolved = _resolve_project_id(request, project_id)
            if resolved is not None:
                if not is_portfolio_member(db, user, resolved):
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail=_membership_detail(perm),
                    )
                checked = True
        return PermissionGrant(user, perm, db, checked)

    return _dependency


def _resolve_project_id(
    request: Request,
    source: Union[int, str, None],
) -> Optional[int]:
    """Pull the portfolio id out of the request, or None if it isn't there."""
    if isinstance(source, int):
        return source
    key = source if isinstance(source, str) else "project_id"
    raw = request.path_params.get(key)
    if raw is None:
        raw = request.query_params.get(key)
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        # A non-numeric project_id can't identify a portfolio; treat it as
        # absent so the route's own validation produces the 422, not us a 403.
        return None


# ============================================================
# Separation of duties: change orders
# ============================================================
# Splitting CO Creation from CO Approval only means something if one person
# can't do both. A change order is a priced document that goes to a client;
# self-approval makes the second column decorative.
CO_SELF_APPROVAL_DETAIL = (
    "You created this change order, so you cannot approve it. Approval needs a "
    "second pair of eyes: ask another CO Approval holder on this portfolio, "
    "or an administrator, to approve it."
)


def assert_change_order_approvable(
    db,
    *,
    project_id: Optional[int],
    creator_user_id: Optional[int],
    actor,
) -> None:
    """403 when the caller is trying to approve their own change order.

    The deadlock question, answered deliberately: refusing unconditionally can
    strand a change order nobody is able to approve, and an unapprovable
    document is a worse outcome than a weakened control — people work around it
    by emailing a spreadsheet, which is exactly what this app replaced. So the
    refusal is conditional on an alternative actually existing: we ask the
    database whether ANY other active user could approve this CO (an admin, or
    a CO Approval holder assigned to this portfolio). If one does, self-approval
    is refused and the message says who to go to. If literally nobody else can,
    the rule is unenforceable rather than violated — a control requiring two
    people cannot be applied where only one exists — so the approval proceeds.

    That condition is computed per-call, not a stored override, so it re-arms
    the moment a second approver appears: an admin ticking CO Approval for one
    colleague, or adding one member to the portfolio, restores the rule with no
    code change and no support ticket. And because ADMIN_EMAILS guarantees at
    least one permanent admin, the only shape that reaches the fallback is the
    sole admin writing their own CO in a one-person org.
    """
    if actor is None or creator_user_id is None:
        return
    if creator_user_id != getattr(actor, "id", None):
        return
    if _other_eligible_approver_exists(
        db, project_id=project_id, exclude_user_id=actor.id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=CO_SELF_APPROVAL_DETAIL,
        )


def _other_eligible_approver_exists(
    db,
    *,
    project_id: Optional[int],
    exclude_user_id: int,
) -> bool:
    """Is there anyone else who could approve a CO on this portfolio?

    Mirrors the real gate — active, and (admin OR holds co_approval) — so we
    never refuse a self-approval by pointing at a colleague who would
    themselves be refused.

    It used to also require a ProjectMember row, back when membership was half
    of the write check. That half is gone: is_portfolio_member is disabled and
    the enforced gate is now require_permission(CO_APPROVAL) plus a no-op
    require_project. Leaving the membership term in did not make the mirror
    stricter, it made it WRONG — project_members is empty in production, so
    every non-admin approver was filtered out of "is there anyone else?", the
    answer came back no, and the separation-of-duties refusal quietly stopped
    firing for a sole admin approving their own change order. A control that
    silently does not apply to the account that most needs it is worse than no
    control, because everyone believes it is running.
    """
    from sqlalchemy import or_

    from db.models import User as UserModel

    holds_co_approval = UserModel.can_co_approval.is_(True)
    row = (
        db.query(UserModel.id)
        .filter(
            UserModel.is_active.is_(True),
            UserModel.id != exclude_user_id,
            or_(UserModel.is_admin.is_(True), holds_co_approval),
        )
        .first()
    )
    return row is not None
