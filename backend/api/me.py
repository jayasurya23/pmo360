"""/api/me — returns the currently-authenticated user.

Used by the frontend to confirm the backend recognizes its Bearer token
after MSAL sign-in. Returns 401 when the token is missing/invalid, so the
SPA can show an "auth broken" error toast if something's misconfigured.

Returns the DB-backed UserOut (with `id` + `is_admin`) so the SPA can
default the scope toggle ("mine" vs "all") based on admin status and key
membership/dashboard queries off the canonical user id.
"""
from fastapi import APIRouter, Depends

from auth.dependencies import require_db_user
from schemas.common import UserOut

router = APIRouter(prefix="/api", tags=["auth"])


@router.get("/me", response_model=UserOut)
def whoami(user=Depends(require_db_user)) -> UserOut:
    """Echo the signed-in user back. 401 if no valid token was sent.

    Goes through ``require_db_user`` so the row is upsert-ed on first
    sign-in and ``is_admin`` is recomputed from ``ADMIN_EMAILS`` on every
    request — flipping the env doesn't need a restart.
    """
    return user
