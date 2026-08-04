"""/api/projects — projects (portfolios) under a client.

Write gating here is deliberately NOT one column, because the three mutations
have wildly different blast radii and the user has already ruled on the same
shape one tier up (see clients.py): create and rename stay open to any PM, only
destroy is gated.

    POST   create  — ungated. Additive, and the creator is auto-added as a
                     member, so this is how a PM gets a workspace at all.
    PATCH  edit    — `meeting_minutes` + membership. Renaming or re-scoping a
                     portfolio is ordinary work for the people who work in it,
                     and nobody else's business.
    DELETE         — `client_mgmt`, global, default FALSE. Mirrors
                     DELETE /api/clients: it cascades everything underneath.
"""
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import get_current_db_user, require_db_user
from auth.permissions import CLIENT_MGMT, MEETING_MINUTES, require_permission
from db.models import (
    Project, Client, Meeting, ActionItem, Deliverable, Agenda,
    Schedule, Proposal, ProposalVersion, PortfolioProject,
)
from db.repository import (
    list_projects, get_project, set_portfolio_sub_projects, list_deliverables,
    list_my_project_ids, add_project_member,
)
from schemas.common import (
    ProjectOut, ProjectCreate, ProjectUpdate, DeliverableOut,
    PortfolioMetricsOut, BurndownPoint,
)

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectOut])
def get_projects(
    client_id: Optional[int] = Query(
        None,
        description=(
            "Parent client id. When omitted, returns every portfolio across "
            "all clients — used by the calendar card's manual-override picker "
            "so PMs can pin an event to any portfolio without first navigating "
            "to its client."
        ),
    ),
    my_only: bool = Query(
        False,
        description=(
            "When true AND the user is signed in AND not an admin, return "
            "only projects the user is a member of. Anonymous + admin users "
            "see everything regardless."
        ),
    ),
    db: Session = Depends(get_db),
    actor = Depends(get_current_db_user),
):
    if client_id is not None:
        rows = list_projects(db, client_id)
    else:
        rows = db.query(Project).order_by(Project.name).all()
    if my_only and actor is not None and not actor.is_admin:
        allowed_ids = set(list_my_project_ids(db, actor.id))
        rows = [p for p in rows if p.id in allowed_ids]
    return rows


@router.get("/{project_id}", response_model=ProjectOut)
def get_one(project_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    project = get_project(db, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return project


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    actor = Depends(require_db_user),
):
    """Any signed-in PM, deliberately ungated — the same reasoning as
    create_client: a PM who cannot stand up the portfolio they just won is
    blocked on someone else for the most ordinary task there is. It destroys
    nothing and an admin can delete a mistake.

    Identity is REQUIRED here (it used to be optional). An anonymous create
    skipped the membership row below, leaving a portfolio nobody owned and only
    an admin could see — a create that silently half-fails is worse than a 401.
    """
    client = db.get(Client, payload.client_id)
    if not client:
        raise HTTPException(404, "Parent client not found")
    project = Project(
        client_id=payload.client_id,
        name=payload.name,
        scope=payload.scope,
        location=payload.location,
        state=payload.state,
        size_mw=payload.size_mw,
        schedule_version=payload.schedule_version or "V1",
        sub_projects_json=payload.sub_projects_json or [],
    )
    db.add(project)
    db.flush()
    # Auto-assign the creator as a member so the portfolio shows up on
    # their dashboard immediately. Admins still get auto-added — they'd
    # see it via the admin bypass anyway, but the explicit row makes the
    # Manage Team UI list them as the original owner.
    add_project_member(
        db, project_id=project.id, user_id=actor.id,
        created_by_id=actor.id,
    )
    return project


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: int, payload: ProjectUpdate, db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    """Requires Meeting Minutes on THIS portfolio (the dependency resolves
    `project_id` straight off the path, so membership is checked before the
    body runs).

    Two things were wrong before: any signed-in user could rename any
    portfolio, including one under a client they have nothing to do with, and
    portfolio names go out on client-facing minutes. `client_mgmt` would have
    been the wrong fix — it defaults FALSE, and this same endpoint is what the
    Notes page calls to edit `sub_projects_json`, so it would have broken
    sub-projects for every PM on day one. `meeting_minutes` defaults TRUE, is
    what already gates the notes and minutes this metadata appears on, and
    carries the membership check that closes the cross-portfolio hole.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if payload.name is not None:
        project.name = payload.name
    if payload.scope is not None:
        project.scope = payload.scope
    if payload.location is not None:
        project.location = payload.location
    if payload.state is not None:
        project.state = payload.state
    if payload.size_mw is not None:
        project.size_mw = payload.size_mw
    if payload.schedule_version is not None:
        project.schedule_version = payload.schedule_version
    if payload.sub_projects_json is not None:
        set_portfolio_sub_projects(db, project_id, payload.sub_projects_json)
    db.flush()
    return project


@router.delete("/{project_id}", status_code=204)
def delete_project(
    project_id: int, db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(CLIENT_MGMT)),
):
    """Requires the Client Management permission — the same gate as
    DELETE /api/clients, one tier down, and for the same reason: this cascades
    through the portfolio into every meeting, agenda, action, attachment,
    schedule and Project-tier row beneath it. It was reachable by any signed-in
    user, member or not, which is how a zero-permission non-member could
    destroy a portfolio they had never been given access to.

    Membership was considered as the gate and rejected: `meeting_minutes`
    defaults TRUE, so scoping this to "member with minutes" would still leave
    every PM able to delete a portfolio they were added to merely to take
    notes. An irreversible cascade wants a permission somebody had to be
    *given*, and `client_mgmt` is the one that defaults FALSE.

    Global scope, no portfolio: like a client, the thing being destroyed IS the
    membership boundary, so there is no membership inside it that could stand
    for "may destroy this". Admins hold it implicitly.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    # Proposals are NOT cascade-children of a portfolio — they live on their own.
    # Before the project (and its cascade-deleted schedules) goes away, null any
    # proposal pointers into it so a standalone proposal survives intact and no
    # dangling FK (proposals/proposal_versions.linked_schedule_id → schedules.id)
    # is left behind.
    sched_ids = select(Schedule.id).where(Schedule.project_id == project_id)
    db.query(ProposalVersion).filter(
        ProposalVersion.linked_schedule_id.in_(sched_ids)
    ).update({ProposalVersion.linked_schedule_id: None}, synchronize_session=False)
    db.query(Proposal).filter(
        Proposal.linked_schedule_id.in_(sched_ids)
    ).update({Proposal.linked_schedule_id: None}, synchronize_session=False)
    db.query(Proposal).filter(Proposal.portfolio_id == project_id).update(
        {Proposal.portfolio_id: None}, synchronize_session=False)
    # Project-tier rows (sites) belong to this portfolio. Null any proposal
    # pointers into them so those proposals survive standalone, then drop the
    # project rows (their FK to projects.id would otherwise block the delete).
    # is_active_for_project clears alongside project_id: the partial unique index
    # only covers project_id IS NOT NULL, so a stale True survives unnoticed and
    # would re-activate the proposal the next time it is linked somewhere.
    pp_ids = select(PortfolioProject.id).where(
        PortfolioProject.portfolio_id == project_id)
    db.query(Proposal).filter(Proposal.project_id.in_(pp_ids)).update(
        {Proposal.project_id: None, Proposal.is_active_for_project: False},
        synchronize_session=False)
    db.query(PortfolioProject).filter(
        PortfolioProject.portfolio_id == project_id
    ).delete(synchronize_session=False)
    db.delete(project)
    return None


@router.get("/{project_id}/deliverables", response_model=list[DeliverableOut])
def get_project_deliverables(project_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """All Deliverable rows for a project (used by Notes to auto-discover
    sub-project names from `project_segment`)."""
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return list_deliverables(db, project_id)


# ============================================================
# Per-portfolio health metrics (PortfolioDashboard page)
# ============================================================
# Status buckets — repeated below so the SQL filters read clearly.
_OPEN_STATUSES = ("open", "pending")
_DONE_STATUSES = ("completed", "cancelled")
_LIKELIHOOD_KEYS = ("Low", "Medium", "High", "Critical")


def _iso_week_window(d: date) -> tuple[date, date]:
    """Return (week_start_monday, week_end_sunday) for the ISO week of `d`."""
    monday = d - timedelta(days=d.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday


@router.get("/{project_id}/metrics", response_model=PortfolioMetricsOut)
def get_project_metrics(
    project_id: int = Path(..., ge=1, description="Portfolio (project) id"),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Roll up health metrics for a single portfolio.

    Backs the PortfolioDashboard page — top-row counts, 8-week burndown, and
    the latest-agenda risk heatmap. The endpoint is intentionally chunky
    (~6 queries) so the frontend only round-trips once.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    today = date.today()

    # ---- Meetings ----
    meetings = (
        db.query(Meeting)
        .filter_by(project_id=project_id)
        .order_by(desc(Meeting.meeting_date))
        .all()
    )
    total_meetings = len(meetings)
    last_meeting_date = meetings[0].meeting_date if meetings else None
    days_since_last = (
        (today - last_meeting_date).days if last_meeting_date else None
    )

    # ---- Actions ----
    actions = (
        db.query(ActionItem)
        .filter_by(project_id=project_id)
        .all()
    )
    total_actions = len(actions)
    open_count = sum(1 for a in actions if a.status in _OPEN_STATUSES)
    completed_count = sum(1 for a in actions if a.status == "completed")
    cancelled_count = sum(1 for a in actions if a.status == "cancelled")
    overdue_count = sum(
        1 for a in actions
        if a.status in _OPEN_STATUSES
        and a.due_date is not None
        and a.due_date < today
    )
    # close_rate over the project's lifetime: completed / total. Cancelled
    # counts as "not closed cleanly" so it lives in the denominator only.
    close_rate = (completed_count / total_actions) if total_actions else 0.0
    avg_per_meeting = (
        (total_actions / total_meetings) if total_meetings else 0.0
    )

    # ---- Deliverables ----
    deliverables = (
        db.query(Deliverable)
        .filter_by(project_id=project_id)
        .all()
    )
    deliverables_total = len(deliverables)
    # "On time" proxy until we wire actual completion dates: count anything
    # whose delivery_date hasn't slipped past today (or has no date at all).
    deliverables_on_time = sum(
        1 for d in deliverables
        if d.delivery_date is None or d.delivery_date >= today
    )
    on_time_rate = (
        (deliverables_on_time / deliverables_total)
        if deliverables_total else 0.0
    )

    # ---- 8-week burndown ----
    # Anchor on the Monday of this week, walk back 7 more weeks (8 total).
    current_monday, _ = _iso_week_window(today)
    burndown: list[BurndownPoint] = []
    for i in range(7, -1, -1):
        week_start = current_monday - timedelta(weeks=i)
        week_end = week_start + timedelta(days=6)
        # Make week_end a datetime end-of-day so created_at/last_status_change
        # comparisons include events that happened that Sunday.
        week_end_dt = datetime.combine(week_end, datetime.max.time())
        week_start_dt = datetime.combine(week_start, datetime.min.time())

        open_at_end = 0
        completed_this_week = 0
        for a in actions:
            created = a.created_at
            if created is None or created > week_end_dt:
                continue
            last_change = a.last_status_change or a.updated_at or created
            is_done_now = a.status in _DONE_STATUSES
            # Open at end-of-week if it wasn't yet done, OR it was done but
            # the status change happened after this week ended.
            if not is_done_now or (last_change > week_end_dt):
                open_at_end += 1
            if (
                a.status == "completed"
                and last_change is not None
                and week_start_dt <= last_change <= week_end_dt
            ):
                completed_this_week += 1

        burndown.append(BurndownPoint(
            week_start=week_start,
            open_at_end_of_week=open_at_end,
            completed_this_week=completed_this_week,
        ))

    # ---- Risk heatmap — most recent agenda's risks_json ----
    latest_agenda = (
        db.query(Agenda)
        .filter_by(project_id=project_id)
        .order_by(desc(Agenda.upcoming_date), desc(Agenda.updated_at))
        .first()
    )
    risks_by_likelihood: dict[str, int] = {k: 0 for k in _LIKELIHOOD_KEYS}
    if latest_agenda and isinstance(latest_agenda.risks_json, list):
        for r in latest_agenda.risks_json:
            if not isinstance(r, dict):
                continue
            raw = (r.get("likelihood") or "").strip()
            # Normalise casing so "high" / "HIGH" both bucket as "High".
            for key in _LIKELIHOOD_KEYS:
                if raw.lower() == key.lower():
                    risks_by_likelihood[key] += 1
                    break

    client_name = project.client.name if project.client else None
    return PortfolioMetricsOut(
        project_id=project.id,
        project_name=project.name,
        client_name=client_name,
        total_meetings=total_meetings,
        total_actions=total_actions,
        open_actions=open_count,
        overdue_actions=overdue_count,
        completed_actions=completed_count,
        cancelled_actions=cancelled_count,
        action_close_rate=close_rate,
        avg_actions_per_meeting=avg_per_meeting,
        deliverables_total=deliverables_total,
        deliverables_on_time=deliverables_on_time,
        on_time_rate=on_time_rate,
        last_meeting_date=last_meeting_date,
        days_since_last_meeting=days_since_last,
        burndown=burndown,
        risks_by_likelihood=risks_by_likelihood,
    )
