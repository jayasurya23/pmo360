"""/api/actions — rolling action items per project."""
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import ActionItem
from db.repository import all_actions, open_actions, update_action_status
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
def create_action(payload: ActionItemCreate, db: Session = Depends(get_db)):
    action = ActionItem(
        project_id=payload.project_id,
        originating_meeting_id=payload.originating_meeting_id,
        text=payload.text,
        owner=payload.owner or None,
        due_date=payload.due_date,
        status=payload.status or "open",
    )
    db.add(action)
    db.flush()
    return action


@router.patch("/{action_id}", response_model=ActionItemOut)
def patch_action(action_id: int, payload: ActionItemUpdate, db: Session = Depends(get_db)):
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
    db.flush()
    return action


@router.delete("/{action_id}", status_code=204)
def delete_action(action_id: int, db: Session = Depends(get_db)):
    a = db.get(ActionItem, action_id)
    if not a:
        raise HTTPException(404, "Action not found")
    db.delete(a)
    return None
