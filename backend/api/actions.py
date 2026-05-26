"""/api/actions — rolling action items per project."""
import csv
import io
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import get_current_db_user
from db.models import ActionItem, Project
from db.repository import all_actions, open_actions, update_action_status
from core.services import safe_filename_slug
from schemas.common import ActionItemOut, ActionItemUpdate, ActionItemCreate


router = APIRouter(prefix="/api/actions", tags=["actions"])


@router.get("", response_model=list[ActionItemOut])
def list_actions(
    project_id: int = Query(...),
    only_open: bool = Query(False),
    db: Session = Depends(get_db),
):
    if only_open:
        return open_actions(db, project_id)
    return all_actions(db, project_id)


@router.post("", response_model=ActionItemOut, status_code=201)
def create_action(
    payload: ActionItemCreate,
    db: Session = Depends(get_db),
    actor = Depends(get_current_db_user),
):
    action = ActionItem(
        project_id=payload.project_id,
        originating_meeting_id=payload.originating_meeting_id,
        text=payload.text,
        owner=payload.owner or None,
        due_date=payload.due_date,
        status=payload.status or "open",
        created_by_id=actor.id if actor else None,
        updated_by_id=actor.id if actor else None,
    )
    db.add(action)
    db.flush()
    return action


@router.patch("/{action_id}", response_model=ActionItemOut)
def patch_action(
    action_id: int,
    payload: ActionItemUpdate,
    db: Session = Depends(get_db),
    actor = Depends(get_current_db_user),
):
    action = db.get(ActionItem, action_id)
    if not action:
        raise HTTPException(404, "Action not found")
    if payload.text is not None:
        action.text = payload.text
    if payload.owner is not None:
        action.owner = payload.owner
    if payload.due_date is not None:
        action.due_date = payload.due_date
    if payload.status is not None:
        if payload.status in ("completed", "cancelled") and payload.closing_meeting_id:
            update_action_status(db, action_id, payload.status, payload.closing_meeting_id)
        else:
            action.status = payload.status
        action.last_status_change = datetime.utcnow()
    if actor is not None:
        action.updated_by_id = actor.id
    db.flush()
    return action


@router.delete("/{action_id}", status_code=204)
def delete_action(action_id: int, db: Session = Depends(get_db)):
    a = db.get(ActionItem, action_id)
    if not a:
        raise HTTPException(404, "Action not found")
    db.delete(a)
    return None


# ============================================================
# CSV export
# ============================================================
# `status` accepts the same status strings the page filter uses ("open",
# "pending", "completed", "cancelled") OR the synthetic "open+pending"
# shortcut the Actions page defaults to. Unrecognized values fall through
# to "all actions" rather than 400-ing — the user opening the URL by hand
# shouldn't be punished for typos.
_STATUS_FILTERS: dict[str, set[str]] = {
    "open": {"open"},
    "pending": {"pending"},
    "completed": {"completed"},
    "cancelled": {"cancelled"},
    # Two spellings of the "show me what's still on my plate" shortcut —
    # the frontend uses `open_pending` (underscore) but we accept both.
    "open+pending": {"open", "pending"},
    "open_pending": {"open", "pending"},
}


@router.get("/export.csv")
def export_actions_csv(
    project_id: int = Query(...),
    status: str = Query("all"),
    owner: str = Query("", description="Case-insensitive substring filter on owner"),
    db: Session = Depends(get_db),
):
    """Stream a CSV of action items for the given portfolio.

    Filters mirror what the Actions page renders so the export matches the
    table the PM is looking at when they click Export. Columns are stable
    so PMs can build pivot tables / Power BI / Excel formulas against the
    output without breakage when we add new fields server-side.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    rows = all_actions(db, project_id)

    # Status filter
    allowed = _STATUS_FILTERS.get(status.lower())
    if allowed is not None:
        rows = [r for r in rows if (r.status or "open").lower() in allowed]

    # Owner substring filter (case-insensitive). Owner is a comma-separated
    # free-text string today, so substring match is the honest semantics.
    if owner.strip():
        needle = owner.strip().lower()
        rows = [r for r in rows if needle in (r.owner or "").lower()]

    # Build the CSV in-memory. We use csv.writer rather than concatenating
    # strings so commas / quotes / newlines inside owner names + action text
    # get escaped properly (RFC 4180).
    buf = io.StringIO()
    # Excel doesn't autodetect UTF-8 without a BOM; prepend one so non-ASCII
    # names (Roashaael, em-dashes from the LLM) render correctly when the
    # user double-clicks the CSV.
    buf.write("﻿")
    writer = csv.writer(buf)
    writer.writerow([
        "#", "Action", "Owner", "Due Date", "Status",
        "Raised in meeting", "Closed in meeting",
        "Created at", "Updated at",
        "Created by", "Updated by",
    ])
    for i, a in enumerate(rows, start=1):
        writer.writerow([
            i,
            (a.text or "").strip(),
            (a.owner or "").strip(),
            a.due_date.isoformat() if a.due_date else "",
            (a.status or "open").capitalize(),
            (
                a.originating_meeting.meeting_date.isoformat()
                if a.originating_meeting and a.originating_meeting.meeting_date
                else ""
            ),
            (
                a.closed_in_meeting.meeting_date.isoformat()
                if a.closed_in_meeting and a.closed_in_meeting.meeting_date
                else ""
            ),
            a.created_at.isoformat(timespec="minutes") if a.created_at else "",
            a.updated_at.isoformat(timespec="minutes") if a.updated_at else "",
            (a.created_by.name if a.created_by else "") or "",
            (a.updated_by.name if a.updated_by else "") or "",
        ])

    data = buf.getvalue().encode("utf-8")
    proj_slug = safe_filename_slug(project.name or "project")
    date_str = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"{proj_slug}_Actions_{date_str}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
