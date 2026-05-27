"""/api/dashboard — home page rollup (overdue actions, follow-ups, agendas).

Endpoints:
  - GET /api/dashboard           → cross-portfolio "everyone's stuff" view
  - GET /api/dashboard/mine      → only the signed-in user's stuff. Same shape
                                    so the frontend can render one component
                                    in two contexts.
  - GET /api/dashboard/briefing  → AI-written personalized "since you were
                                    last here..." card for the top of Home.
  - GET /api/dashboard/risks     → open risks aggregated from the most-recent
                                    agenda of every portfolio the user can
                                    see. Sorted by likelihood (Critical → Low)
                                    then by portfolio name.
"""
import logging
from datetime import date, datetime, timedelta
from fastapi import APIRouter, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import require_db_user
from db.models import ActionItem, Meeting, Agenda, Note, Project
from db.repository import (
    all_open_actions_across_portfolios, all_notes_with_follow_up,
    all_upcoming_agendas, list_my_project_ids,
)
from llm.providers import get_provider
from schemas.common import (
    DashboardResponse, DashboardActionOut, DashboardNoteOut, DashboardAgendaOut,
    BriefingResponse, DashboardRisksResponse, DashboardRiskOut,
)


logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _project_label(project):
    if project is None:
        return None, None
    client_name = project.client.name if project.client else None
    return project.name, client_name


@router.get("", response_model=DashboardResponse)
def get_dashboard(db: Session = Depends(get_db)):
    actions = []
    for a in all_open_actions_across_portfolios(db):
        proj_name, client_name = _project_label(getattr(a, "originating_meeting", None) and a.originating_meeting.project)
        actions.append(DashboardActionOut(
            id=a.id, project_id=a.project_id, text=a.text, owner=a.owner,
            due_date=a.due_date, status=a.status,
            project_name=proj_name, client_name=client_name,
        ))

    notes = []
    for n in all_notes_with_follow_up(db):
        proj_name, client_name = _project_label(n.project)
        notes.append(DashboardNoteOut(
            id=n.id, project_id=n.project_id, topic=n.topic,
            action_needed=n.action_needed, follow_up_date=n.follow_up_date,
            priority=n.priority,
            project_name=proj_name, client_name=client_name,
        ))

    agendas = []
    for a in all_upcoming_agendas(db, date.today()):
        proj_name, client_name = _project_label(a.project)
        agendas.append(DashboardAgendaOut(
            id=a.id, project_id=a.project_id, upcoming_date=a.upcoming_date,
            title=a.title,
            project_name=proj_name, client_name=client_name,
        ))

    return DashboardResponse(
        open_actions=actions,
        follow_up_notes=notes,
        upcoming_agendas=agendas,
    )


# ============================================================
# Personalized: just the signed-in user's stuff
# ============================================================
@router.get("/mine", response_model=DashboardResponse)
def get_my_dashboard(
    db: Session = Depends(get_db),
    actor = Depends(require_db_user),
):
    """Subset of the dashboard filtered to things the signed-in user owns
    or created. Three buckets:
      - Open actions where the user is in the comma-separated `owner` field
        (case-insensitive substring match on their display name) OR where
        they're the creator.
      - Follow-up notes they authored.
      - Agendas they authored that are still upcoming.

    The owner-by-name match is a stopgap until ActionItem grows a real
    `assignee_user_ids` column — see the deferred enhancement in Option B.
    """
    name = (actor.name or "").strip().lower()
    name_substr_targets: list[str] = []
    if name:
        # Match on both full name and just first name so 'Roashaael Mary John'
        # also matches an owner string of just 'Roashaael'.
        parts = name.split()
        name_substr_targets.append(name)
        if parts:
            name_substr_targets.append(parts[0])
            if len(parts) > 1:
                name_substr_targets.append(parts[-1])

    # ---- Open actions ----
    actions = []
    for a in all_open_actions_across_portfolios(db):
        owner_lower = (a.owner or "").lower()
        owns = any(t in owner_lower for t in name_substr_targets) if name_substr_targets else False
        authored = a.created_by_id == actor.id
        if not (owns or authored):
            continue
        proj_name, client_name = _project_label(
            getattr(a, "originating_meeting", None) and a.originating_meeting.project
        )
        actions.append(DashboardActionOut(
            id=a.id, project_id=a.project_id, text=a.text, owner=a.owner,
            due_date=a.due_date, status=a.status,
            project_name=proj_name, client_name=client_name,
        ))

    # ---- Follow-up notes I created ----
    notes = []
    for n in all_notes_with_follow_up(db):
        if n.created_by_id != actor.id:
            continue
        proj_name, client_name = _project_label(n.project)
        notes.append(DashboardNoteOut(
            id=n.id, project_id=n.project_id, topic=n.topic,
            action_needed=n.action_needed, follow_up_date=n.follow_up_date,
            priority=n.priority,
            project_name=proj_name, client_name=client_name,
        ))

    # ---- Upcoming agendas I authored ----
    agendas = []
    for a in all_upcoming_agendas(db, date.today()):
        if a.created_by_id != actor.id:
            continue
        proj_name, client_name = _project_label(a.project)
        agendas.append(DashboardAgendaOut(
            id=a.id, project_id=a.project_id, upcoming_date=a.upcoming_date,
            title=a.title,
            project_name=proj_name, client_name=client_name,
        ))

    return DashboardResponse(
        open_actions=actions,
        follow_up_notes=notes,
        upcoming_agendas=agendas,
    )


# ============================================================
# AI Home briefing — "since you were last here..."
# ============================================================
def _name_targets(actor) -> list[str]:
    """Same substring-match strategy as /api/dashboard/mine so we agree on
    'who owns this action' across both endpoints. Returns lowercased
    candidates to test against ``action.owner``."""
    name = (actor.name or "").strip().lower()
    if not name:
        return []
    parts = name.split()
    out = [name]
    if parts:
        out.append(parts[0])
        if len(parts) > 1:
            out.append(parts[-1])
    return out


def _fallback_briefing(first_name: str, facts: dict) -> str:
    """Deterministic prose used when the LLM call fails — never let the
    endpoint return a 502 just because OpenAI is having a moment."""
    if not any(facts.get(k, 0) for k in (
        "new_actions", "overdue_actions", "new_meetings_touched",
        "new_agendas_touched", "new_follow_up_notes",
    )):
        return "All clear — nothing requires your attention since you were last here."
    greet = "You're back" if not first_name else f"Welcome back, {first_name}"
    days = facts.get("days_since_last_seen")
    when = f" {days} days later" if days and days > 0 else ""
    bits = []
    if facts.get("overdue_actions", 0):
        bits.append(f"{facts['overdue_actions']} overdue action(s) need your attention")
    if facts.get("new_actions", 0):
        bits.append(f"{facts['new_actions']} new action(s) landed on your plate")
    if facts.get("new_meetings_touched", 0):
        bits.append(f"{facts['new_meetings_touched']} meeting(s) were touched")
    if facts.get("new_follow_up_notes", 0):
        bits.append(f"{facts['new_follow_up_notes']} follow-up note(s) are coming due")
    if facts.get("new_agendas_touched", 0):
        bits.append(f"{facts['new_agendas_touched']} agenda(s) saw activity")
    tail = (" Since then, " + "; ".join(bits) + ".") if bits else ""
    return f"{greet}{when}.{tail}"


@router.get("/briefing", response_model=BriefingResponse)
def get_home_briefing(
    db: Session = Depends(get_db),
    actor = Depends(require_db_user),
):
    """Personalized "since you were last here..." briefing for the Home page.

    Workflow:
      1. Read ``actor.previous_last_seen_at`` as the cutoff. The auth
         dependency already bumped ``last_seen_at`` to now() and parked the
         old value in ``previous_last_seen_at``, so we get a stable "what's
         changed since the user actually left" cutoff.
      2. Count five buckets against that cutoff: new actions assigned to me,
         overdue actions assigned to me (status-based, not time-of-creation),
         meetings touched, agendas touched, follow-up notes coming due.
      3. Hand the numeric facts to the LLM, which writes 2-3 sentences of
         prose. On LLM failure, fall back to a deterministic template so the
         endpoint never 502s.
    """
    # First-ever sign-in for this user has no previous_last_seen_at — fall
    # back to last_seen_at minus 7 days so the first card has something to
    # surface (PMs typically come back to their own backlog, not a fresh
    # account). After the second visit we'll have a real cutoff.
    cutoff = actor.previous_last_seen_at or (
        (actor.last_seen_at or datetime.utcnow()) - timedelta(days=7)
    )

    today = date.today()
    targets = _name_targets(actor)

    # ---- New actions assigned to me ----
    new_actions = 0
    if targets:
        for a in (
            db.query(ActionItem)
            .filter(ActionItem.created_at >= cutoff)
            .all()
        ):
            owner = (a.owner or "").lower()
            if any(t in owner for t in targets):
                new_actions += 1

    # ---- Overdue actions assigned to me (open/pending + due_date < today) ----
    overdue_actions = 0
    if targets:
        for a in (
            db.query(ActionItem)
            .filter(ActionItem.status.in_(("open", "pending")))
            .filter(ActionItem.due_date.isnot(None))
            .filter(ActionItem.due_date < today)
            .all()
        ):
            owner = (a.owner or "").lower()
            if any(t in owner for t in targets):
                overdue_actions += 1

    # ---- New meetings touched (any project) ----
    new_meetings_touched = (
        db.query(Meeting)
        .filter(or_(Meeting.created_at >= cutoff, Meeting.updated_at >= cutoff))
        .count()
    )

    # ---- New agendas touched ----
    new_agendas_touched = (
        db.query(Agenda)
        .filter(or_(Agenda.created_at >= cutoff, Agenda.updated_at >= cutoff))
        .count()
    )

    # ---- Follow-up notes coming due ("past, today, +7d" assigned to me).
    # We assume "assigned to me" = "I created it" (Note has no owner column).
    window_end = today + timedelta(days=7)
    new_follow_up_notes = (
        db.query(Note)
        .filter(Note.created_by_id == actor.id)
        .filter(Note.status == "open")
        .filter(Note.follow_up_date.isnot(None))
        .filter(Note.follow_up_date <= window_end)
        .count()
    )

    # ---- Days since last seen (for the prose) ----
    days_since = None
    if actor.previous_last_seen_at:
        days_since = (datetime.utcnow() - actor.previous_last_seen_at).days
        if days_since < 0:
            days_since = 0

    facts = {
        "new_actions": new_actions,
        "overdue_actions": overdue_actions,
        "new_meetings_touched": new_meetings_touched,
        "new_agendas_touched": new_agendas_touched,
        "new_follow_up_notes": new_follow_up_notes,
        "days_since_last_seen": days_since,
    }

    # ---- LLM prose (with fallback) ----
    first_name = ((actor.name or "").strip().split() or [""])[0]
    try:
        prose = get_provider().briefing_for_user(actor.name or "", facts)
    except Exception as exc:  # noqa: BLE001 — endpoint MUST NOT 502 on this
        logger.warning("briefing_for_user failed, using fallback: %s", exc)
        prose = _fallback_briefing(first_name, facts)

    if not prose:
        prose = _fallback_briefing(first_name, facts)

    return BriefingResponse(
        last_seen_at=actor.previous_last_seen_at,
        new_actions_assigned_to_me=new_actions,
        overdue_actions_assigned_to_me=overdue_actions,
        new_meetings_touched=new_meetings_touched,
        new_agendas_touched=new_agendas_touched,
        new_follow_up_notes=new_follow_up_notes,
        briefing=prose,
    )


# ============================================================
# Open risks rollup — Home card
# ============================================================
# Likelihood -> sort weight. Critical first, blank/unknown last.
_LIKELIHOOD_WEIGHT = {
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 3,
}


@router.get("/risks", response_model=DashboardRisksResponse)
def get_open_risks(
    scope: str = "all",
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    """Open risks aggregated from the most-recent agenda of every portfolio
    the signed-in user can see.

    Scope semantics mirror the Mine/All toggle on Home:
      - ``scope="mine"`` AND non-admin → only portfolios the user is a
        member of.
      - ``scope="all"`` OR admin → every portfolio.

    Risks come from ``Agenda.risks_json`` — a JSON list of
    ``{description, impact, likelihood, mitigation, owner}`` objects.
    There's no dedicated Risk table because PMs treat risks as agenda
    line items, not first-class entities. This rollup walks the latest
    agenda per portfolio and flattens the JSON; it's O(portfolios), so
    fast enough even at 100+ portfolios.

    Sorted by likelihood (Critical → Low → blank), then by client/portfolio
    name so risks for the same project cluster together.
    """
    # ---- Scope ----
    if actor.is_admin or scope == "all":
        project_ids: set[int] | None = None  # no filter
    else:
        project_ids = set(list_my_project_ids(db, actor.id))
        if not project_ids:
            return DashboardRisksResponse(risks=[])

    # ---- Pick the most-recent agenda per project ----
    # We use `upcoming_date DESC, updated_at DESC` as the "most recent"
    # ordering — matches the per-portfolio dashboard's behaviour.
    q = db.query(Agenda).order_by(Agenda.upcoming_date.desc(), Agenda.updated_at.desc())
    if project_ids is not None:
        q = q.filter(Agenda.project_id.in_(project_ids))
    latest_per_project: dict[int, Agenda] = {}
    for ag in q.all():
        if ag.project_id in latest_per_project:
            continue
        latest_per_project[ag.project_id] = ag

    # Project lookup for client name + display
    if latest_per_project:
        projects = {
            p.id: p
            for p in db.query(Project)
            .filter(Project.id.in_(latest_per_project.keys()))
            .all()
        }
    else:
        projects = {}

    # ---- Flatten ----
    rows: list[DashboardRiskOut] = []
    for project_id, agenda in latest_per_project.items():
        project = projects.get(project_id)
        if project is None:
            continue
        client_name = project.client.name if project.client else None
        risks = agenda.risks_json or []
        if not isinstance(risks, list):
            continue
        for r in risks:
            if not isinstance(r, dict):
                continue
            description = (r.get("description") or "").strip()
            # Drop blank rows — the inline editor leaves an empty trailing
            # row when PMs delete entries.
            if not description:
                continue
            rows.append(DashboardRiskOut(
                project_id=project_id,
                project_name=project.name,
                client_name=client_name,
                agenda_id=agenda.id,
                upcoming_date=agenda.upcoming_date,
                description=description,
                impact=(r.get("impact") or "").strip() or None,
                likelihood=(r.get("likelihood") or "").strip() or None,
                mitigation=(r.get("mitigation") or "").strip() or None,
                owner=(r.get("owner") or "").strip() or None,
            ))

    # ---- Sort ----
    rows.sort(key=lambda r: (
        _LIKELIHOOD_WEIGHT.get((r.likelihood or "").lower(), 99),
        (r.client_name or "").lower(),
        r.project_name.lower(),
    ))

    return DashboardRisksResponse(risks=rows)
