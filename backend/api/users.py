"""/api/users — per-user settings.

Currently exposes get / set for the user's `preferences` JSON blob.
All endpoints require a signed-in user (``require_db_user``) because
preferences are inherently per-identity. Anonymous callers get 401.

The frontend layer should fall back to hardcoded defaults if these
endpoints fail (e.g. unauthenticated) so the rest of the app keeps
working without a sign-in.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from auth import get_current_db_user, require_db_user
from core.deps import get_db
from db.models import User as UserModel
from schemas.common import UserPreferences, UserStub


router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=list[UserStub])
def list_users(
    q: str = Query("", description=(
        "Optional case-insensitive substring filter on name or email. "
        "Empty returns all users — fine for our small team size."
    )),
    # The ceiling has to clear what the pickers actually ask for. OwnerPicker
    # fetches the whole team once and filters client-side, so it requests 500;
    # while this capped at 200 that request 422'd and the caller's .catch()
    # swallowed it, leaving the User-table source silently empty in every
    # picker on the app — no "PM" chip, and owner_user_id never populated.
    limit: int = Query(20, ge=1, le=1000),
    include_inactive: bool = Query(False, description=(
        "Include deactivated users. Off by default so offboarded people stop "
        "being offered as action owners."
    )),
    db: Session = Depends(get_db),
    _actor=Depends(get_current_db_user),
) -> list[UserStub]:
    """Lightweight directory of known PMO 360 users — drives the action-
    owner typeahead picker on Actions + Review.

    Scope: every signed-in PM can see the full team list. This is the same
    visibility the existing Manage Team modal offers, so no new privacy
    surface. Anonymous callers go through ``get_current_db_user`` and
    get an empty list (the auth dep returns None silently, so we skip
    the body).

    Deactivated users are filtered out by default: offboarding is meant to
    take someone out of circulation, and a picker that still offers them
    quietly assigns new work to a person who can no longer sign in. The
    escape hatch is ``include_inactive`` — the admin console reads the
    richer ``/api/admin/users`` instead, which always lists everyone so an
    admin can reactivate.
    """
    if _actor is None:
        return []
    rows = db.query(UserModel)
    if not include_inactive:
        rows = rows.filter(UserModel.is_active.is_(True))
    needle = q.strip().lower()
    if needle:
        rows = rows.filter(
            or_(
                UserModel.name.ilike(f"%{needle}%"),
                UserModel.email.ilike(f"%{needle}%"),
            )
        )
    rows = rows.order_by(UserModel.name).limit(limit).all()
    return [UserStub(id=r.id, name=r.name, email=r.email) for r in rows]


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
