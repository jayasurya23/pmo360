"""/api/actions — rolling action items per project."""
import csv
import io
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import require_db_user
from auth.permissions import MEETING_MINUTES, require_permission
from db.models import ActionItem, Project, Client, Meeting
from db.repository import (
    all_actions, open_actions, update_action_status,
    all_open_actions_across_portfolios, all_actions_across_portfolios,
)
from core.services import safe_filename_slug
from schemas.common import ActionItemOut, ActionItemUpdate, ActionItemCreate


router = APIRouter(prefix="/api/actions", tags=["actions"])


def _with_context(db: Session, rows: list[ActionItem]) -> list[ActionItemOut]:
    """Attach each action's portfolio name, client name, and originating-meeting
    date so the cross-portfolio Actions view can render them. Uses one query per
    lookup table (projects / clients / meeting dates) — no per-row N+1."""
    projects = {p.id: p for p in db.query(Project).all()}
    clients = {c.id: c.name for c in db.query(Client).all()}
    meeting_dates = dict(db.query(Meeting.id, Meeting.meeting_date).all())
    out: list[ActionItemOut] = []
    for r in rows:
        o = ActionItemOut.model_validate(r)
        proj = projects.get(r.project_id)
        if proj is not None:
            o.project_name = proj.name
            o.client_name = clients.get(proj.client_id)
        o.originating_meeting_date = meeting_dates.get(r.originating_meeting_id)
        out.append(o)
    return out


@router.get("", response_model=list[ActionItemOut])
def list_actions(
    project_id: int | None = Query(None),
    only_open: bool = Query(False),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """List actions. With ``project_id`` -> that portfolio only; without it ->
    every action across all portfolios (the Actions page default view)."""
    if project_id is not None:
        rows = open_actions(db, project_id) if only_open else all_actions(db, project_id)
    else:
        rows = (
            all_open_actions_across_portfolios(db)
            if only_open
            else all_actions_across_portfolios(db)
        )
    return _with_context(db, rows)


@router.post("", response_model=ActionItemOut, status_code=201)
def create_action(
    payload: ActionItemCreate,
    db: Session = Depends(get_db),
    actor = Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    # payload.project_id is the row's own portfolio — where this action will
    # live and who will see it — so it is the right thing to authorise against.
    guard.require_project(payload.project_id)
    action = ActionItem(
        project_id=payload.project_id,
        originating_meeting_id=payload.originating_meeting_id,
        text=payload.text,
        owner=payload.owner or None,
        owner_user_id=payload.owner_user_id,
        due_date=payload.due_date,
        status=payload.status or "open",
        created_by_id=actor.id,
        updated_by_id=actor.id,
    )
    db.add(action)
    db.flush()
    return action


@router.patch("/{action_id}", response_model=ActionItemOut)
def patch_action(
    action_id: int,
    payload: ActionItemUpdate,
    db: Session = Depends(get_db),
    actor = Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    action = db.get(ActionItem, action_id)
    if not action:
        raise HTTPException(404, "Action not found")
    guard.require_project(action.project_id)
    # `model_fields_set` lets us distinguish "field not in the request"
    # (leave alone) from "field explicitly set to null" (clear it). That
    # distinction matters for owner_user_id — re-assigning an action from
    # a PMO PM to an external vendor needs to NULL out the user link.
    sent = payload.model_fields_set
    if "text" in sent and payload.text is not None:
        action.text = payload.text
    if "owner" in sent:
        action.owner = payload.owner
    if "owner_user_id" in sent:
        action.owner_user_id = payload.owner_user_id
    if "due_date" in sent:
        action.due_date = payload.due_date
    if "status" in sent and payload.status is not None:
        if payload.status in ("completed", "cancelled") and payload.closing_meeting_id:
            update_action_status(db, action_id, payload.status, payload.closing_meeting_id)
        else:
            action.status = payload.status
        action.last_status_change = datetime.utcnow()
    action.updated_by_id = actor.id
    db.flush()
    return action


@router.delete("/{action_id}", status_code=204)
def delete_action(
    action_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    a = db.get(ActionItem, action_id)
    if not a:
        raise HTTPException(404, "Action not found")
    guard.require_project(a.project_id)
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
    project_id: int | None = Query(None),
    status: str = Query("all"),
    owner: str = Query("", description="Case-insensitive substring filter on owner"),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Stream a CSV of action items. With ``project_id`` it's scoped to that
    portfolio; without it, every portfolio's actions (the 'All portfolios'
    view). Portfolio + Client columns are appended so the cross-portfolio
    export stays self-describing.

    Filters mirror what the Actions page renders so the export matches the
    table the PM is looking at when they click Export. Existing columns keep
    their position so PMs' pivot tables / Power BI / Excel formulas don't break.
    """
    if project_id is not None:
        project = db.get(Project, project_id)
        if not project:
            raise HTTPException(404, "Project not found")
        rows = all_actions(db, project_id)
        scope_slug = safe_filename_slug(project.name or "project")
    else:
        rows = all_actions_across_portfolios(db)
        scope_slug = "All_Portfolios"

    # Portfolio + client name lookup for the trailing columns (one query each).
    projects = {p.id: p for p in db.query(Project).all()}
    clients = {c.id: c.name for c in db.query(Client).all()}

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
        # appended so existing column positions stay stable
        "Portfolio", "Client",
    ])
    for i, a in enumerate(rows, start=1):
        proj = projects.get(a.project_id)
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
            (proj.name if proj else "") or "",
            (clients.get(proj.client_id) if proj else "") or "",
        ])

    data = buf.getvalue().encode("utf-8")
    date_str = datetime.utcnow().strftime("%Y-%m-%d")
    filename = f"{scope_slug}_Actions_{date_str}.csv"
    return StreamingResponse(
        iter([data]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
