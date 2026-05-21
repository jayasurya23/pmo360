"""/api/agendas — saved pre-meeting agendas + agenda doc generation."""
from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import Project, Schedule
from db.repository import (
    list_agendas, get_agenda, save_agenda, delete_agenda,
    open_actions, deliverables_to_carry_forward,
)
from core.services import build_draft_meeting_view, safe_filename_slug
from docgen import (
    generate_premeeting_agenda_docx, generate_premeeting_agenda_pdf,
)
from llm.providers import ParsedDiscussionPoint
from schemas.common import AgendaOut, AgendaIn, AgendaDocRequest


router = APIRouter(prefix="/api/agendas", tags=["agendas"])


@router.get("", response_model=list[AgendaOut])
def get_agendas(project_id: int = Query(...), db: Session = Depends(get_db)):
    return list_agendas(db, project_id)


@router.get("/{agenda_id}", response_model=AgendaOut)
def get_one(agenda_id: int, db: Session = Depends(get_db)):
    a = get_agenda(db, agenda_id)
    if not a:
        raise HTTPException(404, "Agenda not found")
    return a


@router.post("", response_model=AgendaOut)
def upsert_agenda(payload: AgendaIn, db: Session = Depends(get_db)):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    a = save_agenda(
        db,
        project_id=payload.project_id,
        upcoming_date=payload.upcoming_date,
        source_meeting_id=payload.source_meeting_id,
        title=payload.title,
        disciplines=payload.disciplines,
        dp_text=payload.dp_text,
        recap_text=payload.recap_text,
        attendees=payload.attendees,
        open_actions=payload.open_actions,
        risks=payload.risks,
        decisions=payload.decisions,
        schedule_changes=payload.schedule_changes,
        meeting_duration_minutes=payload.meeting_duration_minutes,
        schedule_version_override=payload.schedule_version_override,
        agenda_id=payload.agenda_id,
    )
    return a


@router.delete("/{agenda_id}", status_code=204)
def remove(agenda_id: int, db: Session = Depends(get_db)):
    delete_agenda(db, agenda_id)
    return None


# ---------- Document generation ----------
def _dicts_to_dp_tree(rows):
    """Convert agenda discussion-point dicts → ParsedDiscussionPoint tree.

    Each dict has keys: label, content, discipline, sub_points (optional list).
    """
    out = []
    for row in rows or []:
        out.append(ParsedDiscussionPoint(
            label=row.get("label", "") or "",
            content=row.get("content", "") or "",
            discipline=row.get("discipline", "General") or "General",
            sub_points=_dicts_to_dp_tree(row.get("sub_points") or []),
        ))
    return out


@router.post("/generate")
def generate_doc(
    payload: AgendaDocRequest,
    fmt: str = Query("pdf", pattern="^(pdf|docx)$"),
    db: Session = Depends(get_db),
):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    # Build the in-memory meeting view that docgen consumes.
    meeting_view = build_draft_meeting_view(
        db, project,
        upcoming_date=payload.upcoming_date,
        attendees=payload.attendees,
        source_meeting_id=payload.source_meeting_id,
    )

    # Latest schedule for "Current Schedule Version" line
    schedule = (
        db.query(Schedule)
        .filter_by(project_id=payload.project_id)
        .order_by(Schedule.uploaded_at.desc())
        .first()
    )

    # Discussion + recap trees
    dp_by_discipline = {
        disc: _dicts_to_dp_tree(rows)
        for disc, rows in (payload.dp_by_discipline or {}).items()
    }
    recap_by_discipline = {
        disc: _dicts_to_dp_tree(rows)
        for disc, rows in (payload.recap_by_discipline or {}).items()
    }

    # Carry-forward open actions: caller passed them via payload.open_actions;
    # if blank, fall back to whatever's open on the project right now.
    carry_actions = []
    if payload.open_actions:
        from types import SimpleNamespace
        for a in payload.open_actions:
            carry_actions.append(SimpleNamespace(
                text=a.get("text", ""),
                owner=a.get("owner", ""),
                due_date=date.fromisoformat(a["due_date"]) if a.get("due_date") else None,
                status=a.get("status", "open"),
            ))
    else:
        carry_actions = open_actions(db, payload.project_id)

    carry_deliverables = deliverables_to_carry_forward(db, payload.project_id)

    if fmt == "pdf":
        data = generate_premeeting_agenda_pdf(
            meeting_view,
            carry_actions=carry_actions,
            carry_deliverables=carry_deliverables,
            schedule=schedule,
            disciplines=payload.disciplines or None,
            dp_by_discipline=dp_by_discipline,
            recap_by_discipline=recap_by_discipline,
            risks=payload.risks,
            decisions=payload.decisions,
            schedule_changes=payload.schedule_changes,
            meeting_duration_minutes=payload.meeting_duration_minutes,
            schedule_version_override=payload.schedule_version_override,
        )
        media = "application/pdf"
        ext = "pdf"
    else:
        data = generate_premeeting_agenda_docx(
            meeting_view,
            carry_actions=carry_actions,
            carry_deliverables=carry_deliverables,
            schedule=schedule,
            disciplines=payload.disciplines or None,
            dp_by_discipline=dp_by_discipline,
            recap_by_discipline=recap_by_discipline,
            risks=payload.risks,
            decisions=payload.decisions,
            schedule_changes=payload.schedule_changes,
            meeting_duration_minutes=payload.meeting_duration_minutes,
            schedule_version_override=payload.schedule_version_override,
        )
        media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ext = "docx"

    proj_slug = safe_filename_slug(project.name)
    date_str = payload.upcoming_date.strftime("%Y-%m-%d")
    filename = f"{proj_slug}_Pre_Meeting_Agenda_{date_str}.{ext}"
    return Response(
        content=data,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
