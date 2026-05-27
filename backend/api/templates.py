"""/api/templates — recurring meeting templates.

A reusable boilerplate per-portfolio: attendees, agenda topics, default
deliverables, and meeting duration. PMs running the same weekly
coordination meeting save the boilerplate once and clone it for each new
meeting on the Capture page.

The JSON blobs intentionally mirror the shapes used by the in-progress
draft on the frontend (selectedAttendees, parsed.agenda_items,
selectedDeliverables) so the clone path is a direct hydrate without any
translation layer.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc
from sqlalchemy.orm import Session

from auth import get_current_db_user
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
def get_template(template_id: int, db: Session = Depends(get_db)):
    t = db.get(MeetingTemplate, template_id)
    if not t:
        raise HTTPException(404, "Template not found")
    return t


@router.post("", response_model=MeetingTemplateOut, status_code=201)
def create_template(
    payload: MeetingTemplateIn,
    db: Session = Depends(get_db),
    actor=Depends(get_current_db_user),
):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Project not found")
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
        created_by_id=actor.id if actor else None,
    )
    db.add(t)
    db.flush()
    return t


@router.patch("/{template_id}", response_model=MeetingTemplateOut)
def update_template(
    template_id: int,
    payload: MeetingTemplateUpdate,
    db: Session = Depends(get_db),
):
    t = db.get(MeetingTemplate, template_id)
    if not t:
        raise HTTPException(404, "Template not found")
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
def delete_template(template_id: int, db: Session = Depends(get_db)):
    t = db.get(MeetingTemplate, template_id)
    if not t:
        raise HTTPException(404, "Template not found")
    db.delete(t)
    return None


@router.post("/{template_id}/touch", response_model=MeetingTemplateOut)
def touch_template(template_id: int, db: Session = Depends(get_db)):
    """Bump ``last_used_at`` to now() — called by the Capture page after
    cloning the template. Lets the next /api/templates fetch sort by
    "most recently used" so the PM's daily-driver templates float to the
    top of the picker. Idempotent and safe to fire-and-forget.
    """
    from datetime import datetime
    t = db.get(MeetingTemplate, template_id)
    if not t:
        raise HTTPException(404, "Template not found")
    t.last_used_at = datetime.utcnow()
    db.flush()
    return t
