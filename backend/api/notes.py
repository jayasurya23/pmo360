"""/api/notes — portfolio planner notes (separate from action items)."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import Note
from db.repository import list_notes
from schemas.common import NoteOut, NoteIn, NoteUpdate


router = APIRouter(prefix="/api/notes", tags=["notes"])


@router.get("", response_model=list[NoteOut])
def get_notes(project_id: int = Query(...), db: Session = Depends(get_db)):
    return list_notes(db, project_id)


@router.post("", response_model=NoteOut, status_code=201)
def create_note(payload: NoteIn, db: Session = Depends(get_db)):
    n = Note(
        project_id=payload.project_id,
        project_area=payload.project_area,
        source=payload.source,
        topic=payload.topic,
        action_needed=payload.action_needed,
        note_date=payload.note_date,
        follow_up_date=payload.follow_up_date,
        priority=payload.priority,
        status=payload.status,
    )
    db.add(n)
    db.flush()
    return n


@router.patch("/{note_id}", response_model=NoteOut)
def patch_note(note_id: int, payload: NoteUpdate, db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if not n:
        raise HTTPException(404, "Note not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(n, field, value)
    db.flush()
    return n


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: int, db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if not n:
        raise HTTPException(404, "Note not found")
    db.delete(n)
    return None
