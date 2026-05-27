"""/api/projects/{id}/members and /api/project-members/{id}

Manages who's assigned as a PM to a portfolio. Multiple PMs per portfolio
allowed, no role distinction. Admins (User.is_admin) implicitly access
every project regardless of explicit membership.

Routes:
  GET    /api/projects/{project_id}/members        list members
  POST   /api/projects/{project_id}/members        add a member (by user_id or email)
  DELETE /api/project-members/{member_id}          remove a member
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_db_user
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
def get_project_members(project_id: int, db: Session = Depends(get_db)):
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
):
    row = db.get(ProjectMember, member_id)
    if row is None:
        raise HTTPException(404, "Member not found")
    remove_project_member(db, member_id)
    return None
