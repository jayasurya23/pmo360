"""/api/documents — generate / preview / download / finalize meeting docs."""
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from auth import require_db_user
from config import local_output_dir
from core.deps import get_db
from db.models import Meeting, GeneratedDocument
from core.services import build_meeting_docs, finalize_meeting


router = APIRouter(prefix="/api/documents", tags=["documents"])


@router.get("/meeting/{meeting_id}")
def download_meeting_doc(
    meeting_id: int,
    kind: str = Query("pdf", pattern="^(pdf|docx|xlsx|zip)$"),
    draft: bool = Query(True),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Stream the generated minutes PDF / DOCX or the action-items XLSX for this
    meeting — or a ZIP bundling all of them (kind=zip). Built in memory each
    call; no disk write."""
    m = db.get(Meeting, meeting_id)
    if not m:
        raise HTTPException(404, "Meeting not found")
    docs = build_meeting_docs(db, m, draft=draft)
    if kind == "zip":
        import io
        import re
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for d in docs.values():
                zf.writestr(d["filename"], d["bytes"])
        base = (
            re.sub(r"[^A-Za-z0-9._-]+", "_", (m.title or f"meeting-{m.id}").strip())
            or f"meeting-{m.id}"
        )
        return Response(
            content=buf.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{base}.zip"'},
        )
    doc = docs.get(kind)
    if doc is None:
        raise HTTPException(400, f"Unsupported kind: {kind}")
    return Response(
        content=doc["bytes"],
        media_type=doc["content_type"],
        headers={"Content-Disposition": f'attachment; filename="{doc["filename"]}"'},
    )


@router.post("/meeting/{meeting_id}/finalize")
def finalize(meeting_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    m = db.get(Meeting, meeting_id)
    if not m:
        raise HTTPException(404, "Meeting not found")
    paths = finalize_meeting(db, m)
    return {"paths": paths, "stage": m.stage}


@router.get("/file")
def fetch_finalized_file(path: str = Query(...), _user=Depends(require_db_user)):
    """Stream a file written by ``finalize_meeting`` from local storage. The
    response includes the correct content-type so the browser previews PDFs
    inline and prompts a save for docx / xlsx.

    ``path`` is caller-supplied, so it is resolved and confined to the local
    output directory. Without that check this endpoint is an arbitrary-file
    read of anything the process can open — including the backend's own .env.
    """
    root = local_output_dir().resolve()
    try:
        p = Path(path).resolve()
        p.relative_to(root)
    except (ValueError, OSError):
        # Outside the output directory (or an unresolvable path). Report it as
        # missing rather than forbidden so this can't be used to probe the
        # filesystem for which paths exist.
        raise HTTPException(404, "File not found")
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
