// ===== Domain types — match backend Pydantic models =====

/** Per-user attribution stub embedded in models (matches backend UserStub). */
export interface UserStub {
  id: number;
  name?: string | null;
  email?: string | null;
}

/** Shape returned by `GET /api/me` — the DB-backed UserOut. `is_admin`
 * controls scope-toggle defaulting and the "all projects" bypass on
 * the membership-aware list endpoints. */
export interface MeResponse {
  id: number;
  oid: string;
  email?: string | null;
  name?: string | null;
  is_admin: boolean;
}

/** Project membership row — one user assigned as a PM to a portfolio.
 *  Returned from `GET /api/projects/{id}/members`. */
export interface ProjectMember {
  id: number;
  project_id: number;
  user_id: number;
  user?: UserStub | null;
  created_at?: string;
}

export interface Client {
  id: number;
  name: string;
  email_domain?: string | null;
  created_at?: string;
}

export interface Project {
  id: number;
  client_id: number;
  name: string;
  scope?: string | null;
  schedule_version?: string | null;
  sub_projects_json?: string[] | null;
  created_at?: string;
}

export interface Attendee {
  id: number;
  full_name: string;
  initials: string;
  organization?: string | null;
  email?: string | null;
}

export interface GlobalAttendee extends Attendee {}

export interface AttendeeInput {
  full_name: string;
  initials: string;
  organization?: string;
  email?: string;
}

export interface AgendaItem {
  id: number;
  order_index: number;
  text: string;
  discipline?: string;
}

export interface DiscussionPoint {
  id: number;
  parent_id: number | null;
  order_index: number;
  label?: string;
  content: string;
  discipline?: string;
  ai_extracted?: boolean;
  sub_points: DiscussionPoint[];
}

export interface Deliverable {
  id: number;
  project_id: number;
  project_segment?: string | null;
  task: string;
  start_status?: string | null;
  delivery_date?: string | null;
  source?: string | null;
  schedule_version_added?: string | null;
}

export interface MeetingDeliverable {
  id: number;
  order_index: number;
  carried_from_prior: boolean;
  risk_flag: boolean;
  deliverable: Deliverable;
}

export interface ActionItem {
  id: number;
  project_id: number;
  originating_meeting_id: number;
  closed_in_meeting_id?: number | null;
  text: string;
  owner?: string | null;
  /** Canonical link when the owner is a PMO 360 PM. Coexists with the
   *  freeform `owner` string so external owners (vendors) still render. */
  owner_user_id?: number | null;
  owner_user?: UserStub | null;
  due_date?: string | null;
  status: string;
  created_by?: UserStub | null;
  updated_by?: UserStub | null;
  created_at?: string;
  updated_at?: string;
}

export interface MeetingAttendee {
  id: number;
  full_name: string;
  initials: string;
  organization?: string | null;
  email?: string | null;
}

export interface Meeting {
  id: number;
  project_id: number;
  meeting_date: string;
  title?: string | null;
  stage: string;
  schedule_version_at_meeting?: string | null;
  /** Optimistic concurrency token — echo back on save, server returns 409 if stale. */
  version: number;
  created_by?: UserStub | null;
  updated_by?: UserStub | null;
  created_at?: string;
  updated_at?: string;
}

/** One PM-uploaded supporting file (site photo, vendor PDF, etc.) tied
 *  to a meeting. Mirrors backend's MeetingAttachmentOut. */
export interface MeetingAttachmentSummary {
  id: number;
  meeting_id: number;
  filename: string;
  content_type?: string | null;
  file_size_bytes?: number | null;
  description?: string | null;
  created_by?: UserStub | null;
  created_at?: string;
}

export interface MeetingDetail extends Meeting {
  raw_notes?: string | null;
  closing_remarks?: string | null;
  /** AI-generated executive summary, rendered at the top of the PDF. Null
   *  until the first save with successful OpenAI response. */
  executive_summary?: string | null;
  attendees: MeetingAttendee[];
  agenda_items: AgendaItem[];
  discussion_points: DiscussionPoint[];
  raised_actions: ActionItem[];
  meeting_deliverables: MeetingDeliverable[];
  /** Newest-first; empty when no PM has uploaded supporting docs yet. */
  attachments: MeetingAttachmentSummary[];
}

// Parsed LLM output
export interface ParsedAttendee {
  full_name: string;
  initials: string;
  organization: string;
}
export interface ParsedAgendaItem {
  text: string;
  discipline: string;
}
export interface ParsedDiscussionPoint {
  label: string;
  content: string;
  discipline: string;
  sub_points: ParsedDiscussionPoint[];
}
export interface ParsedActionItem {
  text: string;
  owner: string;
  due_date: string | null;
  status: string;
}
export interface ParsedMeeting {
  attendees: ParsedAttendee[];
  agenda_items: ParsedAgendaItem[];
  discussion_points: ParsedDiscussionPoint[];
  action_items: ParsedActionItem[];
}

export interface ParseRequest {
  project_id: number;
  minutes_text?: string;
  agenda_text?: string;
  actions_text?: string;
  attendees_roster?: AttendeeInput[];
}

export interface DeliverableInput {
  project_segment?: string | null;
  task: string;
  start_status?: string;
  delivery_date?: string | null;
}

export interface MeetingSaveRequest {
  project_id: number;
  meeting_id?: number | null;
  /** Optimistic concurrency: send the version you read; server returns 409 if stale. */
  expected_version?: number | null;
  meeting_date: string;
  title?: string | null;
  raw_notes?: string;
  closing_remarks?: string | null;
  deliverables: DeliverableInput[];
  parsed: ParsedMeeting;
}

// Notes
export interface Note {
  id: number;
  project_id: number;
  project_area?: string | null;
  source?: string | null;
  topic?: string | null;
  action_needed?: string | null;
  note_date: string;
  follow_up_date?: string | null;
  priority?: string | null;
  status?: string | null;
  created_by?: UserStub | null;
  updated_by?: UserStub | null;
  created_at?: string;
  updated_at?: string;
}

// Agendas
export interface Agenda {
  id: number;
  project_id: number;
  upcoming_date: string;
  source_meeting_id?: number | null;
  title?: string | null;
  meeting_duration_minutes?: number;
  schedule_version_override?: string | null;
  /** Optimistic concurrency token — see Meeting.version. */
  version: number;
  created_by?: UserStub | null;
  updated_by?: UserStub | null;
  disciplines_json?: string[] | null;
  dp_text_json?: Record<string, any> | null;
  recap_text_json?: Record<string, any> | null;
  attendees_json?: any[] | null;
  open_actions_json?: any[] | null;
  risks_json?: any[] | null;
  decisions_json?: any[] | null;
  schedule_changes_json?: any[] | null;
  created_at?: string;
  updated_at?: string;
}

export interface AgendaSaveRequest {
  project_id: number;
  agenda_id?: number | null;
  /** Optimistic concurrency: send the version you read; server returns 409 if stale. */
  expected_version?: number | null;
  upcoming_date: string;
  source_meeting_id?: number | null;
  title?: string | null;
  meeting_duration_minutes?: number;
  schedule_version_override?: string | null;
  disciplines: string[];
  dp_text: Record<string, any>;
  recap_text: Record<string, any>;
  attendees: any[];
  open_actions: any[];
  risks: any[];
  decisions: any[];
  schedule_changes: any[];
}

export interface AgendaDocRequest {
  project_id: number;
  upcoming_date: string;
  title?: string | null;
  source_meeting_id?: number | null;
  meeting_duration_minutes?: number;
  schedule_version_override?: string | null;
  disciplines: string[];
  dp_by_discipline: Record<string, any[]>;
  recap_by_discipline: Record<string, any[]>;
  attendees: any[];
  open_actions: any[];
  risks: any[];
  decisions: any[];
  schedule_changes: any[];
}

// Schedule
export interface ScheduleItem {
  id?: number;
  order_index: number;
  indent_level: number;
  discipline?: string;
  phase?: string;
  task: string;
  duration_days?: number | null;
  start_date?: string | null;
  finish_date?: string | null;
  price?: number | null;
  is_milestone: boolean;
}

export interface Schedule {
  id: number;
  project_id: number;
  version: string;
  source_filename?: string | null;
  source_format?: string | null;
  project_start_date?: string | null;
  total_duration_days?: number | null;
  total_price?: number | null;
  uploaded_at?: string;
  items: ScheduleItem[];
}

export interface ParsedSchedule {
  version: string;
  source_format: string;
  source_filename: string;
  project_name: string;
  project_start_date?: string | null;
  total_duration_days?: number | null;
  total_price?: number | null;
  items: ScheduleItem[];
  parse_engine?: string; // "regex" (fast) | "llm" (AI)
}

// Lead / admin cross-portfolio overview
export interface LeadTotals {
  portfolios: number;
  clients: number;
  pms: number;
  open_actions: number;
  overdue_actions: number;
  open_risks: number;
  unassigned_open_actions: number;
}
export interface LeadPortfolioRow {
  project_id: number;
  name: string;
  client_name?: string | null;
  schedule_version?: string | null;
  member_count: number;
  open_actions: number;
  overdue_actions: number;
  open_risks: number;
  last_meeting_date?: string | null;
}
export interface LeadPmRow {
  user_id: number;
  name: string;
  email: string;
  is_admin: boolean;
  portfolios: number;
  open_actions: number;
  overdue_actions: number;
}
export interface LeadOverview {
  totals: LeadTotals;
  portfolios: LeadPortfolioRow[];
  pms: LeadPmRow[];
}

// Timeline Estimator
export type TimelineStatus =
  | "delayed"
  | "on_hold"
  | "not_contracted"
  | "in_progress"
  | "ahead"
  | "complete";
export interface TimelineResource {
  id: number;
  name: string;
  user_id?: number | null;
  discipline: string;
  title?: string | null;
  is_placeholder: boolean;
  available_from?: string | null;
  active: boolean;
  order_index: number;
}
export interface TimelineProject {
  id: number;
  name: string;
  client?: string | null;
  status: string;
  notes?: string | null;
  version: number;
}
export interface TimelineAssignment {
  id: number;
  timeline_project_id: number;
  resource_id?: number | null;
  discipline: string;
  milestone?: string | null;
  start_date: string;
  end_date: string;
  utilization: number;
  status?: string | null;
  label?: string | null;
  order_index: number;
  version: number;
  project_name?: string | null;
  client?: string | null;
  effective_status?: string | null;
}
export interface TimelineTimeOff {
  id: number;
  resource_id: number;
  start_date: string;
  end_date: string;
  reason?: string | null;
}
export interface TimelineBoard {
  weeks: string[];
  resources: TimelineResource[];
  projects: TimelineProject[];
  assignments: TimelineAssignment[];
  timeoff: TimelineTimeOff[];
  load: Record<string, number[]>;
  availability: Record<string, number[]>;
  clients: string[];
}

// Proposals — Castillo proposal builder (ported desktop tool). The editable
// schedule tree mirrors the Tkinter task tree; dates are server-computed.
export interface ProposalItemNode {
  id: number | null;
  name: string;
  duration: number;
  price: number;
  start_date: string;
  end_date: string;
  is_milestone: boolean;
  indent_level: number;
  predecessor_id: number | null;
  predecessor_type: "FS" | "FF" | "SS" | "SF";
  predecessor_type_user_set: boolean;
  lag: number;
  targeted_hours: number | null;
  is_start_pinned: boolean;
  enabled: boolean;
  price_only: boolean;
  show_start_date: boolean;
  show_end_date: boolean;
  /** UI-only: protect this row's editable fields from accidental edits. */
  locked?: boolean;
  task_utilization: number | null;
  parent_id: number | null;
  children: ProposalItemNode[];
}
export interface ProposalOut {
  id: number;
  title: string;
  customer_name: string | null;
  project_location: string | null;
  project_state: string | null;
  project_size_mw: string | null;
  portfolio_id: number | null;
  linked_schedule_id: number | null;
  current_version_id: number | null;
  version: number;
  created_at: string | null;
  updated_at: string | null;
}
export interface ProposalListItem extends ProposalOut {
  current_label: string | null;
  version_count: number;
  portfolio_name: string | null;
}
export interface ProposalVersionOut {
  id: number;
  proposal_id: number;
  label: string;
  computed_start_date: string | null;
  computed_end_date: string | null;
  total_price: number | null;
  source_filename: string | null;
  source_format: string | null;
  linked_schedule_id: number | null;
  version: number;
  created_at: string | null;
}
export interface ProposalVersionDetail extends ProposalVersionOut {
  info: Record<string, any>;
  config: Record<string, any>;
  tree: ProposalItemNode[];
}
export interface ProposalBoard {
  proposal: ProposalOut;
  version: ProposalVersionDetail;
  versions: ProposalVersionOut[];
}

// Split Deposit — persisted inside ProposalVersionDetail.info under the
// `split_deposit_memory` key (info is Record<string, any> so arbitrary keys
// round-trip). Mirrors the desktop tool's split-deposit memory blob 1:1.
export interface SplitDepositMemory {
  deposit_percentage: number; // default 30.0
  split_mode: "percent_of_each" | "percent_of_deposit"; // default "percent_of_each"
  deposit_target: "deposit" | "due_diligence"; // default "deposit"
  has_been_applied: boolean; // default false
  task_percentages: Record<string, number>;
  original_task_prices: Record<string, number>;
  original_target_prices: Record<string, number>;
  selected_task_keys: string[];
}
// One undo snapshot — component state only, NOT persisted.
export interface SplitHistoryEntry {
  timestamp: string;
  task_states: Record<string, number>;
  target_states: Record<string, number>;
}

// Dashboard
export interface DashboardAction {
  id: number;
  project_id: number;
  text: string;
  owner?: string | null;
  due_date?: string | null;
  status: string;
  project_name?: string | null;
  client_name?: string | null;
}
export interface DashboardNote {
  id: number;
  project_id: number;
  topic?: string | null;
  action_needed?: string | null;
  follow_up_date?: string | null;
  priority?: string | null;
  project_name?: string | null;
  client_name?: string | null;
}
export interface DashboardAgenda {
  id: number;
  project_id: number;
  upcoming_date: string;
  title?: string | null;
  project_name?: string | null;
  client_name?: string | null;
}
export interface DashboardResponse {
  open_actions: DashboardAction[];
  follow_up_notes: DashboardNote[];
  upcoming_agendas: DashboardAgenda[];
}

// Meeting templates — recurring-meeting boilerplate (attendees, agenda
// topics, default deliverables, duration). Cloning hydrates the in-progress
// draft directly; the JSON blobs use the same shapes the Capture/Review
// pages already work with so there's no translation step.
export interface TemplateAttendee {
  full_name: string;
  initials: string;
  organization?: string;
  email?: string;
}
export interface TemplateAgendaTopic {
  text: string;
  discipline?: string;
}
export interface TemplateDeliverable {
  project_segment?: string;
  task: string;
  start_status?: string;
}
export interface MeetingTemplate {
  id: number;
  project_id: number;
  name: string;
  attendees_json?: TemplateAttendee[] | null;
  agenda_topics_json?: TemplateAgendaTopic[] | null;
  default_duration_minutes: number;
  default_deliverables_json?: TemplateDeliverable[] | null;
  created_by?: UserStub | null;
  created_at?: string;
  updated_at?: string;
  /** ISO timestamp of the most recent clone. Null when never cloned —
   *  the Capture page sorts those last in the "recently used" rail. */
  last_used_at?: string | null;
}

export interface MeetingTemplateInput {
  project_id: number;
  name: string;
  attendees_json?: TemplateAttendee[];
  agenda_topics_json?: TemplateAgendaTopic[];
  default_duration_minutes?: number;
  default_deliverables_json?: TemplateDeliverable[];
}

// Settings
export interface Settings {
  app: {
    title: string;
    tagline: string;
    tool_name: string;
    timezone: string;
    local_dev_mode: boolean;
  };
  openai: { model: string | null };
  brand: Record<string, any>;
}
