"""/api/timeline — Timeline Estimator: resource-loaded capacity planner.

Standalone module (not tied to the meeting Client/Project tables). Three
entities:
  - resources   : the engineer rows (or free-text placeholders), grouped by
                  discipline; optionally linked to a User.
  - projects    : standalone projects (name/client/status).
  - assignments : the bars — a project (optionally one discipline/milestone
                  slice of it) on a resource over a date range at some
                  % utilization.

GET /board does the heavy lift: it buckets the horizon into Monday-start weeks
(each week = 5 working days = the "500-point" cell) and computes, per resource
per week, the utilization load = Σ (workdays_overlap / 5) × utilization. The
frontend flags any cell whose load exceeds 1.0 as over-allocated.

All endpoints require a signed-in user (require_db_user). It's a team planning
tool, not admin-only.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from auth import require_db_user
from core.deps import get_db
from db.models import (
    TimelineResource, TimelineProject, TimelineAssignment, TimelineTimeOff,
    TimelineClient,
)
from schemas.common import (
    TimelineResourceIn, TimelineResourcePatch, TimelineResourceOut,
    TimelineProjectIn, TimelineProjectPatch, TimelineProjectOut,
    TimelineAssignmentIn, TimelineAssignmentPatch, TimelineAssignmentOut,
    TimelineTimeOffIn, TimelineTimeOffPatch, TimelineTimeOffOut,
    TimelineBoardResponse,
)


router = APIRouter(prefix="/api/timeline", tags=["timeline"])

VALID_STATUSES = {
    "delayed", "on_hold", "not_contracted",
    "in_progress", "ahead", "complete",
}
MAX_WEEKS = 104  # backstop so a stray far-future date can't blow up the grid


def _check_status(s: Optional[str]) -> None:
    if s is not None and s not in VALID_STATUSES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Invalid status {s!r}. One of: {sorted(VALID_STATUSES)}",
        )


def _monday(d: date) -> date:
    """Monday of the week containing d."""
    return d - timedelta(days=d.weekday())


def _workdays_overlap(a_start: date, a_end: date, week_monday: date) -> int:
    """Count Mon–Fri days where [a_start, a_end] (inclusive) overlaps the
    work-week starting at week_monday (Mon–Fri)."""
    w_start = week_monday
    w_end = week_monday + timedelta(days=4)  # Friday
    lo = max(a_start, w_start)
    hi = min(a_end, w_end)
    if lo > hi:
        return 0
    cnt = 0
    d = lo
    while d <= hi:
        if d.weekday() < 5:
            cnt += 1
        d += timedelta(days=1)
    return cnt


# ============================================================
# Resources
# ============================================================
@router.get("/resources", response_model=list[TimelineResourceOut])
def list_resources(
    include_inactive: bool = Query(False),
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    q = db.query(TimelineResource)
    if not include_inactive:
        q = q.filter(TimelineResource.active.is_(True))
    return q.order_by(
        TimelineResource.discipline,
        TimelineResource.order_index,
        TimelineResource.name,
    ).all()


@router.post("/resources", response_model=TimelineResourceOut, status_code=201)
def create_resource(
    payload: TimelineResourceIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    r = TimelineResource(
        name=payload.name.strip(),
        user_id=payload.user_id,
        discipline=payload.discipline or "Electrical",
        title=(payload.title or None),
        is_placeholder=payload.is_placeholder,
        available_from=payload.available_from,
        active=payload.active,
        order_index=payload.order_index,
        created_by_id=actor.id,
    )
    db.add(r)
    db.flush()
    return r


@router.patch("/resources/{resource_id}", response_model=TimelineResourceOut)
def patch_resource(
    resource_id: int,
    payload: TimelineResourcePatch,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    r = db.get(TimelineResource, resource_id)
    if r is None:
        raise HTTPException(404, "Resource not found")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(r, field, value)
    db.flush()
    return r


@router.delete("/resources/{resource_id}", status_code=204)
def delete_resource(
    resource_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    r = db.get(TimelineResource, resource_id)
    if r is None:
        return None
    # Null out assignments pointing at this resource (they become "unassigned")
    # rather than cascade-deleting the work.
    for a in db.query(TimelineAssignment).filter_by(resource_id=resource_id):
        a.resource_id = None
    db.delete(r)
    return None


# ============================================================
# Projects
# ============================================================
@router.get("/projects", response_model=list[TimelineProjectOut])
def list_projects(
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    return db.query(TimelineProject).order_by(TimelineProject.name).all()


@router.post("/projects", response_model=TimelineProjectOut, status_code=201)
def create_project(
    payload: TimelineProjectIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    _check_status(payload.status)
    client = (payload.client or "").strip() or None
    p = TimelineProject(
        name=payload.name.strip(),
        client=client,
        status=payload.status or "in_progress",
        notes=(payload.notes or None),
        created_by_id=actor.id,
    )
    db.add(p)
    # Register a brand-new client in the pick-list so it persists in the dropdown.
    if client:
        _ensure_client(db, client, actor.id)
    db.flush()
    return p


def _ensure_client(db: Session, name: str, actor_id: int) -> None:
    name = name.strip()
    if not name:
        return
    existing = {c.name.strip().lower() for c in db.query(TimelineClient).all()}
    if name.lower() not in existing:
        db.add(TimelineClient(name=name, created_by_id=actor_id))


# ============================================================
# Clients (timeline-only pick-list)
# ============================================================
@router.get("/clients", response_model=list[str])
def list_clients(db: Session = Depends(get_db), actor=Depends(require_db_user)):
    names = {c.name.strip() for c in db.query(TimelineClient).all() if c.name.strip()}
    names |= {p.client.strip() for p in db.query(TimelineProject).all() if p.client and p.client.strip()}
    return sorted(names, key=str.lower)


@router.post("/clients", response_model=list[str], status_code=201)
def add_client(
    payload: dict,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(422, "Client name required")
    _ensure_client(db, name, actor.id)
    db.flush()
    return list_clients(db=db, actor=actor)


@router.patch("/projects/{project_id}", response_model=TimelineProjectOut)
def patch_project(
    project_id: int,
    payload: TimelineProjectPatch,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    p = db.get(TimelineProject, project_id)
    if p is None:
        raise HTTPException(404, "Project not found")
    data = payload.model_dump(exclude_unset=True)
    if "status" in data:
        _check_status(data["status"])
    for field, value in data.items():
        setattr(p, field, value)
    p.updated_at = datetime.utcnow()
    db.flush()
    return p


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    p = db.get(TimelineProject, project_id)
    if p is None:
        return None
    db.delete(p)  # cascade deletes its assignments
    return None


# ============================================================
# Assignments
# ============================================================
@router.post("/assignments", response_model=TimelineAssignmentOut, status_code=201)
def create_assignment(
    payload: TimelineAssignmentIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    _check_status(payload.status)
    if db.get(TimelineProject, payload.timeline_project_id) is None:
        raise HTTPException(404, "Timeline project not found")
    if payload.end_date < payload.start_date:
        raise HTTPException(422, "end_date must be on or after start_date")
    a = TimelineAssignment(
        timeline_project_id=payload.timeline_project_id,
        resource_id=payload.resource_id,
        discipline=payload.discipline or "Electrical",
        milestone=(payload.milestone or None),
        start_date=payload.start_date,
        end_date=payload.end_date,
        utilization=payload.utilization if payload.utilization is not None else 1.0,
        status=(payload.status or None),
        label=(payload.label or None),
        order_index=payload.order_index,
        created_by_id=actor.id,
    )
    db.add(a)
    db.flush()
    return _assignment_out(a, db.get(TimelineProject, a.timeline_project_id))


@router.patch("/assignments/{assignment_id}", response_model=TimelineAssignmentOut)
def patch_assignment(
    assignment_id: int,
    payload: TimelineAssignmentPatch,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    a = db.get(TimelineAssignment, assignment_id)
    if a is None:
        raise HTTPException(404, "Assignment not found")
    data = payload.model_dump(exclude_unset=True)
    if "status" in data:
        _check_status(data["status"])
    for field, value in data.items():
        setattr(a, field, value)
    if a.end_date < a.start_date:
        raise HTTPException(422, "end_date must be on or after start_date")
    a.updated_at = datetime.utcnow()
    db.flush()
    return _assignment_out(a, db.get(TimelineProject, a.timeline_project_id))


@router.delete("/assignments/{assignment_id}", status_code=204)
def delete_assignment(
    assignment_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    a = db.get(TimelineAssignment, assignment_id)
    if a is None:
        return None
    db.delete(a)
    return None


# ============================================================
# Time off — blocked / out-of-office ranges (reduce availability)
# ============================================================
@router.post("/timeoff", response_model=TimelineTimeOffOut, status_code=201)
def create_timeoff(
    payload: TimelineTimeOffIn,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    if db.get(TimelineResource, payload.resource_id) is None:
        raise HTTPException(404, "Resource not found")
    if payload.end_date < payload.start_date:
        raise HTTPException(422, "end_date must be on or after start_date")
    t = TimelineTimeOff(
        resource_id=payload.resource_id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        reason=(payload.reason or "OOO").strip()[:80],
        created_by_id=actor.id,
    )
    db.add(t)
    db.flush()
    return t


@router.patch("/timeoff/{timeoff_id}", response_model=TimelineTimeOffOut)
def patch_timeoff(
    timeoff_id: int,
    payload: TimelineTimeOffPatch,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    t = db.get(TimelineTimeOff, timeoff_id)
    if t is None:
        raise HTTPException(404, "Time-off not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(t, field, value)
    if t.end_date < t.start_date:
        raise HTTPException(422, "end_date must be on or after start_date")
    db.flush()
    return t


@router.delete("/timeoff/{timeoff_id}", status_code=204)
def delete_timeoff(
    timeoff_id: int,
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    t = db.get(TimelineTimeOff, timeoff_id)
    if t is not None:
        db.delete(t)
    return None


# ============================================================
# Board — weeks + assignments + per-resource per-week utilization load
# ============================================================
def _assignment_out(a: TimelineAssignment, project: Optional[TimelineProject]) -> TimelineAssignmentOut:
    eff = a.status or (project.status if project else None)
    return TimelineAssignmentOut(
        id=a.id,
        timeline_project_id=a.timeline_project_id,
        resource_id=a.resource_id,
        discipline=a.discipline or "Electrical",
        milestone=a.milestone,
        start_date=a.start_date,
        end_date=a.end_date,
        utilization=a.utilization if a.utilization is not None else 1.0,
        status=a.status,
        label=a.label,
        order_index=a.order_index or 0,
        project_name=(project.name if project else None),
        client=(project.client if project else None),
        effective_status=eff,
    )


@router.get("/board", response_model=TimelineBoardResponse)
def get_board(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    actor=Depends(require_db_user),
):
    resources = (
        db.query(TimelineResource)
        .filter(TimelineResource.active.is_(True))
        .order_by(
            TimelineResource.discipline,
            TimelineResource.order_index,
            TimelineResource.name,
        )
        .all()
    )
    projects = db.query(TimelineProject).order_by(TimelineProject.name).all()
    proj_by_id = {p.id: p for p in projects}
    assignments = db.query(TimelineAssignment).all()
    timeoff = db.query(TimelineTimeOff).all()

    # ---- Resolve the week window ----
    # Default view starts at the CURRENT work-week and runs 8 weeks out (no
    # past lead-in) — ongoing work simply renders clipped at the left edge.
    # An explicit start/end (the From/To date filter) is honoured verbatim so
    # the user can look further back or ahead.
    today = date.today()
    this_monday = _monday(today)
    if start is None:
        start = this_monday
    if end is None:
        end = this_monday + timedelta(weeks=8)
    first_monday = _monday(start)
    last_monday = _monday(end)
    weeks: list[date] = []
    w = first_monday
    while w <= last_monday and len(weeks) < MAX_WEEKS:
        weeks.append(w)
        w += timedelta(days=7)
    if not weeks:
        weeks = [first_monday]

    # ---- Enriched assignments + per-resource per-week load ----
    assignment_outs: list[TimelineAssignmentOut] = []
    load: dict[str, list[float]] = {}
    for a in assignments:
        assignment_outs.append(_assignment_out(a, proj_by_id.get(a.timeline_project_id)))
        if a.resource_id is None:
            continue
        arr = load.setdefault(str(a.resource_id), [0.0] * len(weeks))
        util = a.utilization if a.utilization is not None else 1.0
        for i, wk in enumerate(weeks):
            wd = _workdays_overlap(a.start_date, a.end_date, wk)
            if wd:
                arr[i] += (wd / 5.0) * util

    # ---- Time off + per-resource per-week availability ----
    # availability = 1 - (blocked workdays / 5), clamped to [0, 1]. Blocked
    # workdays come from explicit time-off AND, for placeholders with a
    # potential start date, every workday before they're available.
    timeoff_outs: list[TimelineTimeOffOut] = [
        TimelineTimeOffOut(
            id=t.id, resource_id=t.resource_id,
            start_date=t.start_date, end_date=t.end_date, reason=t.reason,
        )
        for t in timeoff
    ]
    availability: dict[str, list[float]] = {}
    for t in timeoff:
        arr = availability.setdefault(str(t.resource_id), [0.0] * len(weeks))
        for i, wk in enumerate(weeks):
            wd = _workdays_overlap(t.start_date, t.end_date, wk)
            if wd:
                arr[i] += wd / 5.0  # accumulate blocked fraction
    # pre-start blocking: workdays before a resource's available_from
    for r in resources:
        if r.available_from is None:
            continue
        arr = availability.setdefault(str(r.id), [0.0] * len(weeks))
        cutoff = r.available_from - timedelta(days=1)  # last blocked day
        for i, wk in enumerate(weeks):
            if cutoff < wk:
                continue
            arr[i] += _workdays_overlap(wk, cutoff, wk) / 5.0
    # convert accumulated blocked fraction -> availability (1 - blocked)
    for rid, arr in availability.items():
        for i in range(len(arr)):
            arr[i] = max(0.0, 1.0 - min(1.0, arr[i]))

    client_names = {c.name.strip() for c in db.query(TimelineClient).all() if c.name.strip()}
    client_names |= {p.client.strip() for p in projects if p.client and p.client.strip()}

    return TimelineBoardResponse(
        weeks=weeks,
        resources=resources,
        projects=projects,
        assignments=assignment_outs,
        timeoff=timeoff_outs,
        load=load,
        availability=availability,
        clients=sorted(client_names, key=str.lower),
    )
