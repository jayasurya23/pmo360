"""/api/projects/{id}/members and /api/project-members/{id}

Manages who's assigned as a PM to a portfolio. Multiple PMs per portfolio
allowed, no role distinction. Admins (User.is_admin) implicitly access
every project regardless of explicit membership.

**The two mutations here are admin-only.** ProjectMember is what the
membership filter reads, so writing to this table grants or removes access to
a portfolio's meetings, actions, proposals and change orders. Gated on
`require_db_user` it let any signed-in PM assign themselves to any portfolio,
which is a data-access hole, not a convenience. Membership assignment is user
management and lives with the rest of it, behind `require_admin`.

Reading the roster stays open to any signed-in user: knowing who is on your
team is not a privileged fact, and the ContextSwitcher renders it inline.

Routes:
  GET    /api/projects/{project_id}/members        list members    (any user)
  POST   /api/projects/{project_id}/members        add a member    (admin)
  DELETE /api/project-members/{member_id}          remove a member (admin)
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_admin, require_db_user
from core.deps import get_db
from db.models import Project, ProjectMember, User
from db.repository import (
    add_project_member, list_project_members, remove_project_member,
)
from schemas.common import ProjectMemberOut


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
    actor: User = Depends(require_admin),
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
    _actor: User = Depends(require_admin),
):
    row = db.get(ProjectMember, member_id)
    if row is None:
        raise HTTPException(404, "Member not found")
    remove_project_member(db, member_id)
    return None
