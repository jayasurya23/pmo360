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
support call. They live in `_refusal_for` as VALUES rather than raises, so the
bulk route can ask the same policy about eight people without a second copy of
it existing to drift.

POST /bulk applies one grant/revoke across many rows and is ALL-OR-NOTHING —
see `bulk_update_permissions` for why partial application was rejected.

POST /provision creates the row for someone who has not signed in yet. The
identity key there is load-bearing enough to have its own essay; read it before
touching it.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, null
from sqlalchemy.orm import Session

from auth import require_db_user
from auth.permissions import (
    DEFAULT_GRANTS,
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
    AdminBulkPermissionsIn,
    AdminBulkRefusalOut,
    AdminUserGridOut,
    AdminUserOut,
    AdminUserPortfolioOut,
    AdminUserProvisionIn,
    AdminUserUpdate,
    PermissionDefOut,
    UserPermissionsOut,
    UserPermissionsPatch,
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


def _refusal_for(
    db: Session,
    actor: User,
    target: User,
    payload: AdminUserUpdate,
    permission_patch: dict[str, bool],
) -> tuple[int, str] | None:
    """Every policy guard on a grid edit, returned instead of raised.

    A value rather than an exception because the bulk route has to ask this
    question about eight people and report ALL the answers; raising would let
    it report only the first. `update_user` re-raises immediately, so the
    single-row behaviour is byte-identical to what it was — this is the same
    policy read twice, not a policy and a copy of it.

    Returns `(status_code, detail)` or None when the edit is allowed.
    """
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
        return (
            403,
            "Only an administrator can grant or revoke admin. You can edit "
            "permissions, title and department for non-admin users.",
        )
    if bool(target.is_admin) and not actor_is_admin:
        return (
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
        return (
            400,
            "You cannot remove your own user-management access — you would "
            "lose this screen with no way back. Ask an administrator.",
        )

    # The other direction, which the guards above missed: a user_mgmt holder
    # ticking their OWN boxes. Every guard here blocks locking yourself OUT;
    # none blocked granting yourself MORE. So the office-manager persona this
    # console was written for could open their own row, tick the seven
    # non-admin permissions, and walk away holding client_mgmt -- the sole gate
    # on DELETE /api/clients and DELETE /api/projects, both of which cascade.
    # is_admin stays false throughout, so nothing on the screen shows it
    # happened. Granting is an administrator's act; running the console is not.
    if is_self and not actor_is_admin and any(permission_patch.values()):
        granting = sorted(k for k, v in permission_patch.items() if v)
        return (
            403,
            "You cannot grant yourself access. Ask an administrator to change "
            f"your own permissions ({', '.join(granting)}). You can still "
            "manage everyone else from here.",
        )

    if revoking_admin:
        if is_self:
            return (
                400,
                "You cannot revoke your own admin access. Ask another "
                "administrator to do it, so you can't lock yourself out by "
                "accident.",
            )
        if is_env_floor_admin(target.email):
            return (
                409,
                f"{label} is listed in the ADMIN_EMAILS environment variable, "
                "which is the permanent admin floor. Remove them from "
                "ADMIN_EMAILS and redeploy first, then revoke here.",
            )
        if _active_admin_count(db, exclude_user_id=target.id) == 0:
            return (
                409,
                f"{label} is the last active administrator. Grant admin to "
                "someone else first, or nobody will be able to administer "
                "PMO 360.",
            )

    if deactivating:
        if is_self:
            return (
                400,
                "You cannot deactivate your own account — you would be signed "
                "out with no way back in. Ask another administrator.",
            )
        if is_env_floor_admin(target.email):
            return (
                409,
                f"{label} is listed in ADMIN_EMAILS and is always an "
                "administrator. Remove them from ADMIN_EMAILS and redeploy "
                "before offboarding them here.",
            )
        # Deactivating an admin removes an admin just as surely as revoking
        # the flag does, so the last-admin floor has to hold on this path too.
        if bool(target.is_admin) and _active_admin_count(db, exclude_user_id=target.id) == 0:
            return (
                409,
                f"{label} is the last active administrator. Grant admin to "
                "someone else before deactivating them.",
            )

    return None


def _apply_permission_patch(target: User, permission_patch: dict[str, bool]) -> None:
    """Write the ticked boxes onto the row.

    The column name comes off the vocabulary rather than being spelled out
    here, so a renamed permission can't half-land — and so the only attributes
    this loop can ever reach are the eight real ones.
    """
    for name, granted in permission_patch.items():
        setattr(target, PERMISSIONS_BY_NAME[name].column, bool(granted))


def _validate_permission_names(names) -> None:
    """422 on a permission the backend does not enforce.

    On PATCH this is belt and braces (the schema has exactly the eight
    fields). On the bulk route it is the real check: that payload is an open
    ``{name: bool}`` map, and Pydantic would drop a typo'd key silently —
    reporting "8 users updated" having written nothing at all.
    """
    unknown = sorted(set(names) - set(PERMISSIONS_BY_NAME))
    if unknown:
        raise HTTPException(422, f"Unknown permission(s): {', '.join(unknown)}")


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
    _validate_permission_names(permission_patch)

    refusal = _refusal_for(db, actor, target, payload, permission_patch)
    if refusal is not None:
        raise HTTPException(*refusal)

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
    _apply_permission_patch(target, permission_patch)
    db.flush()

    memberships = _memberships_by_user(db)
    return _to_out(target, memberships.get(target.id, []))


@router.post("/bulk", response_model=list[AdminUserOut])
def bulk_update_permissions(
    payload: AdminBulkPermissionsIn,
    db: Session = Depends(get_db),
    actor: User = Depends(require_user_console),
):
    """Apply one grant/revoke across several rows. ALL-OR-NOTHING.

    Staffing eight people one checkbox at a time is the complaint this route
    answers, so the question that matters is what happens when part of the
    batch is refusable.

    We refuse the whole batch, and the reasoning is not squeamishness:

    * A permission change has to have ONE answer to "did that land?". Partial
      application makes the honest answer "for five of them", which is a
      sentence nobody reads off a toast and nobody can act on afterwards
      without re-reading the grid row by row — i.e. exactly the work this
      route exists to remove.
    * Partial application is worth its cost when refusals are unpredictable.
      Here they are not: every guard below keys off `is_admin`, `is_env_admin`
      and the actor's own id, all three of which the grid already holds from
      GET /api/admin/users. The UI can grey the row out before anyone clicks,
      so the batch that reaches us should be clean and a refusal is a genuine
      "stop and look".
    * It keeps ONE policy. PATCH refuses a row; this refuses a batch; both ask
      `_refusal_for`. A partial mode would need its own notion of success and
      would be the second place the rules could drift.

    The cost of all-or-nothing is whack-a-mole — untick the bad row, retry,
    get refused on the next one — so we pay that off by evaluating EVERY
    target before writing anything and returning the complete refusal list in
    one 409. The `detail` carries a human `message` (which the SPA's error
    handler already surfaces) plus a structured `refusals` array so the grid
    can mark the exact rows.

    Returns the updated rows in the grid's own shape, so the caller splices
    them in rather than refetching.
    """
    _validate_permission_names(payload.permissions)

    # Dedupe but keep the caller's order, so the returned rows line up with
    # the order the grid sent — a set() here would shuffle them.
    ordered_ids = list(dict.fromkeys(payload.user_ids))
    found = {u.id: u for u in db.query(User).filter(User.id.in_(ordered_ids)).all()}

    # AdminUserUpdate is what `_refusal_for` reads, so the bulk payload is
    # re-expressed as one: same policy, same input shape, no second dialect.
    patch = AdminUserUpdate(permissions=UserPermissionsPatch(**payload.permissions))
    permission_patch = patch.permissions.model_dump(exclude_none=True)

    refusals: list[AdminBulkRefusalOut] = []
    targets: list[User] = []
    for user_id in ordered_ids:
        target = found.get(user_id)
        if target is None:
            # A stale grid, almost certainly. Reported alongside the policy
            # refusals rather than as a bare 404 so the admin sees the whole
            # picture in one pass instead of one problem per retry.
            refusals.append(AdminBulkRefusalOut(
                user_id=user_id,
                label=f"user {user_id}",
                reason="No such user — the grid may be out of date. Reload it.",
            ))
            continue
        refusal = _refusal_for(db, actor, target, patch, permission_patch)
        if refusal is not None:
            refusals.append(AdminBulkRefusalOut(
                user_id=target.id,
                label=target.email or target.name or f"user {target.id}",
                reason=refusal[1],
            ))
            continue
        targets.append(target)

    if refusals:
        names = ", ".join(r.label for r in refusals)
        raise HTTPException(409, {
            "error": "bulk_refused",
            "message": (
                f"Nothing was changed. {len(refusals)} of {len(ordered_ids)} "
                f"selected people cannot be edited this way ({names}). "
                "Deselect them and try again."
            ),
            "refusals": [r.model_dump() for r in refusals],
        })

    for target in targets:
        _apply_permission_patch(target, permission_patch)
    db.flush()

    memberships = _memberships_by_user(db)
    return [_to_out(t, memberships.get(t.id, [])) for t in targets]


# 8-4-4-4-12 hex — the shape every Entra object id has.
_GUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


@router.post("/provision", response_model=AdminUserOut, status_code=201)
def provision_user(
    payload: AdminUserProvisionIn,
    db: Session = Depends(get_db),
    _actor: User = Depends(require_user_console),
):
    """Create the `users` row for a colleague who has never signed in.

    ---- THE IDENTITY KEY, which is the only hard part here ----

    `auth/dependencies.py::_upsert_user_row` finds the existing row with
    ``filter_by(oid=jwt_user.oid)`` and NOTHING else — not email, not name. So
    a row provisioned under any other key is a ghost: the person signs in, the
    upsert finds nothing, inserts a SECOND row with default grants, and the
    permissions an admin set on day one sit forever on a row that will never
    authenticate. Nothing in the console shows that happened; the admin sees
    the name they added and assumes it worked.

    `jwt_user.oid` is the token's `oid` claim, which Entra documents as the
    user's tenant-stable directory object id. The directory picker reads
    Graph ``/users``, whose `id` is that same object id (see
    `frontend/src/lib/graph.ts::DirectoryUser.id`). They are the same value,
    so `oid` is the right key and the picker already has it.

    NOTE FOR WHOEVER TOUCHES THE PICKER: there is no backend Graph proxy. The
    SPA calls ``https://graph.microsoft.com/v1.0/users`` directly with a
    delegated User.Read.All token, so this `oid` arrives from the client and
    we cannot re-derive it server-side. That is inside the existing trust
    boundary — the caller already holds `user_mgmt`, cannot set `is_admin`
    here, and the worst a wrong value produces is a dead row that matches
    nobody — but it is why the format check below is strict rather than
    polite. An `oid` that is silently wrong is undetectable; an `oid` that is
    loudly refused is a support ticket. Refuse.

    ---- What the new row starts with ----

    The standard six, i.e. `DEFAULT_GRANTS` — identical to what the same
    person would have got by simply signing in. Provisioning is meant to be a
    no-op with respect to access: it pre-creates the row that was coming
    anyway, so nobody's permissions depend on whether an admin happened to get
    there first. Starting from nothing would also hand the admin the eight
    checkboxes per new hire that this whole screen is trying to abolish.
    """
    from datetime import datetime

    oid = payload.oid.strip()
    email = payload.email.strip()
    name = payload.name.strip()

    # Entra object ids are GUIDs, always. A non-GUID here is overwhelmingly an
    # admin (or a caller) passing the wrong field — a UPN, a display name, a
    # Graph @odata.id — and that mistake produces precisely the invisible
    # ghost row described above. Loud and recoverable beats silent.
    if not _GUID_RE.fullmatch(oid):
        raise HTTPException(
            422,
            f"{oid!r} is not a Microsoft Entra object id. It must be the "
            "directory GUID (the `id` field on the Graph user record), not an "
            "email address or a name — the sign-in path matches on that GUID "
            "and nothing else, so any other value silently creates a second "
            "account for this person on their first sign-in.",
        )

    existing_oid = db.query(User).filter(User.oid == oid).first()
    if existing_oid is not None:
        label = existing_oid.email or existing_oid.name or f"user {existing_oid.id}"
        raise HTTPException(
            409,
            f"{label} already has a PMO 360 account (same Entra object id). "
            "Edit their existing row instead — reactivate it if they were "
            "offboarded.",
        )
    # The collision that actually happens: the admin doesn't spot that the
    # person is already in a 40-row grid and adds them again. Caught here
    # rather than by the `oid` unique constraint, because the duplicate has a
    # DIFFERENT oid (it is a genuinely different directory entry, or a typo
    # in one of the two) and the constraint would let it through.
    # `func.lower(...) ==`, NOT `ilike`: an email may legally contain `_`, which
    # LIKE reads as a single-character wildcard. `first_last@castillo.com` would
    # then collide with `firstXlast@castillo.com` and refuse a perfectly good
    # provision with a 409 nobody could explain.
    existing_email = (
        db.query(User).filter(func.lower(User.email) == email.lower()).first()
        if email else None
    )
    if existing_email is not None:
        raise HTTPException(
            409,
            f"{email} already has a PMO 360 account under a different Entra "
            f"object id ({existing_email.oid}). Two rows for one person means "
            "one of them silently stops receiving their permissions — check "
            "the directory entry before adding this one.",
        )

    now = datetime.utcnow()
    row = User(
        oid=oid,
        # Deliberately not format-validated. `oid` is the identity; email and
        # name are denormalized display copies that `_upsert_user_row` refreshes
        # from the token on every sign-in, so a wrong one self-heals. The GUID
        # check above is where strictness earns its keep.
        email=email,
        name=name,
        title=(payload.title or "").strip() or None,
        department=(payload.department or "").strip() or None,
        # Mirrors the insert branch of `_upsert_user_row`: an ADMIN_EMAILS
        # address is forced admin on its first request anyway, so seeding it
        # here means the grid tells the truth immediately instead of showing a
        # non-admin row for someone who is about to be one.
        is_admin=is_env_floor_admin(email),
        is_active=True,
        created_at=now,
        # `null()`, NOT `None`. They have never signed in, and
        # `User.last_seen_at` carries `default=datetime.utcnow` — SQLAlchemy
        # reads a None attribute as "unset" and fires that default, so passing
        # None here stamps the row "last seen just now". That is both false and
        # destroys the one signal an admin has for "did this person actually
        # come on board?". `null()` is an explicit SQL NULL and skips the
        # default. (Caught by the probe; it is not a theoretical distinction.)
        last_seen_at=null(),
        previous_last_seen_at=None,
    )
    for perm_name, granted in DEFAULT_GRANTS.items():
        setattr(row, PERMISSIONS_BY_NAME[perm_name].column, granted)
    db.add(row)
    db.flush()

    # No portfolios: the row is brand new, so there is nothing to look up.
    return _to_out(row, [])
