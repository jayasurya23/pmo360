"""/api/admin/users — the user console behind Settings.

Lists everyone who has ever signed into PMO 360 and lets a console operator
edit the permission grid: job title, department, the eight grantable
permissions, admin, active/offboarded, and portfolio assignment.

**Every route here is `require_user_console`.** Hiding the Settings tab in the
SPA is presentation; this module is the actual boundary. Somebody who
hand-crafts `PATCH /api/admin/users/3 {"is_admin": true}` must get a 403 and
nothing else.

Portfolio assignment is NOT here on purpose — `api/members.py` already owns
POST/DELETE for ProjectMember and duplicating it would give us two code paths
to keep in sync. The GET here embeds each user's current memberships so the
admin table renders in one round-trip; mutations go to the members router.

Two tiers of caller reach this router:
  - a full **admin**, who implicitly holds every permission (the super-role,
    and the thing the ADMIN_EMAILS floor exists to protect), and
  - a holder of the **`user_mgmt`** permission, who gets the same console
    without the super-role.
The second tier is why the guards below distinguish `actor.is_admin` from
"reached this route at all": a user_mgmt holder must not be able to mint an
admin, or edit one, because that would route straight around the super-role.

Guards on PATCH, all of which exist to stop the team being locked out or a
privilege boundary being stepped over:
  - only an admin can grant or revoke admin
  - only an admin can change anything about an admin
  - you cannot demote or deactivate yourself
  - you cannot revoke your own console access
  - you cannot revoke an ADMIN_EMAILS (env-floor) admin
  - you cannot remove the last remaining active admin
Each refuses with its own message — "you cannot do that" with no reason is a
support call.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import require_db_user
from auth.permissions import (
    PERMISSIONS,
    PERMISSIONS_BY_NAME,
    USER_MGMT,
    effective_permissions,
    has_permission,
    verify_permission_model,
)
from core.deps import get_db
from db.models import Client, Project, ProjectMember, User
from schemas.common import (
    AdminUserGridOut,
    AdminUserOut,
    AdminUserPortfolioOut,
    AdminUserUpdate,
    PermissionDefOut,
    UserPermissionsOut,
    split_display_name,
)

try:  # pragma: no cover - the auth owner's export is landing in parallel
    from auth import is_env_floor_admin
except ImportError:
    # TEMPORARY SHIM — delete once auth/ exports the helper. It delegates to
    # the same `_admin_email_set()` the upsert path uses, so the env var is
    # still parsed in exactly one place; only the predicate is duplicated.
    from auth.dependencies import _admin_email_set

    def is_env_floor_admin(email: str | None) -> bool:
        return bool(email) and email.strip().lower() in _admin_email_set()


# auth/permissions.py owns the vocabulary and every ENFORCEMENT gate; this
# router only EDITS the grid. Same boot-time assertion the gated routers get, so
# a deployment whose model and vocabulary have drifted refuses to start here too
# rather than serving a column the grid can write and nothing ever reads.
verify_permission_model()

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
    first, last = split_display_name(row.name)
    return AdminUserOut(
        id=row.id,
        oid=row.oid,
        name=row.name,
        email=row.email,
        first_name=first,
        last_name=last,
        title=row.title,
        department=row.department,
        is_admin=bool(row.is_admin),
        is_active=bool(row.is_active),
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
        is_env_admin=is_env_floor_admin(row.email),
        # EFFECTIVE, not the raw columns: an admin's row comes back all-ticked
        # because the super-role really does grant all eight. Folding that in
        # here rather than in the grid keeps the admin bypass in one place.
        permissions=UserPermissionsOut(**effective_permissions(row)),
        portfolios=portfolios,
    )


def require_user_console(actor: User = Depends(require_db_user)) -> User:
    """Identity for the user console: a full admin, or a `user_mgmt` holder.

    `user_mgmt` is deliberately not a second admin flag — it opens this console
    and nothing else. What it cannot do is enforced per-target in `update_user`
    rather than here, because the difference only shows up against a specific
    row (you may edit a PM, never an admin).

    `has_permission` reads the DB row, so a revoke made in Settings takes
    effect on the target's very next request — no token refresh, no cache.
    """
    if has_permission(actor, USER_MGMT):
        return actor
    raise HTTPException(
        403,
        'Your account does not have the "User Mgmt" permission (user_mgmt), '
        "which is required to view or edit the user console. Ask an "
        "administrator to grant it in Settings -> Users.",
    )


def _active_admin_count(db: Session, exclude_user_id: int | None = None) -> int:
    """How many admins would still be able to sign in. Deactivated admins
    don't count — they can't reach the console, so they're not a way back in.
    `exclude_user_id` answers "how many are left if this one changes?"."""
    q = db.query(User).filter(User.is_admin.is_(True), User.is_active.is_(True))
    if exclude_user_id is not None:
        q = q.filter(User.id != exclude_user_id)
    return q.count()


@router.get("", response_model=AdminUserGridOut)
def list_users(db: Session = Depends(get_db), _actor: User = Depends(require_user_console)):
    """The whole grid: the eight column definitions plus a row per person.

    Column defs ride along so the header renders from the server's vocabulary
    rather than a hardcoded copy of it — the grid can then never offer a
    checkbox for a permission the backend does not enforce.

    Console-only: this is the one place that exposes `is_admin` / `is_active` /
    the grant map for other people, which is exactly the map an attacker would
    want.
    """
    rows = db.query(User).order_by(User.name, User.email).all()
    memberships = _memberships_by_user(db)
    return AdminUserGridOut(
        permissions=[
            PermissionDefOut(name=p.name, label=p.label, scope=p.scope)
            for p in PERMISSIONS
        ],
        users=[_to_out(r, memberships.get(r.id, [])) for r in rows],
    )


@router.patch("/{user_id}", response_model=AdminUserOut)
def update_user(
    user_id: int,
    payload: AdminUserUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_user_console),
):
    """Edit one row of the permission grid.

    We never delete the row: the user authored meetings, owns actions and is
    stamped on created_by/updated_by across the schema. Deactivating keeps all
    of that intact while the auth dependency stops honouring their token.
    """
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(404, "User not found")

    # `exclude_none` is the contract from AdminUserUpdate: a null flag means
    # "leave this one alone", so only the boxes actually toggled land here. That
    # is what stops two checkboxes ticked a second apart from racing to write
    # the whole map and clobbering each other.
    permission_patch: dict[str, bool] = (
        payload.permissions.model_dump(exclude_none=True)
        if payload.permissions is not None
        else {}
    )
    if (
        payload.is_admin is None
        and payload.is_active is None
        and payload.title is None
        and payload.department is None
        and not permission_patch
    ):
        raise HTTPException(
            422,
            "Send is_admin, is_active, title, department and/or permissions "
            "to change.",
        )
    unknown = sorted(set(permission_patch) - set(PERMISSIONS_BY_NAME))
    if unknown:
        # Belt and braces: the schema only has the eight fields, so this can
        # only fire if the vocabulary and the schema drift. Refusing beats
        # writing a column nothing enforces.
        raise HTTPException(422, f"Unknown permission(s): {', '.join(unknown)}")

    # `actor` comes from a different session than `target`, so compare ids —
    # the two ORM objects are never the same instance even for the same user.
    is_self = actor.id == target.id
    actor_is_admin = bool(actor.is_admin)
    label = target.email or target.name or f"user {target.id}"

    # ---- the admin/user_mgmt boundary -------------------------------------
    # A user_mgmt holder runs the console but does not outrank the super-role.
    # Without these two, they could mint themselves an admin (or offboard every
    # admin) and the ADMIN_EMAILS floor would be the only thing left.
    if payload.is_admin is not None and not actor_is_admin:
        raise HTTPException(
            403,
            "Only an administrator can grant or revoke admin. You can edit "
            "permissions, title and department for non-admin users.",
        )
    if bool(target.is_admin) and not actor_is_admin:
        raise HTTPException(
            403,
            f"{label} is an administrator, and an administrator's access can "
            "only be changed by another administrator.",
        )

    revoking_admin = payload.is_admin is False and bool(target.is_admin)
    deactivating = payload.is_active is False and bool(target.is_active)

    # Losing your own console access locks you out of the screen you are on —
    # the same trap the self-demote guard below covers, one tier down. Admins
    # are exempt because the super-role grants the console regardless.
    if (
        is_self
        and not actor_is_admin
        and permission_patch.get("user_mgmt") is False
    ):
        raise HTTPException(
            400,
            "You cannot remove your own user-management access — you would "
            "lose this screen with no way back. Ask an administrator.",
        )

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
    # Trimmed but NOT collapsed to NULL: "" is a real value here, the way an
    # admin says "Entra's title is wrong, leave it blank", which the directory
    # sync is expected to leave alone. NULL keeps meaning "never learned".
    if payload.title is not None:
        target.title = payload.title.strip()
    if payload.department is not None:
        target.department = payload.department.strip()
    for name, granted in permission_patch.items():
        # The column name comes off the vocabulary rather than being spelled
        # out here, so a renamed permission can't half-land — and so the only
        # attributes this loop can ever reach are the eight real ones.
        setattr(target, PERMISSIONS_BY_NAME[name].column, bool(granted))
    db.flush()

    memberships = _memberships_by_user(db)
    return _to_out(target, memberships.get(target.id, []))
