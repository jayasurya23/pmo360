"""/api/users — per-user settings.

Currently exposes get / set for the user's `preferences` JSON blob.
All endpoints require a signed-in user (``require_db_user``) because
preferences are inherently per-identity. Anonymous callers get 401.

The frontend layer should fall back to hardcoded defaults if these
endpoints fail (e.g. unauthenticated) so the rest of the app keeps
working without a sign-in.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import require_db_user
from core.deps import get_db
from schemas.common import UserPreferences


router = APIRouter(prefix="/api/users", tags=["users"])


def _coerce_prefs(raw) -> UserPreferences:
    """Normalize whatever's stored in ``User.preferences`` (None / dict /
    legacy shape) into a fully-populated UserPreferences with the schema's
    defaults filled in. Pydantic validation handles missing keys for us."""
    if not isinstance(raw, dict):
        return UserPreferences()
    return UserPreferences(**raw)


@router.get("/me/preferences", response_model=UserPreferences)
def get_my_prefs(actor=Depends(require_db_user)) -> UserPreferences:
    """Read the signed-in user's preferences. Returns defaults if none
    have been saved yet."""
    return _coerce_prefs(actor.preferences)


@router.put("/me/preferences", response_model=UserPreferences)
def set_my_prefs(
    payload: UserPreferences,
    actor=Depends(require_db_user),
    db: Session = Depends(get_db),
) -> UserPreferences:
    """Merge `payload` onto the user's existing preferences and persist.

    We merge rather than replace so a partial frontend update (e.g. only
    sending email_signature) doesn't nuke unrelated fields. Since
    UserPreferences fills missing fields with defaults, the merge is
    expressed as `existing → payload`: payload wins on conflict.
    """
    existing = _coerce_prefs(actor.preferences).model_dump()
    incoming = payload.model_dump()
    merged = {**existing, **incoming}
    # Re-validate the merged dict so we always store a canonical, fully
    # populated shape (and surface bad input as a 422 if Pydantic complains).
    canonical = UserPreferences(**merged)
    # SQLAlchemy needs a brand-new dict to detect the JSON change reliably
    # (mutating in place doesn't always flag the attribute dirty for JSON
    # columns on SQLite).
    actor.preferences = canonical.model_dump()
    db.add(actor)
    db.flush()
    return canonical
