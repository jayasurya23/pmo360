"""/api/documents — generate / preview / download / finalize meeting docs."""
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import Meeting, GeneratedDocument
from core.services import build_meeting_docs, finalize_meeting


router = APIRouter(prefix="/api/documents", tags=["documents"])


@router.get("/meeting/{meeting_id}")
def download_meeting_doc(
    meeting_id: int,
    kind: str = Query("pdf", pattern="^(pdf|docx|xlsx)$"),
    draft: bool = Query(True),
    db: Session = Depends(get_db),
):
    """Stream the generated minutes PDF / DOCX or the action-items XLSX for
    this meeting. The file is built in memory each call — no disk write."""
    m = db.get(Meeting, meeting_id)
    if not m:
        raise HTTPException(404, "Meeting not found")
    docs = build_meeting_docs(db, m, draft=draft)
    doc = docs.get(kind)
    if doc is None:
        raise HTTPException(400, f"Unsupported kind: {kind}")
    return Response(
        content=doc["bytes"],
        media_type=doc["content_type"],
        headers={"Content-Disposition": f'attachment; filename="{doc["filename"]}"'},
    )


@router.post("/meeting/{meeting_id}/finalize")
def finalize(meeting_id: int, db: Session = Depends(get_db)):
    m = db.get(Meeting, meeting_id)
    if not m:
        raise HTTPException(404, "Meeting not found")
    paths = finalize_meeting(db, m)
    return {"paths": paths, "stage": m.stage}


@router.get("/file")
def fetch_finalized_file(path: str = Query(...)):
    """Stream a file written by ``finalize_meeting`` from local storage. The
    response includes the correct content-type so the browser previews PDFs
    inline and prompts a save for docx / xlsx."""
    p = Path(path)
    if not p.is_file():
        raise HTTPException(404, "File not found")
    ext = p.suffix.lower().lstrip(".")
    mime = {
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }.get(ext, "application/octet-stream")
    return Response(
        content=p.read_bytes(),
        media_type=mime,
        headers={"Content-Disposition": f'attachment; filename="{p.name}"'},
    )
