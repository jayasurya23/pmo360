"""/api/meetings — CRUD + save-with-parsed payload."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from core.deps import get_db
from auth import get_current_db_user
from db.models import Meeting, Project, DiscussionPoint
from db.repository import list_meetings, get_meeting, latest_meeting
from core.services import (
    save_parsed_meeting, update_parsed_meeting, _try_generate_summary,
)
from llm.providers import ParsedMeeting as _ParsedMeeting
from llm.providers import (
    ParsedMeeting, ParsedAttendee, ParsedAgendaItem,
    ParsedDiscussionPoint, ParsedActionItem,
)
from schemas.common import (
    MeetingSummary, MeetingDetail, MeetingSaveRequest,
    DiscussionPointOut, ParsedDiscussionPointOut, MeetingMetaUpdate,
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
        version=m.version,
        executive_summary=m.executive_summary,
        created_by=m.created_by, updated_by=m.updated_by,
        created_at=m.created_at, updated_at=m.updated_at,
        raw_notes=m.raw_notes, closing_remarks=m.closing_remarks,
        attendees=[a for a in m.attendees],
        agenda_items=sorted(m.agenda_items, key=lambda a: a.order_index),
        discussion_points=_build_dp_tree(m),
        raised_actions=sorted(m.raised_actions, key=lambda a: a.id),
        meeting_deliverables=sorted(m.meeting_deliverables, key=lambda d: d.order_index),
        # Backref from MeetingAttachment — newest first so the UI shows the
        # most recently uploaded file on top without resorting client-side.
        attachments=sorted(
            getattr(m, "attachments", []),
            key=lambda a: a.created_at or 0,
            reverse=True,
        ),
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
def save_meeting(
    payload: MeetingSaveRequest,
    db: Session = Depends(get_db),
    actor = Depends(get_current_db_user),
):
    """Create or update a meeting from a ParsedMeeting + manual deliverables.

    If `meeting_id` is supplied, the row is updated in place; otherwise a new
    draft Meeting is created. Returns the persisted MeetingDetail.

    `actor` is the signed-in user (or None if anonymous). Stamped on the
    row's `created_by_id` / `updated_by_id` columns for per-user audit.
    """
    project = db.get(Project, payload.project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    parsed = _parsed_to_pydantic(payload.parsed)
    deliverables = [d.model_dump() for d in payload.deliverables]
    actor_id = actor.id if actor is not None else None

    if payload.meeting_id:
        meeting = db.get(Meeting, payload.meeting_id)
        if not meeting:
            raise HTTPException(404, "Meeting not found")
        # Optimistic concurrency: reject the write if someone else has
        # saved in the meantime. The client is expected to refetch and
        # merge — UI shows a "this was edited by another user" toast.
        if (payload.expected_version is not None
                and meeting.version != payload.expected_version):
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "stale_version",
                    "message": (
                        "This meeting was saved by someone else while you "
                        "were editing. Reload to see the latest version."
                    ),
                    "current_version": meeting.version,
                    "submitted_version": payload.expected_version,
                },
            )
        update_parsed_meeting(
            db, meeting, parsed,
            meeting_date=payload.meeting_date,
            raw_notes=payload.raw_notes or "",
            title=payload.title or "",
            deliverables=deliverables,
            actor_id=actor_id,
        )
        meeting.version = (meeting.version or 1) + 1
    else:
        meeting = save_parsed_meeting(
            db, project,
            meeting_date=payload.meeting_date,
            parsed=parsed,
            raw_notes=payload.raw_notes or "",
            title=payload.title or "",
            deliverables=deliverables,
            actor_id=actor_id,
        )
        # version defaults to 1 on insert via the column default

    if payload.closing_remarks is not None:
        meeting.closing_remarks = payload.closing_remarks

    db.flush()
    return _serialize_meeting(meeting)


@router.patch("/{meeting_id}", response_model=MeetingSummary)
def patch_meeting_meta(
    meeting_id: int,
    payload: MeetingMetaUpdate,
    db: Session = Depends(get_db),
    actor=Depends(get_current_db_user),
):
    """Rename a meeting or change its stage from the History page.

    Lightweight on purpose — does NOT touch attendees/discussion/actions
    (use POST /save for content edits). Only ``model_fields_set`` keys are
    applied so a rename doesn't clobber the stage and vice-versa.
    """
    m = db.get(Meeting, meeting_id)
    if not m:
        raise HTTPException(404, "Meeting not found")
    sent = payload.model_fields_set
    if "title" in sent:
        m.title = payload.title
    if "stage" in sent and payload.stage:
        if payload.stage not in ("draft", "final", "sent"):
            raise HTTPException(422, "stage must be draft / final / sent")
        m.stage = payload.stage
    if actor is not None:
        m.updated_by_id = actor.id
    db.flush()
    return m


@router.delete("/{meeting_id}", status_code=204)
def delete_meeting(meeting_id: int, db: Session = Depends(get_db)):
    m = db.get(Meeting, meeting_id)
    if not m:
        raise HTTPException(404, "Meeting not found")
    db.delete(m)
    return None


@router.post("/{meeting_id}/regenerate-summary", response_model=MeetingDetail)
def regenerate_summary(meeting_id: int, db: Session = Depends(get_db)):
    """Re-run the AI executive summary against the current meeting state.
    Used after major edits where the cached summary no longer reflects the
    content. Returns the updated MeetingDetail."""
    meeting = db.get(Meeting, meeting_id)
    if not meeting:
        raise HTTPException(404, "Meeting not found")
    # Rebuild a ParsedMeeting view from the persisted ORM rows so we can
    # hand it to the summarizer. Reuse the same conversion logic as on
    # the save path.
    from llm.providers import (
        ParsedAttendee, ParsedAgendaItem, ParsedActionItem,
        ParsedDiscussionPoint,
    )
    def _dp_to_parsed(rows, parent_id=None):
        out = []
        for dp in sorted(
            [d for d in rows if d.parent_id == parent_id],
            key=lambda d: d.order_index,
        ):
            out.append(ParsedDiscussionPoint(
                label=dp.label or "", content=dp.content or "",
                discipline=dp.discipline or "General",
                sub_points=_dp_to_parsed(rows, dp.id),
            ))
        return out
    parsed = _ParsedMeeting(
        attendees=[ParsedAttendee(
            full_name=a.full_name, initials=a.initials,
            organization=a.organization or "",
        ) for a in meeting.attendees],
        agenda_items=[ParsedAgendaItem(
            text=a.text, discipline=a.discipline or "General",
        ) for a in sorted(meeting.agenda_items, key=lambda a: a.order_index)],
        discussion_points=_dp_to_parsed(meeting.discussion_points),
        action_items=[ParsedActionItem(
            text=a.text or "", owner=a.owner or "",
            owner_user_id=a.owner_user_id,
            due_date=a.due_date.isoformat() if a.due_date else None,
            status=a.status or "open",
        ) for a in meeting.raised_actions],
    )
    summary = _try_generate_summary(
        parsed, meeting.project, closing_remarks=meeting.closing_remarks or "",
    )
    if summary is None:
        raise HTTPException(
            502,
            "Couldn't generate summary — OpenAI call failed. Try again in a moment.",
        )
    meeting.executive_summary = summary
    db.flush()
    return _serialize_meeting(meeting)
