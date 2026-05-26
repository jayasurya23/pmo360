"""/api/me — returns the currently-authenticated user.

Used by the frontend to confirm the backend recognizes its Bearer token
after MSAL sign-in. Returns 401 when the token is missing/invalid, so the
SPA can show an "auth broken" error toast if something's misconfigured.

Also serves as the canonical guarded-route reference — any future route
that needs a user just copies the `Depends(require_user)` pattern.
"""
from fastapi import APIRouter, Depends

from auth.dependencies import require_user, User

router = APIRouter(prefix="/api", tags=["auth"])


@router.get("/me", response_model=User)
def whoami(user: User = Depends(require_user)) -> User:
    """Echo the signed-in user back. 401 if no valid token was sent."""
    return user
