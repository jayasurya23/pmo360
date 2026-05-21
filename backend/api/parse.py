"""/api/parse — run the LLM provider on raw meeting notes."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core.deps import get_db
from core.services import parse_notes_with_ai
from db.models import Project
from schemas.common import ParseRequest, ParsedMeetingOut


router = APIRouter(prefix="/api/parse", tags=["parse"])


@router.post("", response_model=ParsedMeetingOut)
def parse_notes(payload: ParseRequest, db: Session = Depends(get_db)):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    roster_dicts = (
        [r.model_dump() for r in payload.attendees_roster]
        if payload.attendees_roster else None
    )

    try:
        parsed = parse_notes_with_ai(
            minutes_text=payload.minutes_text or "",
            agenda_text=payload.agenda_text or "",
            actions_text=payload.actions_text or "",
            project=project,
            attendees_roster=roster_dicts,
        )
    except RuntimeError as exc:
        # OpenAI key missing / network error / invalid JSON
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return ParsedMeetingOut.model_validate(parsed.model_dump())
