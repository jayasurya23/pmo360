"""/api/me — returns the currently-authenticated user.

Used by the frontend to confirm the backend recognizes its Bearer token
after MSAL sign-in. Returns 401 when the token is missing/invalid, so the
SPA can show an "auth broken" error toast if something's misconfigured.

Returns the DB-backed MeOut (with `id` + `is_admin` + the caller's effective
permissions) so the SPA can default the scope toggle ("mine" vs "all") based
on admin status, key membership/dashboard queries off the canonical user id,
and grey out the buttons the backend would refuse anyway.
"""
from fastapi import APIRouter, Depends

from auth.dependencies import get_db_user_any_status
from auth.permissions import effective_permissions
from schemas.common import MeOut, UserPermissionsOut

router = APIRouter(prefix="/api", tags=["auth"])


@router.get("/me", response_model=MeOut)
def whoami(user=Depends(get_db_user_any_status)) -> MeOut:
    """Echo the signed-in user back. 401 if no valid token was sent.

    The row is upsert-ed here on first sign-in, and ``is_admin`` comes from
    the database — ADMIN_EMAILS only seeds a new row and acts as a floor that
    can raise privilege back, never lower it.

    Deliberately the ONE route a deactivated user may still read
    (``get_db_user_any_status`` rather than ``require_db_user``). They still
    hold a valid Entra token, so the SPA's auth gate lets them in; without an
    answer here the frontend would treat them as anonymous and render the whole
    app shell with every other call 403-ing and nothing explaining why. Getting
    back ``is_active: false`` is what lets it say "your access was removed"
    instead. Safe because this returns only the caller's own row.

    Built by hand rather than validated off the ORM row: ``permissions`` must be
    the EFFECTIVE map (admins implicitly hold all eight), which the raw `can_*`
    columns are not. Same reason ``MeOut`` is not ``UserOut`` — that model is
    embedded as created_by/updated_by on nearly every response, and permissions
    there would ship every user's access rights on every payload.
    """
    return MeOut(
        id=user.id,
        oid=user.oid,
        email=user.email,
        name=user.name,
        is_admin=bool(user.is_admin),
        is_active=bool(user.is_active),
        title=user.title,
        department=user.department,
        permissions=UserPermissionsOut(**effective_permissions(user)),
    )
