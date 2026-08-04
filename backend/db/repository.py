"""
Query helpers. Thin wrappers around session + models to keep the UI layer
free of ORM details.
"""
from datetime import date
from typing import Optional
from sqlalchemy.orm import Session
from sqlalchemy import desc
from sqlalchemy.exc import IntegrityError

from db.models import (
    Client, Project, ProjectAttendee, Meeting, MeetingAttendee,
    AgendaItem, DiscussionPoint, Deliverable, MeetingDeliverable,
    ActionItem, GeneratedDocument, Agenda, Note, ProjectMember, User,
)


# ============================================================
# Clients / Projects
# ============================================================
def list_clients(session: Session) -> list[Client]:
    return session.query(Client).order_by(Client.name).all()


def list_projects(session: Session, client_id: int) -> list[Project]:
    return session.query(Project).filter_by(client_id=client_id).order_by(Project.name).all()


def get_project(session: Session, project_id: int) -> Optional[Project]:
    return session.get(Project, project_id)


# ============================================================
# Project membership
# ============================================================
def list_project_member_ids(session: Session, project_id: int) -> list[int]:
    """User IDs assigned to this portfolio. Cheap — used in access checks."""
    rows = session.query(ProjectMember.user_id).filter_by(project_id=project_id).all()
    return [r[0] for r in rows]


def list_project_members(session: Session, project_id: int) -> list[ProjectMember]:
    """ProjectMember rows for a portfolio, joined to User so callers can
    render display names without a second query."""
    return (
        session.query(ProjectMember)
        .filter_by(project_id=project_id)
        .order_by(ProjectMember.created_at)
        .all()
    )


def list_my_project_ids(session: Session, user_id: int) -> list[int]:
    """Project IDs the given user is assigned to."""
    rows = session.query(ProjectMember.project_id).filter_by(user_id=user_id).all()
    return [r[0] for r in rows]


def add_project_member(
    session: Session,
    project_id: int,
    user_id: int,
    created_by_id: Optional[int] = None,
) -> ProjectMember:
    """Idempotent add — returns the existing row if (project, user) is
    already assigned. Caller commits via session_scope."""
    existing = (
        session.query(ProjectMember)
        .filter_by(project_id=project_id, user_id=user_id)
        .first()
    )
    if existing:
        return existing
    row = ProjectMember(
        project_id=project_id, user_id=user_id, created_by_id=created_by_id,
    )
    try:
        # Savepoint, so a refusal here does not poison the caller's transaction
        # — the bulk route assigns many pairs in one go and must survive one of
        # them losing a race.
        with session.begin_nested():
            session.add(row)
            session.flush()
    except IntegrityError:
        # The read above is not atomic. A concurrent assignment of the same
        # pair can land between it and the insert, and until
        # uq_project_members_project_user existed that produced a silent
        # duplicate row. Now the database refuses it, and this turns the
        # refusal back into the idempotent answer the caller asked for:
        # whoever won the race, the pair is assigned.
        return (
            session.query(ProjectMember)
            .filter_by(project_id=project_id, user_id=user_id)
            .one()
        )
    return row


def remove_project_member(session: Session, member_id: int) -> None:
    row = session.get(ProjectMember, member_id)
    if row is not None:
        session.delete(row)
        session.flush()


def user_can_access_project(
    session: Session,
    user_id: Optional[int],
    project_id: int,
) -> bool:
    """True if the user is an admin, or is assigned as a member of the
    project. None user (anonymous) returns True only when AUTH_REQUIRED
    is false — that policy is enforced at the router level via the
    optional vs strict auth dependency."""
    if user_id is None:
        return True  # router gates anonymous access separately
    user = session.get(User, user_id)
    if user is None:
        return False
    if user.is_admin:
        return True
    return (
        session.query(ProjectMember)
        .filter_by(project_id=project_id, user_id=user_id)
        .first()
        is not None
    )


# ============================================================
# Attendee roster
# ============================================================
def get_project_roster(session: Session, project_id: int) -> list[ProjectAttendee]:
    """Saved attendees for this project — what the chips on Review screen show."""
    return (
        session.query(ProjectAttendee)
        .filter_by(project_id=project_id)
        .order_by(ProjectAttendee.full_name)
        .all()
    )


def upsert_project_attendee(
    session: Session,
    project_id: int,
    full_name: str,
    initials: str,
    organization: str = "",
    email: str = "",
    first_seen_meeting_id: Optional[int] = None,
) -> ProjectAttendee:
    """Add to roster if missing, return existing if already saved."""
    existing = (
        session.query(ProjectAttendee)
        .filter_by(project_id=project_id, full_name=full_name)
        .first()
    )
    if existing:
        return existing
    attendee = ProjectAttendee(
        project_id=project_id,
        full_name=full_name,
        initials=initials,
        organization=organization,
        email=email,
        first_seen_meeting_id=first_seen_meeting_id,
    )
    session.add(attendee)
    session.flush()
    return attendee


# ============================================================
# Meetings
# ============================================================
def list_meetings(session: Session, project_id: int) -> list[Meeting]:
    return (
        session.query(Meeting)
        .filter_by(project_id=project_id)
        .order_by(desc(Meeting.meeting_date))
        .all()
    )


def get_meeting(session: Session, meeting_id: int) -> Optional[Meeting]:
    return session.get(Meeting, meeting_id)


def latest_meeting(session: Session, project_id: int) -> Optional[Meeting]:
    return (
        session.query(Meeting)
        .filter_by(project_id=project_id)
        .order_by(desc(Meeting.meeting_date))
        .first()
    )


# ============================================================
# Action items — rolling log
# ============================================================
def open_actions(session: Session, project_id: int) -> list[ActionItem]:
    """All actions for the project that aren't yet completed or cancelled."""
    return (
        session.query(ActionItem)
        .filter_by(project_id=project_id)
        .filter(ActionItem.status.in_(("open", "pending")))
        .order_by(ActionItem.due_date)
        .all()
    )


def all_actions(session: Session, project_id: int) -> list[ActionItem]:
    return (
        session.query(ActionItem)
        .filter_by(project_id=project_id)
        .order_by(desc(ActionItem.created_at))
        .all()
    )


def all_actions_across_portfolios(session: Session) -> list[ActionItem]:
    """Every action across every portfolio (all statuses), newest first.
    Backs the Actions page 'All portfolios' default view."""
    return (
        session.query(ActionItem)
        .order_by(desc(ActionItem.created_at))
        .all()
    )


def update_action_status(
    session: Session,
    action_id: int,
    new_status: str,
    closing_meeting_id: Optional[int] = None,
) -> ActionItem:
    """Status transitions go through here so we can track close-out meeting."""
    action = session.get(ActionItem, action_id)
    if not action:
        raise ValueError(f"ActionItem {action_id} not found")
    action.status = new_status
    if new_status in ("completed", "cancelled") and closing_meeting_id:
        action.closed_in_meeting_id = closing_meeting_id
    return action


# ============================================================
# Deliverables for next meeting (carry-forward + at-risk)
# ============================================================
# ============================================================
# Saved pre-meeting agendas
# ============================================================
def list_agendas(session: Session, project_id: int) -> list[Agenda]:
    """All saved agendas for a project, newest meeting date first."""
    return (
        session.query(Agenda)
        .filter_by(project_id=project_id)
        .order_by(desc(Agenda.upcoming_date), desc(Agenda.updated_at))
        .all()
    )


def get_agenda(session: Session, agenda_id: int) -> Optional[Agenda]:
    return session.get(Agenda, agenda_id)


def delete_agenda(session: Session, agenda_id: int) -> None:
    a = session.get(Agenda, agenda_id)
    if a is not None:
        session.delete(a)
        session.flush()


def save_agenda(
    session: Session,
    *,
    project_id: int,
    upcoming_date: date,
    source_meeting_id: Optional[int],
    title: Optional[str],
    disciplines: list,
    dp_text: dict,
    recap_text: dict,
    attendees: list,
    open_actions: list,
    risks: list,
    decisions: list,
    schedule_changes: Optional[list] = None,
    meeting_duration_minutes: int = 30,
    schedule_version_override: Optional[str] = None,
    agenda_id: Optional[int] = None,
) -> Agenda:
    """Insert a new Agenda row or update an existing one (when `agenda_id` is
    given). Returns the persisted row (caller commits via session_scope)."""
    if agenda_id is not None:
        agenda = session.get(Agenda, agenda_id)
        if agenda is None:
            raise ValueError(f"Agenda {agenda_id} not found")
    else:
        agenda = Agenda(project_id=project_id)
        session.add(agenda)

    agenda.upcoming_date = upcoming_date
    agenda.source_meeting_id = source_meeting_id
    agenda.title = title or None
    agenda.meeting_duration_minutes = int(meeting_duration_minutes or 30)
    agenda.disciplines_json = list(disciplines or [])
    agenda.dp_text_json = dict(dp_text or {})
    agenda.recap_text_json = dict(recap_text or {})
    agenda.attendees_json = list(attendees or [])
    agenda.open_actions_json = list(open_actions or [])
    agenda.risks_json = list(risks or [])
    agenda.decisions_json = list(decisions or [])
    agenda.schedule_changes_json = list(schedule_changes or [])
    agenda.schedule_version_override = (
        (schedule_version_override or "").strip() or None
    )
    session.flush()
    return agenda


# ============================================================
# Notes — portfolio planner
# ============================================================
def list_notes(session: Session, project_id: int) -> list[Note]:
    """Notes for the portfolio, sorted: follow-up date asc (nulls last),
    then note_date desc, so what's coming up bubbles to the top."""
    from sqlalchemy import nulls_last
    return (
        session.query(Note)
        .filter_by(project_id=project_id)
        .order_by(nulls_last(Note.follow_up_date.asc()),
                  Note.note_date.desc(),
                  Note.id.desc())
        .all()
    )


def get_note(session: Session, note_id: int) -> Optional[Note]:
    return session.get(Note, note_id)


def delete_note(session: Session, note_id: int) -> None:
    n = session.get(Note, note_id)
    if n is not None:
        session.delete(n)
        session.flush()


def all_open_actions_across_portfolios(session: Session) -> list[ActionItem]:
    """Every open/pending action across every portfolio. Used by the Home
    dashboard to surface overdue items globally."""
    return (
        session.query(ActionItem)
        .filter(ActionItem.status.in_(("open", "pending")))
        .order_by(ActionItem.due_date.asc().nullslast())
        .all()
    )


def all_notes_with_follow_up(session: Session) -> list:
    """Notes with a follow_up_date set (any portfolio, status open). Sorted
    by follow_up_date ascending so 'this week' bubbles to the top."""
    return (
        session.query(Note)
        .filter(Note.follow_up_date.isnot(None))
        .filter(Note.status == "open")
        .order_by(Note.follow_up_date.asc())
        .all()
    )


def all_upcoming_agendas(session: Session, today: date) -> list[Agenda]:
    """Saved Pre-Meeting Agendas whose upcoming_date is today or later.
    Used by Home dashboard."""
    return (
        session.query(Agenda)
        .filter(Agenda.upcoming_date >= today)
        .order_by(Agenda.upcoming_date.asc())
        .all()
    )


def set_portfolio_sub_projects(
    session: Session, project_id: int, names: list,
) -> Project:
    """Replace the portfolio's curated sub-project list. Strips/dedupes
    case-insensitively while preserving the first-seen casing."""
    p = session.get(Project, project_id)
    if p is None:
        raise ValueError(f"Project {project_id} not found")
    cleaned: list[str] = []
    seen_lower: set[str] = set()
    for n in (names or []):
        s = (n or "").strip()
        if not s:
            continue
        if s.lower() in seen_lower:
            continue
        seen_lower.add(s.lower())
        cleaned.append(s)
    p.sub_projects_json = cleaned
    session.flush()
    return p


# ============================================================
# Deliverables
# ============================================================
def list_deliverables(session: Session, project_id: int) -> list[Deliverable]:
    """All Deliverable rows attached to a portfolio (project).

    Used by the Notes tab to auto-discover sub-projects (project_segment
    values) — keep this distinct from `deliverables_to_carry_forward` which
    is meeting-scoped.
    """
    return (
        session.query(Deliverable)
        .filter_by(project_id=project_id)
        .order_by(Deliverable.project_segment.asc(), Deliverable.task.asc())
        .all()
    )


def deliverables_to_carry_forward(session: Session, project_id: int) -> list[Deliverable]:
    """
    Deliverables tracked on the most recent meeting that haven't passed their
    delivery date — pre-fill the next meeting's deliverable list with these.
    """
    last_meeting = latest_meeting(session, project_id)
    if not last_meeting:
        return []
    today = date.today()
    return [
        md.deliverable for md in last_meeting.meeting_deliverables
        if md.deliverable.delivery_date and md.deliverable.delivery_date >= today
    ]
