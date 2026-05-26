"""/api/agendas — saved pre-meeting agendas + agenda doc generation."""
from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import get_current_db_user
from db.models import Project, Schedule, ProjectAttendee, GlobalAttendee, Agenda
from db.repository import (
    list_agendas, get_agenda, save_agenda, delete_agenda,
    open_actions, deliverables_to_carry_forward,
)
from core.services import build_draft_meeting_view, safe_filename_slug
from docgen import (
    generate_premeeting_agenda_docx, generate_premeeting_agenda_pdf,
)
from docgen.ical import build_agenda_ics
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
def upsert_agenda(
    payload: AgendaIn,
    db: Session = Depends(get_db),
    actor = Depends(get_current_db_user),
):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    # Optimistic concurrency check for updates. New-agenda creates skip this
    # because there's nothing to be stale against.
    if payload.agenda_id is not None:
        existing = db.get(Agenda, payload.agenda_id)
        if existing is None:
            raise HTTPException(404, "Agenda not found")
        if (payload.expected_version is not None
                and existing.version != payload.expected_version):
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "stale_version",
                    "message": (
                        "This agenda was saved by someone else while you "
                        "were editing. Reload to see the latest version."
                    ),
                    "current_version": existing.version,
                    "submitted_version": payload.expected_version,
                },
            )

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
    # Bump the version on every successful save so subsequent edits compare
    # against the new value.
    a.version = (a.version or 1) + (1 if payload.agenda_id is not None else 0)
    # Per-user attribution stamps.
    if actor is not None:
        if a.created_by_id is None:
            a.created_by_id = actor.id
        a.updated_by_id = actor.id
    db.flush()
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


# ---------- iCalendar (.ics) export ----------
@router.get("/{agenda_id}/ics")
def export_agenda_ics(agenda_id: int, db: Session = Depends(get_db)):
    """Download a single-event .ics file for the upcoming agenda.

    Pulls attendee emails by matching the agenda's saved attendees against
    the project's roster + the global roster (case-insensitive on full_name).
    Attendees without a known email are still included in the description
    block but skipped from ATTENDEE lines (RFC 5545 requires mailto).
    """
    agenda = get_agenda(db, agenda_id)
    if agenda is None:
        raise HTTPException(404, "Agenda not found")
    project = agenda.project

    # ---- Resolve attendee emails ----
    saved_attendees: list[dict] = list(agenda.attendees_json or [])
    name_to_email: dict[str, str] = {}
    for a in db.query(ProjectAttendee).filter_by(project_id=project.id).all():
        if a.full_name and a.email:
            name_to_email[a.full_name.strip().lower()] = a.email
    for g in db.query(GlobalAttendee).all():
        key = (g.full_name or "").strip().lower()
        if g.email and key not in name_to_email:
            name_to_email[key] = g.email

    attendees_with_email: list[dict] = []
    for a in saved_attendees:
        name = (a.get("full_name") or "").strip()
        if not name:
            continue
        email = (a.get("email") or "").strip() or name_to_email.get(name.lower(), "")
        attendees_with_email.append({
            "full_name": name,
            "email": email,
            "organization": a.get("organization") or "",
        })

    # ---- Build a human-readable description from the disciplines + topics ----
    desc_lines: list[str] = []
    if project.client and project.client.name:
        desc_lines.append(f"Client: {project.client.name}")
    desc_lines.append(f"Portfolio: {project.name}")
    if attendees_with_email:
        desc_lines.append("")
        desc_lines.append("Attendees:")
        for a in attendees_with_email:
            org = f" — {a['organization']}" if a["organization"] else ""
            desc_lines.append(f"  • {a['full_name']}{org}")
    discs = list(agenda.disciplines_json or [])
    dp_text = agenda.dp_text_json or {}
    if any((dp_text.get(d) or "").strip() for d in discs):
        desc_lines.append("")
        desc_lines.append("Discussion topics:")
        for d in discs:
            chunk = (dp_text.get(d) or "").strip()
            if not chunk:
                continue
            desc_lines.append(f"  {d}:")
            for ln in chunk.splitlines():
                stripped = ln.strip().lstrip("-*• ").strip()
                if stripped:
                    desc_lines.append(f"    • {stripped}")
    description = "\n".join(desc_lines)

    title = agenda.title or f"Pre-meeting coordination — {project.name}"
    ics_bytes = build_agenda_ics(
        title=title,
        upcoming_date=agenda.upcoming_date,
        duration_minutes=agenda.meeting_duration_minutes or 30,
        description=description,
        attendees=attendees_with_email,
    )

    proj_slug = safe_filename_slug(project.name)
    date_str = agenda.upcoming_date.strftime("%Y-%m-%d")
    filename = f"{proj_slug}_Pre_Meeting_Agenda_{date_str}.ics"
    return Response(
        content=ics_bytes,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
