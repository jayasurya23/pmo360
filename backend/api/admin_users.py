"""/api/admin/users — the admin-only user console.

Lists everyone who has ever signed into PMO 360 and lets an admin grant or
revoke admin, and activate or offboard an account.

**Every route here is `require_admin`.** Hiding the Settings tab in the SPA is
presentation; this module is the actual boundary. A non-admin who hand-crafts
`PATCH /api/admin/users/3 {"is_admin": true}` must get a 403 and nothing else.

Portfolio assignment is NOT here on purpose — `api/members.py` already owns
POST/DELETE for ProjectMember and duplicating it would give us two code paths
to keep in sync. The GET here embeds each user's current memberships so the
admin table renders in one round-trip; mutations go to the members router.

Guards on PATCH, all of which exist to stop an admin locking the team out:
  - you cannot demote or deactivate yourself
  - you cannot revoke an ADMIN_EMAILS (env-floor) admin
  - you cannot remove the last remaining active admin
Each refuses with its own message — "you cannot do that" with no reason is a
support call.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import require_admin
from core.deps import get_db
from db.models import Client, Project, ProjectMember, User
from schemas.common import AdminUserOut, AdminUserPortfolioOut, AdminUserUpdate

try:  # pragma: no cover - the auth owner's export is landing in parallel
    from auth import is_env_floor_admin
except ImportError:
    # TEMPORARY SHIM — delete once auth/ exports the helper. It delegates to
    # the same `_admin_email_set()` the upsert path uses, so the env var is
    # still parsed in exactly one place; only the predicate is duplicated.
    from auth.dependencies import _admin_email_set

    def is_env_floor_admin(email: str | None) -> bool:
        return bool(email) and email.strip().lower() in _admin_email_set()


router = APIRouter(prefix="/api/admin/users", tags=["admin"])


def _memberships_by_user(db: Session) -> dict[int, list[AdminUserPortfolioOut]]:
    """Every ProjectMember row, joined to Project + Client, bucketed by user.

    One query for the whole table rather than one per user — the admin table
    renders every row's portfolio chips at once, and an N+1 there would be a
    query per employee on a page nobody paginates.
    """
    rows = (
        db.query(
            ProjectMember.id,
            ProjectMember.user_id,
            Project.id,
            Project.name,
            Client.name,
        )
        .join(Project, Project.id == ProjectMember.project_id)
        .outerjoin(Client, Client.id == Project.client_id)
        .order_by(Client.name, Project.name)
        .all()
    )
    out: dict[int, list[AdminUserPortfolioOut]] = {}
    for member_id, user_id, project_id, project_name, client_name in rows:
        out.setdefault(user_id, []).append(
            AdminUserPortfolioOut(
                member_id=member_id,
                project_id=project_id,
                project_name=project_name,
                client_name=client_name,
            )
        )
    return out


def _to_out(row: User, portfolios: list[AdminUserPortfolioOut]) -> AdminUserOut:
    return AdminUserOut(
        id=row.id,
        oid=row.oid,
        name=row.name,
        email=row.email,
        is_admin=bool(row.is_admin),
        is_active=bool(row.is_active),
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        is_env_admin=is_env_floor_admin(row.email),
        portfolios=portfolios,
    )


def _active_admin_count(db: Session, exclude_user_id: int | None = None) -> int:
    """How many admins would still be able to sign in. Deactivated admins
    don't count — they can't reach the console, so they're not a way back in.
    `exclude_user_id` answers "how many are left if this one changes?"."""
    q = db.query(User).filter(User.is_admin.is_(True), User.is_active.is_(True))
    if exclude_user_id is not None:
        q = q.filter(User.id != exclude_user_id)
    return q.count()


@router.get("", response_model=list[AdminUserOut])
def list_users(db: Session = Depends(get_db), _actor: User = Depends(require_admin)):
    """The staff directory with roles, status and portfolio assignments.

    Admin-only: this is the one place that exposes `is_admin` / `is_active`
    for other people, which is exactly the map an attacker would want.
    """
    rows = db.query(User).order_by(User.name, User.email).all()
    memberships = _memberships_by_user(db)
    return [_to_out(r, memberships.get(r.id, [])) for r in rows]


@router.patch("/{user_id}", response_model=AdminUserOut)
def update_user(
    user_id: int,
    payload: AdminUserUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    """Grant/revoke admin and activate/deactivate an account.

    We never delete the row: the user authored meetings, owns actions and is
    stamped on created_by/updated_by across the schema. Deactivating keeps all
    of that intact while the auth dependency stops honouring their token.
    """
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(404, "User not found")

    if payload.is_admin is None and payload.is_active is None:
        raise HTTPException(422, "Send is_admin and/or is_active to change.")

    # `actor` comes from a different session than `target`, so compare ids —
    # the two ORM objects are never the same instance even for the same user.
    is_self = actor.id == target.id
    label = target.email or target.name or f"user {target.id}"

    revoking_admin = payload.is_admin is False and bool(target.is_admin)
    deactivating = payload.is_active is False and bool(target.is_active)

    if revoking_admin:
        if is_self:
            raise HTTPException(
                400,
                "You cannot revoke your own admin access. Ask another "
                "administrator to do it, so you can't lock yourself out by "
                "accident.",
            )
        if is_env_floor_admin(target.email):
            raise HTTPException(
                409,
                f"{label} is listed in the ADMIN_EMAILS environment variable, "
                "which is the permanent admin floor. Remove them from "
                "ADMIN_EMAILS and redeploy first, then revoke here.",
            )
        if _active_admin_count(db, exclude_user_id=target.id) == 0:
            raise HTTPException(
                409,
                f"{label} is the last active administrator. Grant admin to "
                "someone else first, or nobody will be able to administer "
                "PMO 360.",
            )

    if deactivating:
        if is_self:
            raise HTTPException(
                400,
                "You cannot deactivate your own account — you would be signed "
                "out with no way back in. Ask another administrator.",
            )
        if is_env_floor_admin(target.email):
            raise HTTPException(
                409,
                f"{label} is listed in ADMIN_EMAILS and is always an "
                "administrator. Remove them from ADMIN_EMAILS and redeploy "
                "before offboarding them here.",
            )
        # Deactivating an admin removes an admin just as surely as revoking
        # the flag does, so the last-admin floor has to hold on this path too.
        if bool(target.is_admin) and _active_admin_count(db, exclude_user_id=target.id) == 0:
            raise HTTPException(
                409,
                f"{label} is the last active administrator. Grant admin to "
                "someone else before deactivating them.",
            )

    if payload.is_admin is not None:
        target.is_admin = payload.is_admin
    if payload.is_active is not None:
        target.is_active = payload.is_active
    db.flush()

    memberships = _memberships_by_user(db)
    return _to_out(target, memberships.get(target.id, []))
