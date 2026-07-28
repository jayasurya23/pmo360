"""/api/agendas — saved pre-meeting agendas + agenda doc generation."""
from datetime import date, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import desc
from sqlalchemy.orm import Session
from pydantic import BaseModel

from core.deps import get_db
from auth import get_current_db_user, require_db_user
from db.models import Project, Schedule, ProjectAttendee, GlobalAttendee, Agenda
from db.repository import (
    list_agendas, get_agenda, save_agenda, delete_agenda,
    open_actions, deliverables_to_carry_forward, latest_meeting,
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
def get_agendas(project_id: int = Query(...), db: Session = Depends(get_db), _user=Depends(require_db_user)):
    return list_agendas(db, project_id)


@router.get("/{agenda_id}", response_model=AgendaOut)
def get_one(agenda_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
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
def remove(agenda_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
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
    _user=Depends(require_db_user),
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
def export_agenda_ics(agenda_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
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


# ============================================================
# Auto-draft from history
# ============================================================
class AgendaAutoDraftResponse(BaseModel):
    """Pre-filled payload returned by /auto-draft. The frontend hydrates the
    NextAgenda editor from this — nothing is saved server-side here, so the
    PM still has to click Save to persist (lets them review + tweak before
    committing).

    Sources:
      - attendees       → last meeting's attendees (or last agenda's if no
                          meetings exist yet)
      - open_actions    → currently-open actions for the portfolio
      - risks/decisions/schedule_changes → most-recent agenda's lists (the
                          PM almost always carries these forward by default)
      - recap_text      → discussion points from the last meeting, grouped
                          by discipline (the "previous-week recap" rail)
      - dp_text         → empty (PM fills in discussion topics for THIS
                          upcoming meeting)
      - disciplines     → most-recent agenda's discipline list, else
                          DEFAULT_DISCIPLINES
      - duration        → most-recent agenda's, else 30
    """
    upcoming_date: date
    title: str | None = None
    source_meeting_id: int | None = None
    meeting_duration_minutes: int = 30
    schedule_version_override: str | None = None
    disciplines: list[str]
    dp_text: dict[str, str]
    recap_text: dict[str, str]
    attendees: list[dict]
    open_actions: list[dict]
    risks: list[dict]
    decisions: list[dict]
    schedule_changes: list[dict]
    # Human-readable breakdown of what was pulled from where, surfaced to
    # the PM as a status message after auto-draft completes ("Pulled 4
    # actions, 3 attendees, 2 risks from history.")
    sources_summary: str


_DEFAULT_DISCIPLINES = ["Civil", "Electrical", "Structural", "General"]


def _summarise_dp_for_recap(meeting) -> dict[str, str]:
    """Group last meeting's discussion points into recap textareas keyed
    by discipline. Each line is `label: content`, joined with newlines
    so the textarea round-trips cleanly through NextAgenda's existing
    `buildDpFromText` parser."""
    out: dict[str, list[str]] = {}
    for dp in meeting.discussion_points:
        # Only top-level points — sub-points get inlined into their parent
        # for the recap (PMs care that something happened, not the indented
        # nesting from the original notes).
        if dp.parent_id is not None:
            continue
        disc = (dp.discipline or "General").strip() or "General"
        out.setdefault(disc, [])
        line = (
            f"{dp.label}: {dp.content}"
            if dp.label and dp.content else (dp.label or dp.content or "")
        )
        out[disc].append(line)
    return {disc: "\n".join(lines) for disc, lines in out.items() if lines}


@router.post("/auto-draft", response_model=AgendaAutoDraftResponse)
def auto_draft_agenda(
    project_id: int = Query(..., description="Portfolio to draft for"),
    upcoming_date: date | None = Query(
        None,
        description=(
            "Target meeting date. Defaults to one week from the latest "
            "meeting (or today + 7 days if no meeting exists yet)."
        ),
    ),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Assemble a NextAgenda draft from the portfolio's history.

    Idempotent + read-only — nothing is persisted server-side. PM still
    saves the result via the existing POST /api/agendas.
    """
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")

    last_meeting = latest_meeting(db, project_id)
    last_agenda = (
        db.query(Agenda)
        .filter_by(project_id=project_id)
        .order_by(desc(Agenda.upcoming_date), desc(Agenda.updated_at))
        .first()
    )

    # ---- Upcoming date default ----
    if upcoming_date is None:
        anchor = last_meeting.meeting_date if last_meeting else date.today()
        upcoming_date = anchor + timedelta(days=7)

    # ---- Attendees: prefer last meeting (snapshot of who actually came),
    # fall back to last agenda's saved attendee list, else empty. ----
    if last_meeting and last_meeting.attendees:
        attendees = [
            {
                "full_name": a.full_name,
                "initials": a.initials,
                "organization": a.organization or "",
            }
            for a in last_meeting.attendees
        ]
    elif last_agenda and isinstance(last_agenda.attendees_json, list):
        attendees = list(last_agenda.attendees_json)
    else:
        attendees = []

    # ---- Open actions ----
    open_acts = open_actions(db, project_id)
    open_actions_payload = [
        {
            "text": a.text,
            "owner": a.owner or "",
            "due_date": a.due_date.isoformat() if a.due_date else None,
            "status": a.status,
        }
        for a in open_acts
    ]

    # ---- Carry-forward sections from the most recent agenda ----
    risks = list(last_agenda.risks_json or []) if last_agenda else []
    decisions = list(last_agenda.decisions_json or []) if last_agenda else []
    schedule_changes = (
        list(last_agenda.schedule_changes_json or []) if last_agenda else []
    )

    # ---- Recap text from last meeting ----
    recap_text = _summarise_dp_for_recap(last_meeting) if last_meeting else {}

    # ---- Disciplines + duration ----
    disciplines = (
        list(last_agenda.disciplines_json)
        if last_agenda and last_agenda.disciplines_json
        else _DEFAULT_DISCIPLINES
    )
    duration = (
        last_agenda.meeting_duration_minutes
        if last_agenda and last_agenda.meeting_duration_minutes
        else 30
    )

    # ---- Title default ----
    if last_meeting and last_meeting.title:
        # "Heelstone weekly — May 21" → just "Heelstone weekly" for the
        # carried-forward title; PMs almost always want a fresh date.
        title = last_meeting.title.rsplit("—", 1)[0].strip()
    else:
        title = None

    sources_bits = []
    if attendees:
        sources_bits.append(
            f"{len(attendees)} attendee{'s' if len(attendees) != 1 else ''}"
        )
    if open_actions_payload:
        sources_bits.append(
            f"{len(open_actions_payload)} open action"
            f"{'s' if len(open_actions_payload) != 1 else ''}"
        )
    if risks:
        sources_bits.append(f"{len(risks)} risk{'s' if len(risks) != 1 else ''}")
    if decisions:
        sources_bits.append(
            f"{len(decisions)} decision{'s' if len(decisions) != 1 else ''}"
        )
    if recap_text:
        sources_bits.append(
            f"recap from {last_meeting.meeting_date.isoformat()}"
            if last_meeting else "recap"
        )
    sources_summary = (
        "Auto-drafted: " + ", ".join(sources_bits)
        if sources_bits else
        "Auto-drafted from history — no prior data to carry forward."
    )

    return AgendaAutoDraftResponse(
        upcoming_date=upcoming_date,
        title=title,
        source_meeting_id=last_meeting.id if last_meeting else None,
        meeting_duration_minutes=duration,
        schedule_version_override=None,
        disciplines=disciplines,
        dp_text={},  # PM fills in topics for THIS meeting
        recap_text=recap_text,
        attendees=attendees,
        open_actions=open_actions_payload,
        risks=risks,
        decisions=decisions,
        schedule_changes=schedule_changes,
        sources_summary=sources_summary,
    )
