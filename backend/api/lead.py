"""/api/lead — admin/lead-only cross-portfolio oversight dashboard.

A single endpoint that rolls up the whole PMO for a team lead:
  - GET /api/lead/overview → org totals, per-portfolio health, per-PM workload.

Admin-gated (``actor.is_admin``). Non-admins get 403 — the regular Home /
Dashboard with the "All portfolios" toggle is what PMs use; this is the
lead's bird's-eye view. Everything is computed in a handful of bulk queries
(O(projects + members + actions + agendas)), fine well past 100 portfolios.
"""
from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import require_db_user
from core.deps import get_db
from db.models import Project, Meeting, Agenda, ActionItem, ProjectMember, User
from schemas.common import (
    LeadOverviewResponse, LeadTotals, LeadPortfolioRow, LeadPmRow,
)


router = APIRouter(prefix="/api/lead", tags=["lead"])


def _name_tokens(name: str) -> list[str]:
    """Lowercased match candidates for attributing a free-text action owner
    to a User — full name, first name, last name. Mirrors the same strategy
    /api/dashboard/mine uses so 'who owns this' agrees across the app."""
    n = (name or "").strip().lower()
    if not n:
        return []
    parts = n.split()
    out = [n]
    if parts:
        out.append(parts[0])
        if len(parts) > 1:
            out.append(parts[-1])
    return list(dict.fromkeys(out))  # dedupe, preserve order


@router.get("/overview", response_model=LeadOverviewResponse)
def lead_overview(
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
) -> LeadOverviewResponse:
    # Visible to every signed-in user (no admin gate) — the team wanted the
    # cross-portfolio view open to all PMs, not just leads.
    today = date.today()

    # ---- Projects + clients ----
    projects = db.query(Project).all()
    client_ids = {p.client_id for p in projects}

    # ---- Members → per-project count + per-user portfolio count ----
    members = db.query(ProjectMember).all()
    member_count_by_project: dict[int, int] = {}
    portfolios_by_user: dict[int, int] = {}
    for m in members:
        member_count_by_project[m.project_id] = (
            member_count_by_project.get(m.project_id, 0) + 1
        )
        portfolios_by_user[m.user_id] = portfolios_by_user.get(m.user_id, 0) + 1

    # ---- Users (for workload attribution) ----
    users = db.query(User).all()
    user_by_id = {u.id: u for u in users}
    user_tokens = {u.id: _name_tokens(u.name) for u in users}

    # ---- Open actions → per-project + per-user open/overdue ----
    open_actions = (
        db.query(ActionItem)
        .filter(ActionItem.status.in_(("open", "pending")))
        .all()
    )
    open_by_project: dict[int, int] = {}
    overdue_by_project: dict[int, int] = {}
    open_by_user: dict[int, int] = {}
    overdue_by_user: dict[int, int] = {}
    total_overdue = 0
    unassigned_open = 0
    for a in open_actions:
        is_overdue = bool(a.due_date and a.due_date < today)
        open_by_project[a.project_id] = open_by_project.get(a.project_id, 0) + 1
        if is_overdue:
            total_overdue += 1
            overdue_by_project[a.project_id] = (
                overdue_by_project.get(a.project_id, 0) + 1
            )
        # Attribute to user(s): canonical owner_user_id first, else name match.
        assigned: set[int] = set()
        if a.owner_user_id and a.owner_user_id in user_by_id:
            assigned.add(a.owner_user_id)
        else:
            owner_lower = (a.owner or "").lower()
            if owner_lower:
                for uid, toks in user_tokens.items():
                    if toks and any(t in owner_lower for t in toks):
                        assigned.add(uid)
        if not assigned:
            unassigned_open += 1
        for uid in assigned:
            open_by_user[uid] = open_by_user.get(uid, 0) + 1
            if is_overdue:
                overdue_by_user[uid] = overdue_by_user.get(uid, 0) + 1

    # ---- Last meeting date per project ----
    last_meeting_by_project: dict[int, date] = {}
    for pid, mdate in db.query(Meeting.project_id, Meeting.meeting_date).all():
        if mdate is None:
            continue
        cur = last_meeting_by_project.get(pid)
        if cur is None or mdate > cur:
            last_meeting_by_project[pid] = mdate

    # ---- Open risks from the most-recent agenda per project ----
    latest_agenda: dict[int, Agenda] = {}
    for ag in (
        db.query(Agenda)
        .order_by(Agenda.upcoming_date.desc(), Agenda.updated_at.desc())
        .all()
    ):
        if ag.project_id not in latest_agenda:
            latest_agenda[ag.project_id] = ag
    risk_count_by_project: dict[int, int] = {}
    for pid, ag in latest_agenda.items():
        risks = ag.risks_json or []
        if isinstance(risks, list):
            risk_count_by_project[pid] = sum(
                1 for r in risks
                if isinstance(r, dict) and (r.get("description") or "").strip()
            )
    total_open_risks = sum(risk_count_by_project.values())

    # ---- Per-portfolio rows ----
    portfolio_rows = [
        LeadPortfolioRow(
            project_id=p.id,
            name=p.name,
            client_name=(p.client.name if p.client else None),
            schedule_version=p.schedule_version,
            member_count=member_count_by_project.get(p.id, 0),
            open_actions=open_by_project.get(p.id, 0),
            overdue_actions=overdue_by_project.get(p.id, 0),
            open_risks=risk_count_by_project.get(p.id, 0),
            last_meeting_date=last_meeting_by_project.get(p.id),
        )
        for p in projects
    ]
    # Most overdue first, then most open, then alphabetical.
    portfolio_rows.sort(
        key=lambda r: (-r.overdue_actions, -r.open_actions, r.name.lower())
    )

    # ---- Per-PM rows (anyone who is a member or carries assigned work) ----
    pm_rows = []
    for uid in set(portfolios_by_user) | set(open_by_user):
        u = user_by_id.get(uid)
        if u is None:
            continue
        pm_rows.append(LeadPmRow(
            user_id=uid,
            name=u.name or u.email or f"User {uid}",
            email=u.email or "",
            is_admin=bool(u.is_admin),
            portfolios=portfolios_by_user.get(uid, 0),
            open_actions=open_by_user.get(uid, 0),
            overdue_actions=overdue_by_user.get(uid, 0),
        ))
    pm_rows.sort(
        key=lambda r: (-r.overdue_actions, -r.open_actions, r.name.lower())
    )

    totals = LeadTotals(
        portfolios=len(projects),
        clients=len(client_ids),
        pms=sum(1 for r in pm_rows if r.portfolios > 0),
        open_actions=len(open_actions),
        overdue_actions=total_overdue,
        open_risks=total_open_risks,
        unassigned_open_actions=unassigned_open,
    )

    return LeadOverviewResponse(
        totals=totals,
        portfolios=portfolio_rows,
        pms=pm_rows,
    )
