"""/api/meetings/{id}/attachments and /api/attachments/* — PM-uploaded
supporting documents (site photos, vendor PDFs, sketch markups, contractor
emails) hanging off a meeting.

Physical bytes go through ``get_storage().save(...)`` — LocalFSBackend in
dev, SharePointBackend in prod — so the same router works regardless of
where files actually land. The DB row only stores metadata + the
storage path that came back.
"""
from __future__ import annotations

import logging
import uuid
from pathlib import PurePosixPath
from typing import Optional

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, UploadFile,
)
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_db_user, require_db_user
from core.deps import get_db
from core.services import safe_filename_slug
from db.models import Meeting, MeetingAttachment
from schemas.common import MeetingAttachmentOut
from storage import get_storage


logger = logging.getLogger(__name__)

# Reject obviously-dangerous uploads outright. PMs upload weird things
# (DWG, vendor catalogs, photos, raw email exports) so the allowlist is
# intentionally permissive — we only block the categories that pose a
# real risk if someone clicks the download link.
_BLOCKED_EXTENSIONS = {".exe", ".bat", ".cmd", ".ps1", ".sh"}
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB


router = APIRouter(tags=["attachments"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _safe_basename(filename: str) -> str:
    """Strip path components and disallowed characters from an upload's
    declared filename. Browsers usually send a bare basename but we don't
    trust the client — a malicious form could send '../../etc/passwd' and
    we don't want that anywhere near a storage call."""
    bare = PurePosixPath(filename.replace("\\", "/")).name or "file"
    return safe_filename_slug(bare) or "file"


def _validate_upload(file: UploadFile) -> None:
    """Run the cheap checks before we even read bytes."""
    name = (file.filename or "").lower()
    for ext in _BLOCKED_EXTENSIONS:
        if name.endswith(ext):
            raise HTTPException(
                status_code=400,
                detail=f"Files of type {ext} are not allowed.",
            )
    ctype = (file.content_type or "").lower()
    if ctype.startswith("text/html"):
        raise HTTPException(
            status_code=400,
            detail="HTML uploads are not allowed — paste links instead.",
        )


def _storage_path_for(meeting: Meeting, original_filename: str) -> str:
    """Build the ``<project_slug>/meeting_<id>/attachments/<uuid>_<name>``
    convention. The 8-char uuid prefix prevents collisions when two PMs
    upload the same-named file on the same meeting."""
    project_name = (
        meeting.project.name if meeting.project else f"project_{meeting.project_id}"
    )
    project_slug = safe_filename_slug(project_name)
    safe_name = _safe_basename(original_filename)
    uuid_prefix = uuid.uuid4().hex[:8]
    return (
        f"{project_slug}/meeting_{meeting.id}/attachments/"
        f"{uuid_prefix}_{safe_name}"
    )


# ---------------------------------------------------------------------------
# Per-meeting endpoints
# ---------------------------------------------------------------------------
@router.get(
    "/api/meetings/{meeting_id}/attachments",
    response_model=list[MeetingAttachmentOut],
)
def list_meeting_attachments(meeting_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Return attachments for a meeting, newest first."""
    meeting = db.get(Meeting, meeting_id)
    if not meeting:
        raise HTTPException(404, "Meeting not found")
    return sorted(
        meeting.attachments,
        key=lambda a: a.created_at or 0,
        reverse=True,
    )


@router.post(
    "/api/meetings/{meeting_id}/attachments",
    response_model=MeetingAttachmentOut,
    status_code=201,
)
async def upload_meeting_attachment(
    meeting_id: int,
    file: UploadFile = File(...),
    description: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    actor=Depends(get_current_db_user),
):
    """Upload a single file. Cap is 20 MB — anything bigger gets a 413 so
    the client can show a readable error instead of dying mid-transfer.

    We read the bytes once into memory (small enough at 20 MB) and hand
    them straight to ``get_storage().save(...)``. The returned path is
    persisted on the row alongside the original filename / MIME / size /
    optional description so the list endpoint can render rich metadata
    without a second storage round-trip.
    """
    meeting = db.get(Meeting, meeting_id)
    if not meeting:
        raise HTTPException(404, "Meeting not found")

    _validate_upload(file)

    # Read the upload. We use the cheap size cap rather than a streaming
    # multi-chunk read — 20 MB is well within the per-process memory
    # budget on every plan we deploy under.
    raw = await file.read()
    size = len(raw)
    if size > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"File is {size / (1024 * 1024):.1f} MB; the limit is "
                f"{_MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
            ),
        )
    if size == 0:
        raise HTTPException(400, "Uploaded file is empty.")

    original = file.filename or "file"
    rel_path = _storage_path_for(meeting, original)

    try:
        get_storage().save(rel_path, raw)
    except Exception as exc:
        logger.exception("Attachment upload failed for meeting %s", meeting_id)
        raise HTTPException(
            502, f"Storage backend rejected the upload: {exc}",
        )

    row = MeetingAttachment(
        meeting_id=meeting.id,
        filename=original,
        content_type=file.content_type or None,
        file_size_bytes=size,
        storage_path=rel_path,
        description=(description or "").strip() or None,
        created_by_id=actor.id if actor is not None else None,
    )
    db.add(row)
    db.flush()
    return row


# ---------------------------------------------------------------------------
# Per-attachment endpoints
# ---------------------------------------------------------------------------
@router.get("/api/attachments/{attachment_id}/download")
def download_attachment(attachment_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Stream the raw bytes back with the original filename so the browser
    saves "site_photo_3.jpg" instead of "8f3a91c2_site_photo_3.jpg".

    Returns 404 in two cases: (a) the row was deleted, or (b) the row
    exists but the backing file is gone (manual cleanup, SharePoint move,
    etc.). The user sees the same error either way — there's no useful
    information to surface in case (b)."""
    row = db.get(MeetingAttachment, attachment_id)
    if not row:
        raise HTTPException(404, "Attachment not found")
    try:
        data = get_storage().read(row.storage_path)
    except FileNotFoundError:
        raise HTTPException(404, "Attached file is missing from storage")
    except Exception as exc:
        logger.exception("Attachment read failed for id %s", attachment_id)
        raise HTTPException(
            404, f"Attached file is missing from storage: {exc}",
        )

    # ASCII-safe filename for the Content-Disposition header. We also emit
    # a UTF-8 filename* parameter so browsers that support it render the
    # original name accurately when it contained non-ASCII characters.
    from urllib.parse import quote
    safe_ascii = (row.filename or "file").encode("ascii", "ignore").decode() or "file"
    encoded = quote(row.filename or "file")
    disposition = (
        f'attachment; filename="{safe_ascii}"; filename*=UTF-8\'\'{encoded}'
    )

    def _iter():
        yield data

    return StreamingResponse(
        _iter(),
        media_type=row.content_type or "application/octet-stream",
        headers={"Content-Disposition": disposition},
    )


@router.delete("/api/attachments/{attachment_id}", status_code=204)
def delete_attachment(attachment_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Remove the row and make a best-effort attempt to delete the file
    from storage. Storage failures (file already gone, SharePoint hiccup,
    etc.) don't block the row delete — the DB is the source of truth for
    "is this attachment listed in the app" and we'd rather a stray byte
    in storage than a dangling DB row no one can clean up via the UI."""
    row = db.get(MeetingAttachment, attachment_id)
    if not row:
        raise HTTPException(404, "Attachment not found")

    storage_path = row.storage_path
    db.delete(row)
    db.flush()

    # Best-effort cleanup. LocalFSBackend doesn't currently expose a
    # `delete` method, so we touch the path directly when we can.
    try:
        backend = get_storage()
        deleter = getattr(backend, "delete", None)
        if callable(deleter):
            deleter(storage_path)
        else:
            # LocalFSBackend: storage_path is an absolute filesystem path.
            from pathlib import Path
            p = Path(storage_path)
            if p.is_file():
                p.unlink()
    except Exception:
        logger.warning(
            "Best-effort delete failed for attachment %s (path=%s)",
            attachment_id, storage_path, exc_info=True,
        )
    return None
