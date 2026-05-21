"""/api/projects — projects (portfolios) under a client."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import Project, Client
from db.repository import list_projects, get_project, set_portfolio_sub_projects
from schemas.common import ProjectOut, ProjectCreate, ProjectUpdate

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectOut])
def get_projects(
    client_id: int = Query(..., description="Parent client id"),
    db: Session = Depends(get_db),
):
    return list_projects(db, client_id)


@router.get("/{project_id}", response_model=ProjectOut)
def get_one(project_id: int, db: Session = Depends(get_db)):
    project = get_project(db, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return project


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)):
    client = db.get(Client, payload.client_id)
    if not client:
        raise HTTPException(404, "Parent client not found")
    project = Project(
        client_id=payload.client_id,
        name=payload.name,
        scope=payload.scope,
        schedule_version=payload.schedule_version or "V1",
        sub_projects_json=payload.sub_projects_json or [],
    )
    db.add(project)
    db.flush()
    return project


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(project_id: int, payload: ProjectUpdate, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if payload.name is not None:
        project.name = payload.name
    if payload.scope is not None:
        project.scope = payload.scope
    if payload.schedule_version is not None:
        project.schedule_version = payload.schedule_version
    if payload.sub_projects_json is not None:
        set_portfolio_sub_projects(db, project_id, payload.sub_projects_json)
    db.flush()
    return project


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    db.delete(project)
    return None
