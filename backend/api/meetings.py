"""/api/meetings — CRUD + save-with-parsed payload."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from core.deps import get_db
from db.models import Meeting, Project, DiscussionPoint
from db.repository import list_meetings, get_meeting, latest_meeting
from core.services import save_parsed_meeting, update_parsed_meeting
from llm.providers import (
    ParsedMeeting, ParsedAttendee, ParsedAgendaItem,
    ParsedDiscussionPoint, ParsedActionItem,
)
from schemas.common import (
    MeetingSummary, MeetingDetail, MeetingSaveRequest,
    DiscussionPointOut, ParsedDiscussionPointOut,
)


router = APIRouter(prefix="/api/meetings", tags=["meetings"])


# --- helpers ---------------------------------------------------------------
def _build_dp_tree(meeting: Meeting) -> list[DiscussionPointOut]:
    """Walk the discussion_points relationship and emit a nested tree."""
    by_parent: dict = {}
    for dp in meeting.discussion_points:
        by_parent.setdefault(dp.parent_id, []).append(dp)

    def emit(parent_id):
        nodes = by_parent.get(parent_id, [])
        nodes.sort(key=lambda d: d.order_index)
        out: list[DiscussionPointOut] = []
        for dp in nodes:
            out.append(DiscussionPointOut(
                id=dp.id, parent_id=dp.parent_id, order_index=dp.order_index,
                label=dp.label, content=dp.content, discipline=dp.discipline,
                ai_extracted=bool(dp.ai_extracted),
                sub_points=emit(dp.id),
            ))
        return out

    return emit(None)


def _serialize_meeting(m: Meeting) -> MeetingDetail:
    return MeetingDetail(
        id=m.id, project_id=m.project_id, meeting_date=m.meeting_date,
        title=m.title, stage=m.stage,
        schedule_version_at_meeting=m.schedule_version_at_meeting,
        created_at=m.created_at, updated_at=m.updated_at,
        raw_notes=m.raw_notes, closing_remarks=m.closing_remarks,
        attendees=[a for a in m.attendees],
        agenda_items=sorted(m.agenda_items, key=lambda a: a.order_index),
        discussion_points=_build_dp_tree(m),
        raised_actions=sorted(m.raised_actions, key=lambda a: a.id),
        meeting_deliverables=sorted(m.meeting_deliverables, key=lambda d: d.order_index),
    )


def _parsed_to_pydantic(parsed_in) -> ParsedMeeting:
    """Convert our API ParsedMeetingOut → llm.providers.ParsedMeeting."""
    def to_dp(dps):
        out = []
        for dp in dps or []:
            out.append(ParsedDiscussionPoint(
                label=dp.label, content=dp.content, discipline=dp.discipline,
                sub_points=to_dp(dp.sub_points),
            ))
        return out

    return ParsedMeeting(
        attendees=[ParsedAttendee(**a.model_dump()) for a in parsed_in.attendees],
        agenda_items=[ParsedAgendaItem(**a.model_dump()) for a in parsed_in.agenda_items],
        discussion_points=to_dp(parsed_in.discussion_points),
        action_items=[ParsedActionItem(**a.model_dump()) for a in parsed_in.action_items],
    )


# --- routes ----------------------------------------------------------------
@router.get("", response_model=list[MeetingSummary])
def get_meetings(project_id: int = Query(...), db: Session = Depends(get_db)):
    return list_meetings(db, project_id)


@router.get("/latest", response_model=MeetingDetail | None)
def get_latest(project_id: int = Query(...), db: Session = Depends(get_db)):
    m = latest_meeting(db, project_id)
    if not m:
        return None
    return _serialize_meeting(m)


@router.get("/{meeting_id}", response_model=MeetingDetail)
def get_one(meeting_id: int, db: Session = Depends(get_db)):
    m = get_meeting(db, meeting_id)
    if not m:
        raise HTTPException(404, "Meeting not found")
    return _serialize_meeting(m)


@router.post("/save", response_model=MeetingDetail)
def save_meeting(payload: MeetingSaveRequest, db: Session = Depends(get_db)):
    """Create or update a meeting from a ParsedMeeting + manual deliverables.

    If `meeting_id` is supplied, the row is updated in place; otherwise a new
    draft Meeting is created. Returns the persisted MeetingDetail.
    """
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    parsed = _parsed_to_pydantic(payload.parsed)
    deliverables = [d.model_dump() for d in payload.deliverables]

    if payload.meeting_id:
        meeting = db.get(Meeting, payload.meeting_id)
        if not meeting:
            raise HTTPException(404, "Meeting not found")
        update_parsed_meeting(
            db, meeting, parsed,
            meeting_date=payload.meeting_date,
            raw_notes=payload.raw_notes or "",
            title=payload.title or "",
            deliverables=deliverables,
        )
    else:
        meeting = save_parsed_meeting(
            db, project,
            meeting_date=payload.meeting_date,
            parsed=parsed,
            raw_notes=payload.raw_notes or "",
            title=payload.title or "",
            deliverables=deliverables,
        )

    if payload.closing_remarks is not None:
        meeting.closing_remarks = payload.closing_remarks

    db.flush()
    return _serialize_meeting(meeting)


@router.delete("/{meeting_id}", status_code=204)
def delete_meeting(meeting_id: int, db: Session = Depends(get_db)):
    m = db.get(Meeting, meeting_id)
    if not m:
        raise HTTPException(404, "Meeting not found")
    db.delete(m)
    return None
