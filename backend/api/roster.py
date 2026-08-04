"""/api/roster — project + global attendee rosters.

Both rosters are `meeting_minutes` work — they exist to populate the attendee
list on a set of minutes — but they differ in scope, and the difference is real:

  * ``/project`` rows belong to one portfolio, so they take the permission AND
    membership of that portfolio.
  * ``/global`` is one company-wide address book with no portfolio to be a
    member of, so the permission alone is the gate (the same shape a standalone
    proposal takes in proposals.py). It is NOT `client_mgmt`: that defaults
    FALSE, and adding a name mid-capture is the single most common act in the
    app — gating it there would stop every PM on day one to protect a list that
    is additive, one row deep, and re-typeable. Nor is it `user_mgmt`: these are
    contacts, not accounts, and that permission opens the people console.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import require_db_user
from auth.permissions import MEETING_MINUTES, require_permission
from core.deps import get_db
from db.models import ProjectAttendee, GlobalAttendee
from db.repository import get_project_roster, upsert_project_attendee
from schemas.common import AttendeeOut, AttendeeIn, GlobalAttendeeOut


class AttendeePatch(BaseModel):
    """Partial-update payload for an attendee — every field is optional."""
    full_name: Optional[str] = None
    initials: Optional[str] = None
    organization: Optional[str] = None
    email: Optional[str] = None

router = APIRouter(prefix="/api/roster", tags=["roster"])

# Names a param the /global routes do not have, so `require_permission` resolves
# "no portfolio" and gates on the permission alone. Explicit rather than relying
# on the default finding nothing: the default also reads the QUERY string, so a
# stray ?project_id= would otherwise attach a membership check to an endpoint
# that has no portfolio — it could only ever refuse a legitimate caller.
_NO_PORTFOLIO = "portfolio_id"


@router.get("/global", response_model=list[GlobalAttendeeOut])
def list_global(db: Session = Depends(get_db), _user=Depends(require_db_user)):
    return (
        db.query(GlobalAttendee)
        .order_by(GlobalAttendee.full_name)
        .all()
    )


@router.post("/global", response_model=GlobalAttendeeOut, status_code=201)
def add_global(
    payload: AttendeeIn, db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES, _NO_PORTFOLIO)),
):
    """Add a name to the company-wide address book.

    THE PERMISSION IS THE WHOLE GATE — deliberately, not by omission. Holding
    `meeting_minutes` while belonging to zero portfolios is enough to write
    here, because there is no portfolio on a company-wide list for membership
    to be checked against; `_NO_PORTFOLIO` makes that explicit instead of
    leaving the dependency to find nothing. Do not "fix" this into a membership
    check: `guard.require_project` 403s on a missing portfolio, so any wiring
    that reached it would refuse every caller. It is still strictly tighter than
    the bare `require_db_user` these routes shipped with.
    """
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


@router.patch("/global/{member_id}", response_model=GlobalAttendeeOut)
def patch_global(
    member_id: int, payload: AttendeePatch, db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES, _NO_PORTFOLIO)),
):
    """Rename/retag a global contact.

    `meeting_minutes` alone is the gate, by decision — see ``add_global`` for
    why a company-wide list has no membership half to enforce. There is no
    portfolio on the row to scope this to, so ``guard.require_project`` has
    nothing to be handed.
    """
    m = db.get(GlobalAttendee, member_id)
    if not m:
        raise HTTPException(404, "Global member not found")
    if payload.full_name is not None:
        m.full_name = payload.full_name
    if payload.initials is not None:
        m.initials = payload.initials
    if payload.organization is not None:
        m.organization = payload.organization or None
    if payload.email is not None:
        m.email = payload.email or None
    db.flush()
    return m


@router.delete("/global/{member_id}", status_code=204)
def delete_global(
    member_id: int, db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES, _NO_PORTFOLIO)),
):
    """Drop a contact from the company-wide address book.

    The widest of the three, and still `meeting_minutes` alone — see
    ``add_global``. Accepted knowingly: the row is one name with no dependents
    (project rosters copy values, they do not FK to this table), so the blast
    radius is a re-typeable line in a shared list, not project data.
    """
    m = db.get(GlobalAttendee, member_id)
    if not m:
        raise HTTPException(404, "Global member not found")
    db.delete(m)


@router.get("/project", response_model=list[AttendeeOut])
def list_project_roster(
    project_id: int = Query(...),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    return get_project_roster(db, project_id)


@router.post("/project", response_model=AttendeeOut, status_code=201)
def add_to_project(
    payload: AttendeeIn,
    project_id: int = Query(...),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    # `project_id` is a query param, so the dependency resolves and membership-
    # checks it before this body runs — and it is the same value the upsert
    # writes to, so there is no second portfolio to disagree with it.
    a = upsert_project_attendee(
        db,
        project_id=project_id,
        full_name=payload.full_name,
        initials=payload.initials,
        organization=payload.organization or "",
        email=payload.email or "",
    )
    return a


@router.patch("/project/{attendee_id}", response_model=AttendeeOut)
def patch_project_attendee(
    attendee_id: int,
    payload: AttendeePatch,
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    a = db.get(ProjectAttendee, attendee_id)
    if not a:
        raise HTTPException(404, "Attendee not found")
    # Scope off the loaded row — the attendee's own portfolio is where this
    # edit lands, and the URL carries nothing else that could be trusted for it.
    guard.require_project(a.project_id)
    if payload.full_name is not None:
        a.full_name = payload.full_name
    if payload.initials is not None:
        a.initials = payload.initials
    if payload.organization is not None:
        a.organization = payload.organization or None
    if payload.email is not None:
        a.email = payload.email or None
    db.flush()
    return a


@router.delete("/project/{attendee_id}", status_code=204)
def delete_from_project(
    attendee_id: int, db: Session = Depends(get_db),
    _user=Depends(require_db_user),
    guard=Depends(require_permission(MEETING_MINUTES)),
):
    a = db.get(ProjectAttendee, attendee_id)
    if not a:
        raise HTTPException(404, "Attendee not found")
    guard.require_project(a.project_id)
    db.delete(a)
