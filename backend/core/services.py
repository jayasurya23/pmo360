"""Orchestration layer between API routers and the data / AI / docgen / storage
layers. Mirrors ``app/services.py`` from the original Streamlit project, so
behaviour is identical from the user's perspective.
"""
from datetime import date, datetime
from typing import Optional

from sqlalchemy.orm import Session

from db.models import (
    Meeting, MeetingAttendee, AgendaItem, DiscussionPoint, ActionItem,
    PortfolioProject, Project, ProjectAttendee, Deliverable, MeetingDeliverable,
    GeneratedDocument, MeetingRFI,
)
from db.repository import (
    upsert_project_attendee, latest_meeting, open_actions, all_actions,
)
from llm.providers import get_provider, ParsedMeeting
import logging
_logger = logging.getLogger(__name__)
from docgen import (
    generate_meeting_minutes_docx,
    generate_meeting_minutes_pdf,
    generate_action_items_xlsx,
    generate_premeeting_agenda_docx,
    generate_premeeting_agenda_pdf,
    add_status_form_fields,
)
from storage import get_storage


# ============================================================
# AI parsing → save draft meeting
# ============================================================
def parse_notes_with_ai(
    minutes_text: str,
    agenda_text: str,
    actions_text: str,
    project: Project,
    attendees_roster: Optional[list[dict]] = None,
    meeting_date: Optional[str] = None,
) -> ParsedMeeting:
    provider = get_provider()
    context = f"{project.client.name if project.client else ''} / {project.name}"
    return provider.parse_meeting_notes(
        minutes_text=minutes_text,
        agenda_text=agenda_text,
        actions_text=actions_text,
        project_context=context,
        attendees_roster=attendees_roster,
        meeting_date=meeting_date,
    )


def _as_date(v):
    """Accept a date, an ISO string, or None. RFI dates arrive from the browser
    as ISO strings and from a direct call as dates; a bad value drops to None
    rather than failing a save over one field."""
    if v is None or isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _write_meeting_children(session: Session, meeting: Meeting,
                            project: Project, parsed: ParsedMeeting,
                            deliverables: Optional[list[dict]] = None,
                            actor_id: Optional[int] = None,
                            rfis: Optional[list[dict]] = None) -> None:
    # Build an email lookup keyed on (lower full_name, initials) so we can
    # carry roster-stored emails through to MeetingAttendee.email without
    # an extra round-trip per attendee.
    from db.models import GlobalAttendee
    proj_roster = (
        session.query(ProjectAttendee)
        .filter_by(project_id=project.id)
        .all()
    )
    global_roster = session.query(GlobalAttendee).all()
    email_lookup: dict[str, str] = {}
    for r in (*proj_roster, *global_roster):
        key = (r.full_name or "").strip().lower()
        if r.email and key and key not in email_lookup:
            email_lookup[key] = r.email

    for a in parsed.attendees:
        upsert_project_attendee(
            session, project_id=project.id,
            full_name=a.full_name or a.initials,
            initials=a.initials, organization=a.organization,
            first_seen_meeting_id=meeting.id,
        )
        # An attendee dict from the LLM/parsed payload might or might not
        # carry an email. Prefer what the client sent; fall back to the
        # roster lookup.
        attendee_email = getattr(a, "email", None) or email_lookup.get(
            (a.full_name or "").strip().lower(), ""
        )
        session.add(MeetingAttendee(
            meeting_id=meeting.id,
            full_name=a.full_name or a.initials,
            initials=a.initials, organization=a.organization,
            email=attendee_email or None,
        ))

    for idx, d in enumerate(deliverables or []):
        task = (d.get("task") or "").strip()
        if not task:
            continue
        deliv = Deliverable(
            project_id=project.id,
            project_segment=(d.get("project_segment") or "").strip() or None,
            task=task,
            start_status=(d.get("start_status") or "In Progress"),
            delivery_date=d.get("delivery_date"),
            source="manual",
            schedule_version_added=project.schedule_version,
        )
        session.add(deliv)
        session.flush()
        session.add(MeetingDeliverable(
            meeting_id=meeting.id,
            deliverable_id=deliv.id,
            order_index=idx,
            carried_from_prior=False,
        ))

    for idx, item in enumerate(parsed.agenda_items):
        session.add(AgendaItem(
            meeting_id=meeting.id, order_index=idx,
            text=item.text, discipline=item.discipline,
        ))

    def _persist_dp(dp, parent_id, idx):
        row = DiscussionPoint(
            meeting_id=meeting.id, parent_id=parent_id,
            order_index=idx, label=dp.label, content=dp.content,
            discipline=dp.discipline, ai_extracted=True,
        )
        session.add(row)
        session.flush()
        for sub_idx, sub in enumerate(dp.sub_points or []):
            _persist_dp(sub, row.id, sub_idx)
    for idx, dp in enumerate(parsed.discussion_points):
        _persist_dp(dp, None, idx)

    # Sub-projects of THIS portfolio, fetched once. Anything else in the payload
    # is not ours to honour — see below.
    valid_sub_projects = {
        pid for (pid,) in session.query(PortfolioProject.id)
        .filter(PortfolioProject.portfolio_id == project.id)
        .all()
    }
    for a in parsed.action_items:
        due = None
        if a.due_date:
            try:
                due = date.fromisoformat(a.due_date)
            except ValueError:
                due = None
        # An unrecognised sub-project DROPS THE TAG, it does not fail the save.
        # This runs while a PM is saving a whole set of meeting minutes, and the
        # only way to get an invalid id here is a stale payload (a project
        # deleted or moved while the tab was open) — refusing the write would
        # cost the PM the entire minutes over a piece of metadata. The action
        # lands on the portfolio as a whole, which is the default anyway, and
        # the tag can be reapplied in a second. Losing the notes cannot.
        sub_id = getattr(a, "portfolio_project_id", None)
        if sub_id is not None and sub_id not in valid_sub_projects:
            sub_id = None
        # INHERIT the meeting's sub-project when the action does not name one.
        # This is the whole point of tagging a meeting: a call that is entirely
        # about one sub-project says so once instead of every action saying it.
        #
        # An action's OWN tag wins, and that asymmetry is deliberate — a meeting
        # about one project can still raise an action about another, and the
        # per-row picker has to stay able to say so. It also means inheritance
        # cannot silently overwrite a choice somebody made by hand.
        #
        # Validated the same way, because the meeting's tag can go stale too:
        # a sub-project deleted after the meeting was tagged must not be
        # stamped onto new actions.
        if sub_id is None:
            meeting_sub = getattr(meeting, "portfolio_project_id", None)
            if meeting_sub is not None and meeting_sub in valid_sub_projects:
                sub_id = meeting_sub
        session.add(ActionItem(
            project_id=project.id,
            portfolio_project_id=sub_id,
            originating_meeting_id=meeting.id,
            text=a.text, owner=a.owner,
            owner_user_id=getattr(a, "owner_user_id", None),
            due_date=due, status=a.status,
            created_by_id=actor_id, updated_by_id=actor_id,
        ))

    # ---- RFI snapshots ----
    # Copied in from monday.com at save time rather than read live. Minutes are
    # a record of a conversation on a date: a PDF regenerated next month has to
    # match the one the client received, and a live read would rewrite history
    # every time somebody edited a status in Monday.
    #
    # The same sub-project validity check as action items above, for the same
    # reason — a stale id must DROP THE TAG, never fail the save. Losing the
    # minutes over a piece of metadata is the worse outcome, and the RFI still
    # prints, just in the portfolio-wide table.
    seen_rfi: set = set()
    for idx, r in enumerate(rfis or []):
        name = (r.get("name") or "").strip()
        if not name:
            continue
        sub_id = r.get("portfolio_project_id")
        if sub_id is not None and sub_id not in valid_sub_projects:
            sub_id = None
        # The unique key is (meeting, monday item, sub-project). Deduping here
        # too, because a payload that repeats a pair would otherwise raise an
        # IntegrityError on Postgres and lose the whole save — and SQLite,
        # which does not enforce it, would silently store the duplicate and
        # print the RFI twice.
        key = (r.get("monday_item_id"), sub_id)
        if r.get("monday_item_id") is not None and key in seen_rfi:
            continue
        seen_rfi.add(key)
        session.add(MeetingRFI(
            meeting_id=meeting.id,
            portfolio_project_id=sub_id,
            monday_item_id=r.get("monday_item_id"),
            monday_project_code=r.get("monday_project_code"),
            name=name,
            item_equipment=r.get("item_equipment"),
            description=r.get("description"),
            question=r.get("question"),
            context=r.get("context"),
            status=r.get("status"),
            response_owner=r.get("response_owner"),
            discipline=r.get("discipline"),
            equipment_type=r.get("equipment_type"),
            assigned_to=r.get("assigned_to"),
            date_submitted=_as_date(r.get("date_submitted")),
            response_needed_by=_as_date(r.get("response_needed_by")),
            date_completed=_as_date(r.get("date_completed")),
            snapshot_at=datetime.utcnow(),
            order_index=idx,
        ))


def _try_generate_summary(parsed: ParsedMeeting, project: Project,
                          closing_remarks: str = "") -> Optional[str]:
    """Best-effort LLM summary generation. Returns None on any error so a
    failed OpenAI call never blocks a meeting save. The PM can manually
    regenerate from Review."""
    try:
        provider = get_provider()
        context = f"{project.client.name if project.client else ''} / {project.name}"
        return provider.summarize_meeting(parsed, context, closing_remarks)
    except Exception as exc:
        _logger.warning("Executive summary generation failed: %s", exc)
        return None


def _clean_meeting_sub_project(
    session: Session, portfolio_id: int, sub_project_id: Optional[int],
) -> Optional[int]:
    """Keep the meeting's sub-project only if it belongs to THIS portfolio.

    Drops it rather than raising, for the same reason the per-action tag drops:
    this runs mid-save of a full set of minutes, and refusing the write over a
    stale piece of metadata would cost the PM the notes. Untagged is the
    default state anyway, and re-tagging takes a second.
    """
    if sub_project_id is None:
        return None
    ok = (
        session.query(PortfolioProject.id)
        .filter(
            PortfolioProject.id == sub_project_id,
            PortfolioProject.portfolio_id == portfolio_id,
        )
        .first()
    )
    return sub_project_id if ok else None


def save_parsed_meeting(
    session: Session,
    project: Project,
    meeting_date: date,
    parsed: ParsedMeeting,
    raw_notes: str = "",
    title: str = "",
    deliverables: Optional[list[dict]] = None,
    actor_id: Optional[int] = None,
    portfolio_project_id: Optional[int] = None,
    rfis: Optional[list[dict]] = None,
) -> Meeting:
    meeting = Meeting(
        project_id=project.id,
        portfolio_project_id=_clean_meeting_sub_project(
            session, project.id, portfolio_project_id,
        ),
        meeting_date=meeting_date,
        title=title or f"Weekly coordination — {meeting_date.isoformat()}",
        raw_notes=raw_notes,
        stage="draft",
        schedule_version_at_meeting=project.schedule_version,
        created_by_id=actor_id,
        updated_by_id=actor_id,
        # Best-effort: generate the AI summary on first save. If OpenAI is
        # slow/down, the column stays null and the PDF skips the block.
        executive_summary=_try_generate_summary(parsed, project),
    )
    session.add(meeting)
    session.flush()
    _write_meeting_children(session, meeting, project, parsed,
                            deliverables=deliverables, actor_id=actor_id,
                            rfis=rfis)
    session.flush()
    return meeting


def update_parsed_meeting(
    session: Session,
    meeting: Meeting,
    parsed: ParsedMeeting,
    meeting_date: date,
    raw_notes: str = "",
    title: str = "",
    deliverables: Optional[list[dict]] = None,
    actor_id: Optional[int] = None,
    portfolio_project_id: Optional[int] = None,
    sub_project_sent: bool = False,
    rfis: Optional[list[dict]] = None,
) -> Meeting:
    meeting.meeting_date = meeting_date
    if title:
        meeting.title = title
    # Only when the caller actually sent the field. Treating None as "clear it"
    # would untag every meeting saved by an older client, and re-tagging is not
    # something a PM would think to check for.
    #
    # Assigned BEFORE the children are rebuilt below, because the actions
    # inherit from it — setting it afterwards would tag the meeting and leave
    # everything raised in it untagged until the next save.
    if sub_project_sent:
        meeting.portfolio_project_id = _clean_meeting_sub_project(
            session, meeting.project_id, portfolio_project_id,
        )
    meeting.raw_notes = raw_notes
    meeting.updated_at = datetime.utcnow()
    if actor_id is not None:
        meeting.updated_by_id = actor_id

    for child in list(meeting.attendees):
        session.delete(child)
    for child in list(meeting.agenda_items):
        session.delete(child)
    for child in list(meeting.discussion_points):
        session.delete(child)
    # client_facing_actions, NOT raised_actions, and that is load-bearing.
    # A re-save rebuilds this meeting's actions from the payload, but an action
    # MOVED to another portfolio is still in raised_actions (it keeps its
    # originating meeting) and is no longer in the payload — so deleting from
    # the raw list would quietly destroy work another portfolio now owns, every
    # time somebody re-saved these minutes.
    for child in list(meeting.client_facing_actions):
        session.delete(child)
    # RFIs are rebuilt from the payload like the rest, so they must be torn
    # down with it. Without this every re-save appends a second copy of every
    # snapshot — and on Postgres the unique key turns that into a failed save
    # instead of a duplicate, so the meeting simply stops saving.
    for child in list(meeting.rfis):
        session.delete(child)
    for md in list(meeting.meeting_deliverables):
        deliv = md.deliverable
        session.delete(md)
        if deliv is not None:
            session.delete(deliv)
    session.flush()

    _write_meeting_children(session, meeting, meeting.project, parsed,
                            deliverables=deliverables, actor_id=actor_id,
                            rfis=rfis)
    session.flush()
    return meeting


# ============================================================
# Filename helpers
# ============================================================
def safe_filename_slug(s: str) -> str:
    import re
    if not s:
        return "project"
    s = s.strip().replace(" ", "_")
    s = re.sub(r"[/\\:*?\"<>|]", "-", s)
    s = re.sub(r"[^\w\-.]", "", s)
    return s or "project"


def meeting_filename(meeting: Meeting, kind: str, ext: str,
                     draft: bool = False) -> str:
    project_name = meeting.project.name if meeting.project else ""
    date_str = meeting.meeting_date.strftime("%Y-%m-%d")
    parts = [
        safe_filename_slug(project_name) if project_name else None,
        ("Draft_" if draft else "") + kind,
        date_str,
    ]
    base = "_".join(p for p in parts if p)
    return f"{base}.{ext}"


# ============================================================
# Document generation in-memory (for browser download / preview)
# ============================================================
def build_meeting_docs(session: Session, meeting: Meeting,
                       draft: bool = True) -> dict[str, dict]:
    """Generate all three meeting documents in memory.

    Returns dict keyed by kind with {filename, content_type, bytes}.
    """
    pdf_bytes = generate_meeting_minutes_pdf(meeting)
    pdf_bytes = add_status_form_fields(pdf_bytes, len(meeting.client_facing_actions))
    docx_bytes = generate_meeting_minutes_docx(meeting)
    actions = all_actions(session, meeting.project.id)
    xlsx_bytes = generate_action_items_xlsx(meeting.project, actions)

    return {
        "pdf": {
            "filename": meeting_filename(meeting, "Meeting_Minutes", "pdf", draft=draft),
            "content_type": "application/pdf",
            "bytes": pdf_bytes,
        },
        "docx": {
            "filename": meeting_filename(meeting, "Meeting_Minutes", "docx", draft=draft),
            "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "bytes": docx_bytes,
        },
        "xlsx": {
            "filename": f"Action_Items_Log_{safe_filename_slug(meeting.project.client.name) if meeting.project.client else 'project'}.xlsx",
            "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "bytes": xlsx_bytes,
        },
    }


def finalize_meeting(session: Session, meeting: Meeting) -> dict:
    """Generate final client-ready documents and save to storage.

    Also writes a GeneratedDocument audit row per artifact so the team can
    later see every PDF/docx/xlsx the app produced for this meeting — kind,
    filename, storage path, file size, when, and whether it was a draft.
    """
    storage = get_storage()
    project = meeting.project
    proj_slug = safe_filename_slug(project.name or "project")

    pdf_bytes = generate_meeting_minutes_pdf(meeting)
    pdf_bytes = add_status_form_fields(pdf_bytes, len(meeting.client_facing_actions))
    pdf_filename = meeting_filename(meeting, "Meeting_Minutes", "pdf")
    pdf_path = storage.save(f"{proj_slug}/{pdf_filename}", pdf_bytes)

    docx_bytes = generate_meeting_minutes_docx(meeting)
    docx_filename = meeting_filename(meeting, "Meeting_Minutes", "docx")
    docx_path = storage.save(f"{proj_slug}/{docx_filename}", docx_bytes)

    actions = all_actions(session, project.id)
    xlsx_bytes = generate_action_items_xlsx(project, actions)
    xlsx_filename = (
        f"Action_Items_Log_"
        f"{safe_filename_slug(project.client.name) if project.client else 'project'}.xlsx"
    )
    xlsx_path = storage.save(f"{proj_slug}/{xlsx_filename}", xlsx_bytes)

    # ---- Audit-trail rows ----
    # One GeneratedDocument per artifact. We log the FINAL versions only;
    # the in-memory preview builds in `build_meeting_docs()` are intentionally
    # not logged because they're transient.
    for kind, filename, path, payload in (
        ("minutes_pdf", pdf_filename, pdf_path, pdf_bytes),
        ("minutes_docx", docx_filename, docx_path, docx_bytes),
        ("actions_xlsx", xlsx_filename, xlsx_path, xlsx_bytes),
    ):
        session.add(GeneratedDocument(
            meeting_id=meeting.id,
            kind=kind,
            filename=filename,
            storage_path=path,
            file_size_bytes=len(payload),
            is_draft=False,
        ))

    meeting.stage = "final"
    meeting.updated_at = datetime.utcnow()
    session.flush()

    return {"pdf": pdf_path, "docx": docx_path, "xlsx": xlsx_path}


# ============================================================
# Pre-meeting agenda
# ============================================================
class _DraftAttendeeView:
    __slots__ = ("full_name", "initials", "organization")

    def __init__(self, full_name, initials, organization=None):
        self.full_name = full_name
        self.initials = initials
        self.organization = organization


class _DraftMeetingView:
    __slots__ = ("project", "meeting_date", "attendees")

    def __init__(self, project, meeting_date, attendees):
        self.project = project
        self.meeting_date = meeting_date
        self.attendees = attendees


def build_draft_meeting_view(
    session: Session,
    project: Project,
    upcoming_date: date,
    attendees: Optional[list[dict]] = None,
    source_meeting_id: Optional[int] = None,
) -> _DraftMeetingView:
    """Build the in-memory Meeting-shaped view that the agenda docgen consumes.

    If `attendees` is supplied we use those verbatim (this is the typical path
    from the Next Agenda editor — PM has hand-curated the list). Otherwise we
    pull from the source meeting (or latest meeting) just like the Streamlit
    `generate_next_agenda` does.
    """
    if attendees:
        att_views = [
            _DraftAttendeeView(
                full_name=a.get("full_name") or a.get("initials") or "",
                initials=a.get("initials") or "",
                organization=a.get("organization") or "",
            ) for a in attendees
        ]
        return _DraftMeetingView(
            project=project, meeting_date=upcoming_date, attendees=att_views,
        )

    source = None
    if source_meeting_id:
        source = session.get(Meeting, source_meeting_id)
    if source is None:
        source = latest_meeting(session, project.id)

    att_views = []
    if source:
        for a in source.attendees:
            att_views.append(_DraftAttendeeView(
                full_name=a.full_name, initials=a.initials,
                organization=a.organization,
            ))
    return _DraftMeetingView(
        project=project, meeting_date=upcoming_date, attendees=att_views,
    )
