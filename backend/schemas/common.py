"""Common Pydantic response/request shapes shared across routers."""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional, Any

from pydantic import BaseModel, ConfigDict, Field


class ORMModel(BaseModel):
    """Base class that lets routers serialize SQLAlchemy ORM objects directly."""
    model_config = ConfigDict(from_attributes=True)


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
    due_date: Optional[date] = None
    status: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


# ---------- Meetings ----------
class MeetingSummary(ORMModel):
    id: int
    project_id: int
    meeting_date: date
    title: Optional[str] = None
    stage: str
    schedule_version_at_meeting: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class MeetingDetail(MeetingSummary):
    raw_notes: Optional[str] = None
    closing_remarks: Optional[str] = None
    attendees: list[MeetingAttendeeOut] = Field(default_factory=list)
    agenda_items: list[AgendaItemOut] = Field(default_factory=list)
    discussion_points: list[DiscussionPointOut] = Field(default_factory=list)
    raised_actions: list[ActionItemOut] = Field(default_factory=list)
    meeting_deliverables: list[MeetingDeliverableOut] = Field(default_factory=list)


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
    meeting_date: date
    title: Optional[str] = None
    raw_notes: Optional[str] = ""
    closing_remarks: Optional[str] = None
    deliverables: list[DeliverableInput] = Field(default_factory=list)
    parsed: ParsedMeetingOut


# ---------- Action items ----------
class ActionItemUpdate(BaseModel):
    text: Optional[str] = None
    owner: Optional[str] = None
    due_date: Optional[date] = None
    status: Optional[str] = None
    closing_meeting_id: Optional[int] = None


class ActionItemCreate(BaseModel):
    project_id: int
    originating_meeting_id: int
    text: str
    owner: Optional[str] = ""
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


class ScheduleSaveRequest(BaseModel):
    project_id: int
    parsed: ParsedScheduleOut


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


# Re-enable forward refs
DiscussionPointOut.model_rebuild()
ParsedDiscussionPointOut.model_rebuild()
