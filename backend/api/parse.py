"""/api/parse — run the LLM provider on raw meeting notes, plus a small
transcript-upload helper that mirrors the Streamlit Capture page's
"Upload a transcript file" zone.
"""
import io
import re

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
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
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return ParsedMeetingOut.model_validate(parsed.model_dump())


# ============================================================
# Transcript upload — extracts plain text from txt/md/docx/vtt.
# Mirrors the upload zone behaviour on the Streamlit Capture page,
# where the extracted text is dropped into the "Meeting minutes"
# textarea.
# ============================================================
_VTT_TIMESTAMP_RE = re.compile(
    r"^\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->\s+\d{2}:\d{2}(?::\d{2})?\.\d{3}.*$"
)


def _extract_vtt_text(raw: str) -> str:
    """Strip WEBVTT headers, cue numbers, and timestamp lines into clean
    dialogue lines so the LLM doesn't choke on metadata noise."""
    lines = raw.splitlines()
    out: list[str] = []
    for ln in lines:
        s = ln.strip()
        if not s or s == "WEBVTT" or s.startswith("NOTE "):
            continue
        if _VTT_TIMESTAMP_RE.match(s):
            continue
        if s.isdigit():  # cue number
            continue
        out.append(ln.rstrip())
    return "\n".join(out).strip()


@router.post("/transcript")
async def parse_transcript(file: UploadFile = File(...)):
    """Accept a raw transcript file and return the extracted plain text.

    Supported formats: .txt, .md, .docx, .vtt. The client drops the file
    on the Capture page and we hand back the text the user can drop into
    the "Meeting minutes" textarea.
    """
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    name = (file.filename or "").lower()
    ext = name.rsplit(".", 1)[-1] if "." in name else ""

    text: str
    if ext == "docx":
        try:
            import mammoth  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise HTTPException(500, "mammoth is not installed on the server") from exc
        result = mammoth.extract_raw_text(io.BytesIO(data))
        text = (result.value or "").strip()
    else:
        try:
            decoded = data.decode("utf-8", errors="ignore")
        except Exception as exc:
            raise HTTPException(400, f"Could not decode file: {exc}") from exc
        text = _extract_vtt_text(decoded) if ext == "vtt" else decoded.strip()

    return {
        "filename": file.filename,
        "format": ext or "txt",
        "char_count": len(text),
        "text": text,
    }
