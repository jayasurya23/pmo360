"""/api/notes — portfolio planner notes (separate from action items)."""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

from core.deps import get_db
from auth import get_current_db_user
from db.models import Note
from db.repository import list_notes, get_project_roster
from schemas.common import NoteOut, NoteIn, NoteUpdate
from llm.providers import get_provider


class SuggestedActionOut(BaseModel):
    """Frontend-facing shape for an LLM-proposed action from a note. Empty
    `text` signals the note is informational (no action proposed)."""
    text: str
    owner: str = ""
    due_date: Optional[str] = None
    rationale: str = ""


router = APIRouter(prefix="/api/notes", tags=["notes"])


@router.get("", response_model=list[NoteOut])
def get_notes(project_id: int = Query(...), db: Session = Depends(get_db)):
    return list_notes(db, project_id)


@router.post("", response_model=NoteOut, status_code=201)
def create_note(
    payload: NoteIn,
    db: Session = Depends(get_db),
    actor = Depends(get_current_db_user),
):
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
        created_by_id=actor.id if actor else None,
        updated_by_id=actor.id if actor else None,
    )
    db.add(n)
    db.flush()
    return n


@router.patch("/{note_id}", response_model=NoteOut)
def patch_note(
    note_id: int,
    payload: NoteUpdate,
    db: Session = Depends(get_db),
    actor = Depends(get_current_db_user),
):
    n = db.get(Note, note_id)
    if not n:
        raise HTTPException(404, "Note not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(n, field, value)
    if actor is not None:
        n.updated_by_id = actor.id
    db.flush()
    return n


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: int, db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if not n:
        raise HTTPException(404, "Note not found")
    db.delete(n)
    return None


@router.post("/{note_id}/suggest-action", response_model=SuggestedActionOut)
def suggest_action_from_note(note_id: int, db: Session = Depends(get_db)):
    """Ask the LLM to extract a concrete ActionItem proposal from this
    note's text. Returns text/owner/due_date/rationale; empty `text` means
    the note looks informational and no action was extracted.

    The PM reviews the suggestion in a confirm modal and either accepts
    (frontend POSTs to /api/actions) or dismisses."""
    n = db.get(Note, note_id)
    if not n:
        raise HTTPException(404, "Note not found")

    note_text = (n.action_needed or "").strip()
    if not note_text and n.topic:
        # Fall back to topic when the action_needed field is blank — better
        # than refusing to suggest anything.
        note_text = n.topic
    if not note_text:
        raise HTTPException(
            400, "Note is empty — write something in 'Action needed' or 'Topic' first."
        )

    # Roster the LLM can pick from for owner attribution.
    roster_rows = get_project_roster(db, n.project_id) if n.project_id else []
    roster = [
        {"full_name": r.full_name, "initials": r.initials, "organization": r.organization or ""}
        for r in roster_rows
    ]

    project = n.project
    context = (
        f"{project.client.name if project and project.client else ''} / "
        f"{project.name if project else ''}"
    )

    try:
        provider = get_provider()
        suggestion = provider.suggest_action_from_note(
            note_text=note_text,
            note_topic=n.topic or "",
            project_context=context,
            attendees_roster=roster,
        )
    except Exception as exc:
        raise HTTPException(502, f"LLM call failed: {exc}")

    if suggestion is None:
        # Provider couldn't parse / returned nothing — treat as informational.
        return SuggestedActionOut(
            text="",
            rationale="Couldn't extract a clear action from this note.",
        )
    return SuggestedActionOut(
        text=suggestion.text,
        owner=suggestion.owner,
        due_date=suggestion.due_date,
        rationale=suggestion.rationale,
    )
