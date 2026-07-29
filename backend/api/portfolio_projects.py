"""/api/portfolio-projects — the "Project" tier (a site under a Portfolio).

A PortfolioProject belongs to a Portfolio (the ``projects`` table) and is what a
proposal links to via ``Proposal.project_id`` (the proposal's portfolio is then
derived). Scoped to proposals for now; meetings/schedules/change-orders still
attach to the Portfolio directly.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import require_db_user
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
):
    if not db.get(Project, payload.portfolio_id):
        raise HTTPException(404, "Portfolio not found")
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
):
    pp = _get(db, ppid)
    if payload.expected_version is not None and pp.version != payload.expected_version:
        raise HTTPException(409, detail={
            "error": "stale_version",
            "message": "This project was changed by someone else. Reload first.",
            "current_version": pp.version,
        })
    if payload.portfolio_id is not None:
        if not db.get(Project, payload.portfolio_id):
            raise HTTPException(404, "Portfolio not found")
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
):
    pp = _get(db, ppid)
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
