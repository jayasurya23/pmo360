"""/api/dashboard — home page rollup (overdue actions, follow-ups, agendas)."""
from datetime import date
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from core.deps import get_db
from db.repository import (
    all_open_actions_across_portfolios, all_notes_with_follow_up,
    all_upcoming_agendas,
)
from schemas.common import (
    DashboardResponse, DashboardActionOut, DashboardNoteOut, DashboardAgendaOut,
)


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
