"""/api/roster — project + global attendee rosters."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import ProjectAttendee, GlobalAttendee
from db.repository import get_project_roster, upsert_project_attendee
from schemas.common import AttendeeOut, AttendeeIn, GlobalAttendeeOut

router = APIRouter(prefix="/api/roster", tags=["roster"])


@router.get("/global", response_model=list[GlobalAttendeeOut])
def list_global(db: Session = Depends(get_db)):
    return (
        db.query(GlobalAttendee)
        .order_by(GlobalAttendee.full_name)
        .all()
    )


@router.post("/global", response_model=GlobalAttendeeOut, status_code=201)
def add_global(payload: AttendeeIn, db: Session = Depends(get_db)):
    existing = db.query(GlobalAttendee).filter_by(full_name=payload.full_name).first()
    if existing:
        raise HTTPException(409, "Member already on the global roster")
    member = GlobalAttendee(
        full_name=payload.full_name,
        initials=payload.initials,
        organization=payload.organization or None,
        email=payload.email or None,
    )
    db.add(member)
    db.flush()
    return member


@router.delete("/global/{member_id}", status_code=204)
def delete_global(member_id: int, db: Session = Depends(get_db)):
    m = db.get(GlobalAttendee, member_id)
    if not m:
        raise HTTPException(404, "Global member not found")
    db.delete(m)


@router.get("/project", response_model=list[AttendeeOut])
def list_project_roster(
    project_id: int = Query(...),
    db: Session = Depends(get_db),
):
    return get_project_roster(db, project_id)


@router.post("/project", response_model=AttendeeOut, status_code=201)
def add_to_project(
    payload: AttendeeIn,
    project_id: int = Query(...),
    db: Session = Depends(get_db),
):
    a = upsert_project_attendee(
        db,
        project_id=project_id,
        full_name=payload.full_name,
        initials=payload.initials,
        organization=payload.organization or "",
        email=payload.email or "",
    )
    return a


@router.delete("/project/{attendee_id}", status_code=204)
def delete_from_project(attendee_id: int, db: Session = Depends(get_db)):
    a = db.get(ProjectAttendee, attendee_id)
    if not a:
        raise HTTPException(404, "Attendee not found")
    db.delete(a)
