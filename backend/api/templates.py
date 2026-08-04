"""/api/templates — recurring meeting templates.

A reusable boilerplate per-portfolio: attendees, agenda topics, default
deliverables, and meeting duration. PMs running the same weekly
coordination meeting save the boilerplate once and clone it for each new
meeting on the Capture page.

The JSON blobs intentionally mirror the shapes used by the in-progress
draft on the frontend (selectedAttendees, parsed.agenda_items,
selectedDeliverables) so the clone path is a direct hydrate without any
translation layer.

A template is meeting boilerplate, so editing one takes `meeting_minutes` plus
membership of the portfolio it belongs to. The one exception is the
usage-timestamp bump — see `touch_template`.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc
from sqlalchemy.orm import Session

from auth import require_db_user
from auth.permissions import MEETING_MINUTES, require_permission
from core.deps import get_db
from db.models import MeetingTemplate, Project
from schemas.common import (
    MeetingTemplateIn, MeetingTemplateOut, MeetingTemplateUpdate,
)


router = APIRouter(prefix="/api/templates", tags=["templates"])


@router.get("", response_model=list[MeetingTemplateOut])
def list_templates(
    project_id: int = Query(...),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Templates for a single portfolio, alphabetical by name (matches the
    Capture page dropdown — PMs scan by name, not by last-edited)."""
    return (
        db.query(MeetingTemplate)
        .filter_by(project_id=project_id)
        .order_by(MeetingTemplate.name.asc(), desc(MeetingTemplate.updated_at))
        .all()
    )


@router.get("/{template_id}", response_model=MeetingTemplateOut)
def get_template(template_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    t = db.get(MeetingTemplate, template_id)
    if not t:
        raise HTTPException(404, "Template not found")
    return t


@router.post("", response_model=MeetingTemplateOut, status_code=201)
def create_template(
    payload: MeetingTemplateIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    # True create: the payload's portfolio is where the template lands, and it
    # is a body field the dependency's path/query resolution cannot see.
    guard.require_project(payload.project_id)
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, "Template name is required")
    t = MeetingTemplate(
        project_id=payload.project_id,
        name=name,
        attendees_json=list(payload.attendees_json or []),
        agenda_topics_json=list(payload.agenda_topics_json or []),
        default_duration_minutes=int(payload.default_duration_minutes or 60),
        default_deliverables_json=list(payload.default_deliverables_json or []),
        created_by_id=actor.id,
    )
    db.add(t)
    db.flush()
    return t


@router.patch("/{template_id}", response_model=MeetingTemplateOut)
def update_template(
    template_id: int,
    payload: MeetingTemplateUpdate,
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    t = db.get(MeetingTemplate, template_id)
    if not t:
        raise HTTPException(404, "Template not found")
    # Scope off the loaded row — the URL names a template, not a portfolio, and
    # the template never moves between portfolios.
    guard.require_project(t.project_id)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise HTTPException(400, "Template name cannot be blank")
        t.name = name
    if "attendees_json" in data:
        t.attendees_json = list(data["attendees_json"] or [])
    if "agenda_topics_json" in data:
        t.agenda_topics_json = list(data["agenda_topics_json"] or [])
    if "default_duration_minutes" in data and data["default_duration_minutes"] is not None:
        t.default_duration_minutes = int(data["default_duration_minutes"])
    if "default_deliverables_json" in data:
        t.default_deliverables_json = list(data["default_deliverables_json"] or [])
    db.flush()
    return t


@router.delete("/{template_id}", status_code=204)
def delete_template(
    template_id: int, db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    t = db.get(MeetingTemplate, template_id)
    if not t:
        raise HTTPException(404, "Template not found")
    guard.require_project(t.project_id)
    db.delete(t)
    return None


@router.post("/{template_id}/touch", response_model=MeetingTemplateOut)
def touch_template(template_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Bump ``last_used_at`` to now() — called by the Capture page after
    cloning the template. Lets the next /api/templates fetch sort by
    "most recently used" so the PM's daily-driver templates float to the
    top of the picker. Idempotent and safe to fire-and-forget.

    Deliberately NOT gated on `meeting_minutes`, unlike every other write in
    this file. It records that someone LOOKED at a template, and looking is
    what a read-only user is explicitly allowed to do: gating it would leave
    them with a recent-templates list frozen forever, plus a 403 in the console
    on every clone — from a fire-and-forget call they never chose to make. The
    write it performs is one timestamp on a row the caller may already read,
    and the worst a hostile caller achieves is reordering someone's picker.
    """
    from datetime import datetime
    t = db.get(MeetingTemplate, template_id)
    if not t:
        raise HTTPException(404, "Template not found")
    t.last_used_at = datetime.utcnow()
    db.flush()
    return t
