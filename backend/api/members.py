"""/api/projects/{id}/members and /api/project-members/{id}

Manages who's assigned as a PM to a portfolio. Multiple PMs per portfolio
allowed, no role distinction. Admins (User.is_admin) implicitly access
every project regardless of explicit membership.

**The two mutations here take the `user_mgmt` permission.** ProjectMember is
what the membership filter reads, so writing to this table grants or removes
access to a portfolio's meetings, actions, proposals and change orders. Gated on
`require_db_user` it let any signed-in PM assign themselves to any portfolio,
which is a data-access hole, not a convenience.

Why `user_mgmt` and not the portfolio-scoped permissions: deciding who may work
on a portfolio is not portfolio work, it is *deciding who the people are* — the
same console job as granting a permission or deactivating an account, and
useless if split from it (someone who can grant permissions but not membership
can never finish onboarding anyone). It is therefore global: the permission is
checked, portfolio membership is NOT, because requiring membership would mean an
administrator had to first add themselves to a portfolio in order to staff it.
Admins hold `user_mgmt` implicitly, so this is a strict widening of the previous
`require_admin` — nobody who could do this before loses the ability.

Reading the roster stays open to any signed-in user: knowing who is on your
team is not a privileged fact, and the ContextSwitcher renders it inline.

Routes:
  GET    /api/projects/{project_id}/members        list members    (any user)
  POST   /api/projects/{project_id}/members        add a member    (user_mgmt)
  DELETE /api/project-members/{member_id}          remove a member (user_mgmt)
  POST   /api/admin/memberships/bulk               staff N x M     (user_mgmt)

The bulk route carries a warning the single-row ones never needed — see
`bulk_memberships`. Writing to this table can change who may write to a
portfolio *without touching anybody's permissions*, and the direction of that
change is not the one people expect.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_db_user
from auth.permissions import USER_MGMT, require_permission
from core.deps import get_db
from db.models import Client, Project, ProjectMember, User
from db.repository import (
    add_project_member, list_project_members, remove_project_member,
)
from schemas.common import (
    AdminBulkMembershipIn,
    AdminBulkMembershipOut,
    MembershipFlipOut,
    ProjectMemberOut,
)


router = APIRouter(tags=["members"])


class AddMemberRequest(BaseModel):
    """Either user_id OR email must be present. Email triggers an Entra-oid
    lookup against an existing User row; if no row matches, we 404 — the
    user must sign in at least once first so a User row gets created."""
    user_id: Optional[int] = None
    email: Optional[str] = None


@router.get(
    "/api/projects/{project_id}/members",
    response_model=list[ProjectMemberOut],
)
def get_project_members(project_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    """Deliberately not admin-gated — a PM needs to see who else is on their
    portfolio, and the roster carries no privilege beyond names and emails.
    Each row reports `user_is_active` so a member who has since been
    offboarded reads as offboarded instead of quietly disappearing."""
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return list_project_members(db, project_id)


@router.post(
    "/api/projects/{project_id}/members",
    response_model=ProjectMemberOut,
    status_code=201,
)
def add_member(
    project_id: int,
    payload: AddMemberRequest,
    db: Session = Depends(get_db),
    actor: User = Depends(require_db_user),
    guard=Depends(require_permission(USER_MGMT)),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    if payload.user_id is None and not (payload.email or "").strip():
        raise HTTPException(
            400, "Provide either user_id or email in the request body.",
        )

    if payload.user_id is not None:
        target = db.get(User, payload.user_id)
    else:
        # Lookup by email (case-insensitive). Falls back to UPN equality.
        email = payload.email.strip().lower()
        target = (
            db.query(User)
            .filter(User.email.ilike(email))
            .first()
        )

    if target is None:
        raise HTTPException(
            404,
            "User not found. They need to sign into PMO 360 once before they "
            "can be added to a portfolio.",
        )

    if not target.is_active:
        # Offboarding is supposed to be terminal. Granting a portfolio to a
        # deactivated account would leave a live-looking assignment nobody can
        # use, and it would reappear in every roster the moment they were
        # reactivated for an unrelated reason.
        label = target.email or target.name or f"user {target.id}"
        raise HTTPException(
            409,
            f"{label} has been deactivated and cannot be assigned to a "
            "portfolio. Reactivate them in Settings → Users first.",
        )

    row = add_project_member(
        db, project_id=project_id, user_id=target.id,
        created_by_id=actor.id,
    )
    return row


@router.delete("/api/project-members/{member_id}", status_code=204)
def delete_member(
    member_id: int,
    db: Session = Depends(get_db),
    actor: User = Depends(require_db_user),
    guard=Depends(require_permission(USER_MGMT)),
):
    row = db.get(ProjectMember, member_id)
    if row is None:
        raise HTTPException(404, "Member not found")
    remove_project_member(db, member_id)
    return None


def _member_counts(db: Session, project_ids: list[int]) -> dict[int, int]:
    """How many members each of these portfolios has. One grouped query."""
    from sqlalchemy import func

    rows = (
        db.query(ProjectMember.project_id, func.count(ProjectMember.id))
        .filter(ProjectMember.project_id.in_(project_ids))
        .group_by(ProjectMember.project_id)
        .all()
    )
    counts = {pid: 0 for pid in project_ids}
    counts.update({pid: n for pid, n in rows})
    return counts


@router.post("/api/admin/memberships/bulk", response_model=AdminBulkMembershipOut)
def bulk_memberships(
    payload: AdminBulkMembershipIn,
    db: Session = Depends(get_db),
    actor: User = Depends(require_db_user),
    guard=Depends(require_permission(USER_MGMT)),
):
    """Assign or unassign N people across M portfolios in one call.

    Gated identically to the single-row routes above — `user_mgmt`, global, no
    portfolio-membership check — for the reason in the module docstring: an
    administrator would otherwise have to join a portfolio before being
    allowed to staff it.

    ---- `flipped` NO LONGER MEANS WHAT ITS NAME SUGGESTS ----

    It was added when a portfolio with zero members counted as *unowned* and
    was governed by the permission alone, so crossing zero in either direction
    silently granted or revoked write access for everyone else. That rule is
    gone — Castillo's instruction is that every PM reaches every portfolio, so
    `auth/permissions.py::is_portfolio_member` is disabled and membership now
    affects NO authorization decision.

    The field still ships, and still reports the portfolios that crossed zero,
    because assignment continues to drive the Mine/all filter, the dashboard
    scope toggle and Manage Team: a portfolio going from nobody to somebody is
    a real change in whose dashboard it shows up on. But it is a visibility
    report now, not a security one, and any UI copy warning that assigning
    somebody "limits" a portfolio to them is wrong.

    ---- Idempotency ----

    Re-adding an existing assignment and removing one that was never there are
    both no-ops counted in `skipped`, not errors. The admin ticks eight people
    and four portfolios; working out which of the 32 pairs already exist is
    the app's job, not theirs.

    ---- Refusals ----

    All-or-nothing, matching POST /api/admin/users/bulk: a bad id or a
    deactivated person refuses the whole batch with the complete list, rather
    than half-staffing a portfolio and reporting it in a toast.
    """
    user_ids = list(dict.fromkeys(payload.user_ids))
    project_ids = list(dict.fromkeys(payload.project_ids))
    adding = payload.action == "add"

    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()}
    projects = {
        p.id: p for p in db.query(Project).filter(Project.id.in_(project_ids)).all()
    }

    problems: list[str] = []
    for uid in user_ids:
        user = users.get(uid)
        if user is None:
            problems.append(f"user {uid} does not exist")
        elif adding and not user.is_active:
            # Same rule as the single-row add, and for the same reason: an
            # assignment on a deactivated account is a live-looking grant
            # nobody can use, which reappears the moment they are reactivated
            # for an unrelated reason. Removal is deliberately NOT blocked —
            # offboarding someone should not strand their assignments.
            label = user.email or user.name or f"user {uid}"
            problems.append(f"{label} has been deactivated")
    for pid in project_ids:
        if pid not in projects:
            problems.append(f"portfolio {pid} does not exist")
    if problems:
        raise HTTPException(409, {
            "error": "bulk_refused",
            "message": (
                "Nothing was changed. " + "; ".join(problems) + ". "
                "The grid may be out of date — reload it and try again."
            ),
            "refusals": problems,
        })

    before = _member_counts(db, project_ids)

    # One query for every pair we might touch, so "does this assignment
    # already exist?" costs one round-trip rather than one per pair.
    existing: set[tuple[int, int]] = {
        (pid, uid)
        for pid, uid in db.query(ProjectMember.project_id, ProjectMember.user_id)
        .filter(
            ProjectMember.project_id.in_(project_ids),
            ProjectMember.user_id.in_(user_ids),
        )
        .all()
    }

    added = removed = skipped = 0
    if adding:
        for pid in project_ids:
            for uid in user_ids:
                if (pid, uid) in existing:
                    skipped += 1
                    continue
                # The snapshot above is a round-trip optimisation, not the
                # correctness guarantee: uq_project_members_project_user is,
                # and add_project_member absorbs the refusal if a pair appears
                # between the snapshot and now.
                add_project_member(db, project_id=pid, user_id=uid, created_by_id=actor.id)
                added += 1
    else:
        rows = (
            db.query(ProjectMember)
            .filter(
                ProjectMember.project_id.in_(project_ids),
                ProjectMember.user_id.in_(user_ids),
            )
            .all()
        )
        for row in rows:
            db.delete(row)
        # One row per pair, guaranteed by uq_project_members_project_user, so a
        # row count IS an assignment count. The de-duplicating count this used
        # to do existed only because a historical double-insert would otherwise
        # have reported "removed 2" for one logical assignment; the migration
        # that added the constraint cleared those rows.
        removed = len(rows)
        skipped = len(project_ids) * len(user_ids) - removed
    db.flush()

    after = _member_counts(db, project_ids)
    client_names = {
        cid: name
        for cid, name in db.query(Client.id, Client.name).filter(
            Client.id.in_({p.client_id for p in projects.values() if p.client_id})
        ).all()
    }
    flipped = [
        MembershipFlipOut(
            project_id=pid,
            project_name=projects[pid].name,
            client_name=client_names.get(projects[pid].client_id),
            members_before=before[pid],
            members_after=after[pid],
            became_scoped=before[pid] == 0 and after[pid] > 0,
            became_unowned=before[pid] > 0 and after[pid] == 0,
        )
        for pid in project_ids
        if (before[pid] == 0) != (after[pid] == 0)
    ]
    return AdminBulkMembershipOut(
        added=added, removed=removed, skipped=skipped, flipped=flipped,
    )
