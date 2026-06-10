"""Common Pydantic response/request shapes shared across routers."""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional, Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ORMModel(BaseModel):
    """Base class that lets routers serialize SQLAlchemy ORM objects directly."""
    model_config = ConfigDict(from_attributes=True)


# ---------- Users ----------
class UserOut(ORMModel):
    """The validated identity surfaced to the frontend. Used both standalone
    (on /api/me + /api/users/*) and embedded inline as `created_by` /
    `updated_by` on every model that carries attribution."""
    id: int
    oid: str
    email: Optional[str] = None
    name: Optional[str] = None
    is_admin: bool = False


class UserStub(ORMModel):
    """Trimmed user surface for inline embedding — no oid, just what the UI
    actually shows on 'Saved by Arun · 2h ago' lines."""
    id: int
    name: Optional[str] = None
    email: Optional[str] = None


# ---------- Project membership ----------
class ProjectMemberOut(ORMModel):
    id: int
    project_id: int
    user_id: int
    user: Optional[UserStub] = None
    created_at: Optional[datetime] = None


class UserPreferences(BaseModel):
    """Per-user preferences persisted on User.preferences (JSON).

    All fields have sensible defaults so the response works even when
    the user has never saved their settings.
    """
    default_project_id: Optional[int] = None
    default_meeting_duration: int = 30  # minutes, typically 30 or 60
    default_action_due_offset_days: int = 7
    email_signature: Optional[str] = None  # appended to outgoing Graph emails
    # When True, the Send page auto-fires the Graph email to meeting
    # attendees (with the minutes PDF attached) immediately after the PM
    # finalizes a meeting — no extra click. Off by default so the existing
    # review-then-send flow stays the norm; PMs opt in from Settings.
    # The send still happens client-side via the PM's delegated Mail.Send
    # token (we never send server-side on their behalf), so it only fires
    # when the PM is signed in and has consented to Mail.Send.
    auto_send_minutes_on_finalize: bool = False


# ---------- Clients / Projects ----------
class ClientOut(ORMModel):
    id: int
    name: str
    email_domain: Optional[str] = None
    created_at: Optional[datetime] = None


class ClientCreate(BaseModel):
    name: str
    email_domain: Optional[str] = None


class ProjectOut(ORMModel):
    id: int
    client_id: int
    name: str
    scope: Optional[str] = None
    schedule_version: Optional[str] = None
    sub_projects_json: Optional[list[str]] = None
    created_at: Optional[datetime] = None


class ProjectCreate(BaseModel):
    client_id: int
    name: str
    scope: Optional[str] = None
    schedule_version: Optional[str] = "V1"
    sub_projects_json: Optional[list[str]] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    scope: Optional[str] = None
    schedule_version: Optional[str] = None
    sub_projects_json: Optional[list[str]] = None


# ---------- Roster ----------
class AttendeeOut(ORMModel):
    id: int
    full_name: str
    initials: str
    organization: Optional[str] = None
    email: Optional[str] = None


class AttendeeIn(BaseModel):
    full_name: str
    initials: str
    organization: Optional[str] = ""
    email: Optional[str] = ""


class GlobalAttendeeOut(ORMModel):
    id: int
    full_name: str
    initials: str
    organization: Optional[str] = None
    email: Optional[str] = None


# ---------- Meeting children ----------
class MeetingAttendeeOut(ORMModel):
    id: int
    full_name: str
    initials: str
    organization: Optional[str] = None
    email: Optional[str] = None


class AgendaItemOut(ORMModel):
    id: int
    order_index: int
    text: str
    discipline: Optional[str] = None


class DiscussionPointOut(ORMModel):
    id: int
    parent_id: Optional[int] = None
    order_index: int
    label: Optional[str] = None
    content: str
    discipline: Optional[str] = None
    ai_extracted: bool = False
    sub_points: list["DiscussionPointOut"] = Field(default_factory=list)


class DeliverableOut(ORMModel):
    id: int
    project_id: int
    project_segment: Optional[str] = None
    task: str
    start_status: Optional[str] = None
    delivery_date: Optional[date] = None
    source: Optional[str] = None
    schedule_version_added: Optional[str] = None


class MeetingDeliverableOut(ORMModel):
    id: int
    order_index: int
    carried_from_prior: bool
    risk_flag: bool
    deliverable: DeliverableOut


class ActionItemOut(ORMModel):
    id: int
    project_id: int
    originating_meeting_id: int
    closed_in_meeting_id: Optional[int] = None
    text: str
    owner: Optional[str] = None
    # First-class user link when the owner is on the PMO 360 team. Coexists
    # with the freeform ``owner`` string so external owners (vendors) still
    # render in the action log without a User row.
    owner_user_id: Optional[int] = None
    owner_user: Optional[UserStub] = None
    due_date: Optional[date] = None
    status: str
    created_by: Optional[UserStub] = None
    updated_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


# ---------- Attachments ----------
class MeetingAttachmentOut(ORMModel):
    """One PM-uploaded file attached to a meeting. The bytes themselves
    are fetched via the dedicated download endpoint — this surface only
    carries the metadata the UI renders in the attachment list."""
    id: int
    meeting_id: int
    filename: str
    content_type: Optional[str] = None
    file_size_bytes: Optional[int] = None
    description: Optional[str] = None
    created_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None


# ---------- Meetings ----------
class MeetingSummary(ORMModel):
    id: int
    project_id: int
    meeting_date: date
    title: Optional[str] = None
    stage: str
    schedule_version_at_meeting: Optional[str] = None
    # Optimistic concurrency token — see Meeting.version.
    version: int = 1
    created_by: Optional[UserStub] = None
    updated_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class MeetingDetail(MeetingSummary):
    raw_notes: Optional[str] = None
    closing_remarks: Optional[str] = None
    executive_summary: Optional[str] = None
    attendees: list[MeetingAttendeeOut] = Field(default_factory=list)
    agenda_items: list[AgendaItemOut] = Field(default_factory=list)
    discussion_points: list[DiscussionPointOut] = Field(default_factory=list)
    raised_actions: list[ActionItemOut] = Field(default_factory=list)
    meeting_deliverables: list[MeetingDeliverableOut] = Field(default_factory=list)
    attachments: list[MeetingAttachmentOut] = Field(default_factory=list)


# ---------- Parsed-LLM output for the parse endpoint ----------
class ParsedAttendeeOut(BaseModel):
    full_name: str
    initials: str
    organization: str = ""


class ParsedAgendaItemOut(BaseModel):
    text: str
    discipline: str = "General"


class ParsedDiscussionPointOut(BaseModel):
    label: str
    content: str
    discipline: str = "General"
    sub_points: list["ParsedDiscussionPointOut"] = Field(default_factory=list)


class ParsedActionItemOut(BaseModel):
    text: str
    owner: str = ""
    due_date: Optional[str] = None
    status: str = "open"


class ParsedMeetingOut(BaseModel):
    attendees: list[ParsedAttendeeOut] = Field(default_factory=list)
    agenda_items: list[ParsedAgendaItemOut] = Field(default_factory=list)
    discussion_points: list[ParsedDiscussionPointOut] = Field(default_factory=list)
    action_items: list[ParsedActionItemOut] = Field(default_factory=list)


class ParseRequest(BaseModel):
    project_id: int
    minutes_text: str = ""
    agenda_text: str = ""
    actions_text: str = ""
    attendees_roster: Optional[list[AttendeeIn]] = None


# ---------- Save / Update meeting ----------
class DeliverableInput(BaseModel):
    project_segment: Optional[str] = None
    task: str
    start_status: Optional[str] = "In Progress"
    delivery_date: Optional[date] = None


class MeetingSaveRequest(BaseModel):
    project_id: int
    meeting_id: Optional[int] = None  # set to update existing
    # Optimistic concurrency: clients echo back the version they read.
    # Required when meeting_id is set; ignored on new-meeting creates.
    expected_version: Optional[int] = None
    meeting_date: date
    title: Optional[str] = None
    raw_notes: Optional[str] = ""
    closing_remarks: Optional[str] = None
    deliverables: list[DeliverableInput] = Field(default_factory=list)
    parsed: ParsedMeetingOut


# ---------- Meeting metadata patch ----------
class MeetingMetaUpdate(BaseModel):
    """Lightweight patch for the History page — rename a meeting or change
    its stage (draft/final/sent) without re-sending the whole parsed
    payload. Both fields optional so a rename ships just ``title`` and a
    status change ships just ``stage``."""
    title: Optional[str] = None
    stage: Optional[str] = None


# ---------- Action items ----------
class ActionItemUpdate(BaseModel):
    text: Optional[str] = None
    owner: Optional[str] = None
    # Pass a user id to bind this action to a PMO 360 PM. Pass ``null`` to
    # explicitly clear the user link (e.g. action reassigned to a vendor);
    # omit the field entirely to leave the existing link untouched.
    owner_user_id: Optional[int] = None
    due_date: Optional[date] = None
    status: Optional[str] = None
    closing_meeting_id: Optional[int] = None


class ActionItemCreate(BaseModel):
    project_id: int
    originating_meeting_id: int
    text: str
    owner: Optional[str] = ""
    owner_user_id: Optional[int] = None
    due_date: Optional[date] = None
    status: str = "open"


# ---------- Notes ----------
class NoteOut(ORMModel):
    id: int
    project_id: int
    project_area: Optional[str] = None
    source: Optional[str] = None
    topic: Optional[str] = None
    action_needed: Optional[str] = None
    note_date: date
    follow_up_date: Optional[date] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    created_by: Optional[UserStub] = None
    updated_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class NoteIn(BaseModel):
    project_id: int
    project_area: Optional[str] = None
    source: Optional[str] = None
    topic: Optional[str] = None
    action_needed: Optional[str] = None
    note_date: date
    follow_up_date: Optional[date] = None
    priority: str = "Medium"
    status: str = "open"


class NoteUpdate(BaseModel):
    project_area: Optional[str] = None
    source: Optional[str] = None
    topic: Optional[str] = None
    action_needed: Optional[str] = None
    note_date: Optional[date] = None
    follow_up_date: Optional[date] = None
    priority: Optional[str] = None
    status: Optional[str] = None


# ---------- Pre-meeting agendas ----------
class AgendaOut(ORMModel):
    id: int
    project_id: int
    upcoming_date: date
    source_meeting_id: Optional[int] = None
    title: Optional[str] = None
    meeting_duration_minutes: Optional[int] = 30
    schedule_version_override: Optional[str] = None
    # Optimistic concurrency token — see Agenda.version.
    version: int = 1
    created_by: Optional[UserStub] = None
    updated_by: Optional[UserStub] = None
    disciplines_json: Optional[list[str]] = None
    dp_text_json: Optional[dict[str, Any]] = None
    recap_text_json: Optional[dict[str, Any]] = None
    attendees_json: Optional[list[dict[str, Any]]] = None
    open_actions_json: Optional[list[dict[str, Any]]] = None
    risks_json: Optional[list[dict[str, Any]]] = None
    decisions_json: Optional[list[dict[str, Any]]] = None
    schedule_changes_json: Optional[list[dict[str, Any]]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class AgendaIn(BaseModel):
    project_id: int
    agenda_id: Optional[int] = None
    # Optimistic concurrency: clients echo back the version they read.
    # Required when agenda_id is set; ignored on new-agenda creates.
    expected_version: Optional[int] = None
    upcoming_date: date
    source_meeting_id: Optional[int] = None
    title: Optional[str] = None
    meeting_duration_minutes: int = 30
    schedule_version_override: Optional[str] = None
    disciplines: list[str] = Field(default_factory=list)
    dp_text: dict[str, Any] = Field(default_factory=dict)
    recap_text: dict[str, Any] = Field(default_factory=dict)
    attendees: list[dict[str, Any]] = Field(default_factory=list)
    open_actions: list[dict[str, Any]] = Field(default_factory=list)
    risks: list[dict[str, Any]] = Field(default_factory=list)
    decisions: list[dict[str, Any]] = Field(default_factory=list)
    schedule_changes: list[dict[str, Any]] = Field(default_factory=list)


# ---------- Meeting templates ----------
class MeetingTemplateOut(ORMModel):
    """A saved recurring-meeting template. The JSON blobs mirror the shapes
    used by the in-progress draft (selectedAttendees, parsed.agenda_items,
    selectedDeliverables) so cloning is a direct hydrate."""
    id: int
    project_id: int
    name: str
    attendees_json: Optional[list[dict[str, Any]]] = None
    agenda_topics_json: Optional[list[dict[str, Any]]] = None
    default_duration_minutes: int = 60
    default_deliverables_json: Optional[list[dict[str, Any]]] = None
    created_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Most recent clone time. Null when the template has never been cloned —
    # the Capture page sorts those last in the "recently used" rail.
    last_used_at: Optional[datetime] = None


class MeetingTemplateIn(BaseModel):
    project_id: int
    name: str
    attendees_json: list[dict[str, Any]] = Field(default_factory=list)
    agenda_topics_json: list[dict[str, Any]] = Field(default_factory=list)
    default_duration_minutes: int = 60
    default_deliverables_json: list[dict[str, Any]] = Field(default_factory=list)


class MeetingTemplateUpdate(BaseModel):
    """Partial-update payload. Every field optional so rename can ship a
    single-field PATCH and a full re-save can ship everything."""
    name: Optional[str] = None
    attendees_json: Optional[list[dict[str, Any]]] = None
    agenda_topics_json: Optional[list[dict[str, Any]]] = None
    default_duration_minutes: Optional[int] = None
    default_deliverables_json: Optional[list[dict[str, Any]]] = None


# ---------- Schedule ----------
class ScheduleItemOut(ORMModel):
    id: int
    order_index: int
    indent_level: int
    discipline: Optional[str] = None
    phase: Optional[str] = None
    task: str
    duration_days: Optional[int] = None
    start_date: Optional[date] = None
    finish_date: Optional[date] = None
    price: Optional[int] = None
    is_milestone: bool = False


class ScheduleOut(ORMModel):
    id: int
    project_id: int
    version: str
    source_filename: Optional[str] = None
    source_format: Optional[str] = None
    project_start_date: Optional[date] = None
    total_duration_days: Optional[int] = None
    total_price: Optional[int] = None
    uploaded_at: Optional[datetime] = None
    items: list[ScheduleItemOut] = Field(default_factory=list)


class ParsedScheduleItemOut(BaseModel):
    order_index: int
    indent_level: int
    discipline: str = ""
    phase: str = ""
    task: str
    duration_days: Optional[int] = None
    start_date: Optional[date] = None
    finish_date: Optional[date] = None
    price: Optional[int] = None
    is_milestone: bool = False


class ParsedScheduleOut(BaseModel):
    version: str = "V1"
    source_format: str
    source_filename: str = ""
    project_name: str = ""
    project_start_date: Optional[date] = None
    total_duration_days: Optional[int] = None
    total_price: Optional[int] = None
    items: list[ParsedScheduleItemOut] = Field(default_factory=list)
    parse_engine: str = "regex"             # "regex" (fast) | "llm" (AI)


class ScheduleSaveRequest(BaseModel):
    project_id: int
    parsed: ParsedScheduleOut


# ---------- Lead / admin cross-portfolio overview ----------
class LeadTotals(BaseModel):
    portfolios: int
    clients: int
    pms: int
    open_actions: int
    overdue_actions: int
    open_risks: int
    unassigned_open_actions: int


class LeadPortfolioRow(BaseModel):
    project_id: int
    name: str
    client_name: Optional[str] = None
    schedule_version: Optional[str] = None
    member_count: int = 0
    open_actions: int = 0
    overdue_actions: int = 0
    open_risks: int = 0
    last_meeting_date: Optional[date] = None


class LeadPmRow(BaseModel):
    user_id: int
    name: str
    email: str
    is_admin: bool = False
    portfolios: int = 0
    open_actions: int = 0
    overdue_actions: int = 0


class LeadOverviewResponse(BaseModel):
    totals: LeadTotals
    portfolios: list[LeadPortfolioRow] = Field(default_factory=list)
    pms: list[LeadPmRow] = Field(default_factory=list)


# ---------- Timeline Estimator ----------
class TimelineResourceIn(BaseModel):
    name: str
    user_id: Optional[int] = None
    discipline: str = "Electrical"
    title: Optional[str] = None
    is_placeholder: bool = False
    available_from: Optional[date] = None
    active: bool = True
    order_index: int = 0


class TimelineResourcePatch(BaseModel):
    name: Optional[str] = None
    user_id: Optional[int] = None
    discipline: Optional[str] = None
    title: Optional[str] = None
    is_placeholder: Optional[bool] = None
    available_from: Optional[date] = None
    active: Optional[bool] = None
    order_index: Optional[int] = None


class TimelineResourceOut(ORMModel):
    id: int
    name: str
    user_id: Optional[int] = None
    discipline: str = "Electrical"
    title: Optional[str] = None
    is_placeholder: bool = False
    available_from: Optional[date] = None
    active: bool = True
    order_index: int = 0


class TimelineProjectIn(BaseModel):
    name: str
    client: Optional[str] = None
    status: str = "in_progress"
    notes: Optional[str] = None


class TimelineProjectPatch(BaseModel):
    name: Optional[str] = None
    client: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    expected_version: Optional[int] = None   # optimistic-concurrency token


class TimelineProjectOut(ORMModel):
    id: int
    name: str
    client: Optional[str] = None
    status: str = "in_progress"
    notes: Optional[str] = None
    version: int = 1


class TimelineAssignmentIn(BaseModel):
    timeline_project_id: int
    resource_id: Optional[int] = None
    discipline: str = "Electrical"
    milestone: Optional[str] = None
    start_date: date
    end_date: date
    utilization: float = 1.0
    status: Optional[str] = None
    label: Optional[str] = None
    order_index: int = 0


class TimelineAssignmentPatch(BaseModel):
    resource_id: Optional[int] = None
    discipline: Optional[str] = None
    milestone: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    utilization: Optional[float] = None
    status: Optional[str] = None
    label: Optional[str] = None
    order_index: Optional[int] = None
    expected_version: Optional[int] = None   # optimistic-concurrency token


class TimelineAssignmentOut(BaseModel):
    id: int
    timeline_project_id: int
    resource_id: Optional[int] = None
    discipline: str = "Electrical"
    milestone: Optional[str] = None
    start_date: date
    end_date: date
    utilization: float = 1.0
    status: Optional[str] = None
    label: Optional[str] = None
    order_index: int = 0
    version: int = 1
    # enriched from the parent project for rendering
    project_name: Optional[str] = None
    client: Optional[str] = None
    effective_status: Optional[str] = None


class TimelineTimeOffIn(BaseModel):
    resource_id: int
    start_date: date
    end_date: date
    reason: Optional[str] = "OOO"


class TimelineTimeOffPatch(BaseModel):
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    reason: Optional[str] = None


class TimelineTimeOffOut(ORMModel):
    id: int
    resource_id: int
    start_date: date
    end_date: date
    reason: Optional[str] = None


class TimelineBoardResponse(BaseModel):
    weeks: list[date]                                   # Monday week-start dates
    resources: list[TimelineResourceOut] = Field(default_factory=list)
    projects: list[TimelineProjectOut] = Field(default_factory=list)
    assignments: list[TimelineAssignmentOut] = Field(default_factory=list)
    timeoff: list[TimelineTimeOffOut] = Field(default_factory=list)
    clients: list[str] = Field(default_factory=list)   # pick-list for the Client field
    # per-resource per-week utilization fraction, keyed by str(resource_id);
    # each value is a list aligned to `weeks`. over-allocated == load > avail.
    load: dict[str, list[float]] = Field(default_factory=dict)
    # per-resource per-week availability fraction (1.0 = fully available,
    # 0 = fully blocked by time-off), aligned to `weeks`.
    availability: dict[str, list[float]] = Field(default_factory=dict)


# ---------- Dashboard ----------
class DashboardActionOut(ORMModel):
    id: int
    project_id: int
    text: str
    owner: Optional[str] = None
    due_date: Optional[date] = None
    status: str
    project_name: Optional[str] = None
    client_name: Optional[str] = None


class DashboardNoteOut(ORMModel):
    id: int
    project_id: int
    topic: Optional[str] = None
    action_needed: Optional[str] = None
    follow_up_date: Optional[date] = None
    priority: Optional[str] = None
    project_name: Optional[str] = None
    client_name: Optional[str] = None


class DashboardAgendaOut(ORMModel):
    id: int
    project_id: int
    upcoming_date: date
    title: Optional[str] = None
    project_name: Optional[str] = None
    client_name: Optional[str] = None


class DashboardResponse(BaseModel):
    open_actions: list[DashboardActionOut] = Field(default_factory=list)
    follow_up_notes: list[DashboardNoteOut] = Field(default_factory=list)
    upcoming_agendas: list[DashboardAgendaOut] = Field(default_factory=list)


class DashboardRiskOut(BaseModel):
    """One open risk pulled from a portfolio's most-recent agenda for the
    Home risk-rollup card. We don't have a dedicated Risk model — risks
    live as free-form JSON inside ``Agenda.risks_json`` — so the fields
    here mirror what NextAgenda's editor saves.

    ``project_id`` + ``project_name`` + ``client_name`` are denormalised so
    the card can route to the source portfolio with one click without
    looking the names up again.
    """
    project_id: int
    project_name: str
    client_name: Optional[str] = None
    agenda_id: int
    upcoming_date: date
    description: str
    impact: Optional[str] = None
    likelihood: Optional[str] = None
    mitigation: Optional[str] = None
    owner: Optional[str] = None


class DashboardRisksResponse(BaseModel):
    risks: list[DashboardRiskOut] = Field(default_factory=list)


# ---------- AI Home briefing ----------
class BriefingResponse(BaseModel):
    """Personalized "since you were last here…" summary for the Home page.

    All counts are scoped to the signed-in user (matched on owner-string
    substring for actions; created_by for notes/agendas). The ``briefing``
    string is the LLM-written 2-3 sentence prose; on LLM failure it falls
    back to a deterministic template built from the same numeric facts —
    callers can render the response without worrying about partial data.
    """
    last_seen_at: Optional[datetime] = None
    new_actions_assigned_to_me: int = 0
    overdue_actions_assigned_to_me: int = 0
    new_meetings_touched: int = 0
    new_agendas_touched: int = 0
    new_follow_up_notes: int = 0
    briefing: str = ""


# ---------- Per-portfolio metrics (PortfolioDashboard page) ----------
class BurndownPoint(BaseModel):
    """One ISO-week's snapshot of the project's action backlog.

    See ``api/projects.py::get_project_metrics`` for the bucketing rules —
    ``open_at_end_of_week`` is the count of actions still open as of the
    Sunday of the week, and ``completed_this_week`` is the count of actions
    that transitioned to completed within the week's window.
    """
    week_start: date
    open_at_end_of_week: int
    completed_this_week: int


class PortfolioMetricsOut(BaseModel):
    """Health snapshot for a single portfolio, surfaced by the
    PortfolioDashboard page. All counts are project-lifetime totals unless the
    field name says otherwise."""
    project_id: int
    project_name: str
    client_name: Optional[str] = None
    # Counts
    total_meetings: int
    total_actions: int
    open_actions: int
    overdue_actions: int          # open/pending with due_date < today
    completed_actions: int
    cancelled_actions: int
    # Rate
    action_close_rate: float      # completed / total_actions, 0-1
    avg_actions_per_meeting: float
    # On-time delivery
    deliverables_total: int
    deliverables_on_time: int     # delivery_date >= today (we don't track
                                  # actual completion dates yet)
    on_time_rate: float           # 0-1
    # Last meeting
    last_meeting_date: Optional[date] = None
    days_since_last_meeting: Optional[int] = None
    # 8-week action burndown
    burndown: list[BurndownPoint] = Field(default_factory=list)
    # Most recent agenda's risks bucketed by likelihood (always 4 keys).
    risks_by_likelihood: dict[str, int] = Field(default_factory=dict)


# ---------- Agenda doc generation ----------
class AgendaDocRequest(BaseModel):
    project_id: int
    upcoming_date: date
    title: Optional[str] = None
    source_meeting_id: Optional[int] = None
    meeting_duration_minutes: int = 30
    schedule_version_override: Optional[str] = None
    disciplines: list[str] = Field(default_factory=list)
    dp_by_discipline: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    recap_by_discipline: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    attendees: list[dict[str, Any]] = Field(default_factory=list)
    open_actions: list[dict[str, Any]] = Field(default_factory=list)
    risks: list[dict[str, Any]] = Field(default_factory=list)
    decisions: list[dict[str, Any]] = Field(default_factory=list)
    schedule_changes: list[dict[str, Any]] = Field(default_factory=list)


# ---------- Global search (Cmd+K palette) ----------
class SearchResultOut(BaseModel):
    """One row in the Cmd+K results list.

    ``client_slug`` and ``portfolio_slug`` are precomputed server-side so the
    frontend can route straight to ``/path?client=<slug>&portfolio=<slug>``
    without an extra clients/projects fetch.
    """
    kind: Literal["client", "portfolio", "meeting", "agenda", "action"]
    id: int
    label: str
    subtitle: Optional[str] = None
    client_id: Optional[int] = None
    project_id: Optional[int] = None
    client_slug: Optional[str] = None
    portfolio_slug: Optional[str] = None


class SearchResponse(BaseModel):
    results: list[SearchResultOut] = Field(default_factory=list)


# Re-enable forward refs
DiscussionPointOut.model_rebuild()
ParsedDiscussionPointOut.model_rebuild()
