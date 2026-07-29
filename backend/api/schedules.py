"""/api/schedules — upload and parse project schedule files (PDF / XLSX)."""
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from auth import require_db_user
from core.deps import get_db
from db.models import Schedule, ScheduleItem, Project
from schedule_parser.parser import parse_schedule_file
from schemas.common import (
    ScheduleOut, ParsedScheduleOut, ParsedScheduleItemOut, ScheduleSaveRequest,
)


router = APIRouter(prefix="/api/schedules", tags=["schedules"])


@router.get("", response_model=list[ScheduleOut])
def list_schedules(project_id: int = Query(...), db: Session = Depends(get_db), _user=Depends(require_db_user)):
    return (
        db.query(Schedule)
        .filter_by(project_id=project_id)
        .order_by(Schedule.uploaded_at.desc())
        .all()
    )


@router.get("/{schedule_id}", response_model=ScheduleOut)
def get_one(schedule_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    s = db.get(Schedule, schedule_id)
    if not s:
        raise HTTPException(404, "Schedule not found")
    return s


@router.post("/parse", response_model=ParsedScheduleOut)
async def parse_uploaded(
    file: UploadFile = File(...),
    engine: str = Form("auto"),
    _user=Depends(require_db_user),
):
    """Parse an uploaded proposal/schedule file.

    ``engine`` (PDF only): ``auto`` runs the fast regex parser and falls back
    to AI only when the result looks weak; ``regex`` forces the fast parser;
    ``llm`` forces AI extraction (use when a non-standard layout parsed badly).
    """
    if engine not in ("auto", "regex", "llm"):
        raise HTTPException(400, "engine must be one of: auto, regex, llm")
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    try:
        parsed = parse_schedule_file(file.filename or "", data, engine=engine)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    items = [ParsedScheduleItemOut(**i.model_dump()) for i in parsed.items]
    return ParsedScheduleOut(
        version=parsed.version,
        source_format=parsed.source_format,
        source_filename=parsed.source_filename,
        project_name=parsed.project_name,
        project_start_date=parsed.project_start_date,
        total_duration_days=parsed.total_duration_days,
        total_price=parsed.total_price,
        items=items,
        parse_engine=parsed.parse_engine,
    )


@router.post("", response_model=ScheduleOut, status_code=201)
def save_schedule(payload: ScheduleSaveRequest, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    p = payload.parsed
    sched = Schedule(
        project_id=payload.project_id,
        version=p.version or "V1",
        source_filename=p.source_filename,
        source_format=p.source_format,
        project_start_date=p.project_start_date,
        total_duration_days=p.total_duration_days,
        total_price=p.total_price,
    )
    db.add(sched)
    db.flush()
    for i in p.items:
        db.add(ScheduleItem(
            schedule_id=sched.id,
            order_index=i.order_index,
            indent_level=i.indent_level,
            discipline=i.discipline,
            phase=i.phase,
            task=i.task,
            duration_days=i.duration_days,
            start_date=i.start_date,
            finish_date=i.finish_date,
            price=i.price,
            is_milestone=i.is_milestone,
        ))
    # Bump the project's headline schedule version so docs show the new value.
    project.schedule_version = sched.version
    db.flush()
    return sched


@router.delete("/{schedule_id}", status_code=204)
def remove(schedule_id: int, db: Session = Depends(get_db), _user=Depends(require_db_user)):
    s = db.get(Schedule, schedule_id)
    if not s:
        raise HTTPException(404, "Schedule not found")
    db.delete(s)
    return None
