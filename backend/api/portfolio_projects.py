"""/api/portfolio-projects — the "Project" tier (a site under a Portfolio).

A PortfolioProject belongs to a Portfolio (the ``projects`` table) and is what a
proposal links to via ``Proposal.project_id`` (the proposal's portfolio is then
derived). Scoped to proposals for now; meetings/schedules/change-orders still
attach to the Portfolio directly.

Writes take `proposals` + membership of the owning Portfolio: this tier exists
to hang proposals off, and DELETE below re-writes Proposal rows directly, so it
is the same permission that gates the proposals it moves. The portfolio always
comes from ``PortfolioProject.portfolio_id`` — the stored row on an edit, the
payload only on a true create — never from whatever the request nominates.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import require_db_user
from auth.permissions import PROPOSALS, require_permission
from db.models import PortfolioProject, Project, Proposal
from schemas.common import (
    PortfolioProjectOut, PortfolioProjectCreate, PortfolioProjectUpdate,
)

router = APIRouter(prefix="/api/portfolio-projects", tags=["portfolio-projects"])


def _get(db: Session, ppid: int) -> PortfolioProject:
    pp = db.get(PortfolioProject, ppid)
    if not pp:
        raise HTTPException(404, "Project not found")
    return pp


@router.get("", response_model=list[PortfolioProjectOut])
def list_portfolio_projects(
    portfolio_id: Optional[int] = Query(None),
    client_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    q = db.query(PortfolioProject)
    if portfolio_id is not None:
        q = q.filter(PortfolioProject.portfolio_id == portfolio_id)
    if client_id is not None:
        q = q.join(Project, PortfolioProject.portfolio_id == Project.id).filter(
            Project.client_id == client_id
        )
    return q.order_by(PortfolioProject.name).all()


@router.post("", response_model=PortfolioProjectOut, status_code=201)
def create_portfolio_project(
    payload: PortfolioProjectCreate,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(PROPOSALS)),
):
    if not db.get(Project, payload.portfolio_id):
        raise HTTPException(404, "Portfolio not found")
    # A true create: the requested portfolio IS where the new row lands. It
    # arrives in the JSON body, which the dependency's path/query resolution
    # cannot see, so narrow the scope here. Ordered after the 404 so a bad id
    # still reads as "no such portfolio" rather than "not yours".
    guard.require_project(payload.portfolio_id)
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(422, "Project name is required")
    pp = PortfolioProject(
        portfolio_id=payload.portfolio_id,
        name=name,
        location=payload.location,
        state=payload.state,
        size_mw=payload.size_mw,
        created_by_id=actor.id if actor else None,
        updated_by_id=actor.id if actor else None,
    )
    db.add(pp)
    db.flush()
    return pp


@router.patch("/{ppid}", response_model=PortfolioProjectOut)
def update_portfolio_project(
    ppid: int,
    payload: PortfolioProjectUpdate,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(PROPOSALS)),
):
    pp = _get(db, ppid)
    # Scope comes off the LOADED row: this is where the edit lands today.
    guard.require_project(pp.portfolio_id)
    if payload.expected_version is not None and pp.version != payload.expected_version:
        raise HTTPException(409, detail={
            "error": "stale_version",
            "message": "This project was changed by someone else. Reload first.",
            "current_version": pp.version,
        })
    if payload.portfolio_id is not None:
        if not db.get(Project, payload.portfolio_id):
            raise HTTPException(404, "Portfolio not found")
        # Re-homing writes to BOTH portfolios — it removes the project from one
        # and adds it to the other — so the destination is checked too. Source
        # alone would let a member of A push their sites into B.
        guard.require_project(payload.portfolio_id)
        pp.portfolio_id = payload.portfolio_id
    for f in ("name", "location", "state", "size_mw"):
        val = getattr(payload, f)
        if val is not None:
            setattr(pp, f, val.strip() if f == "name" else val)
    pp.updated_by_id = actor.id if actor else None
    pp.version = (pp.version or 1) + 1
    db.flush()
    return pp


@router.delete("/{ppid}", status_code=204)
def delete_portfolio_project(
    ppid: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
    guard=Depends(require_permission(PROPOSALS)),
):
    pp = _get(db, ppid)
    guard.require_project(pp.portfolio_id)
    # Null dangling proposal pointers first (mirrors the portfolio-delete handler
    # that nulls Proposal.portfolio_id) so deleting a Project never orphans a FK.
    # is_active_for_project has to clear in the same statement: the partial
    # unique index is scoped to project_id IS NOT NULL, so a left-behind True is
    # perfectly legal and would silently make the proposal active again the
    # moment someone re-links it to another project.
    db.query(Proposal).filter(Proposal.project_id == ppid).update(
        {Proposal.project_id: None, Proposal.is_active_for_project: False},
        synchronize_session=False,
    )
    db.delete(pp)
    return None
