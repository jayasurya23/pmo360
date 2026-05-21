// ===== Domain types — match backend Pydantic models =====

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
  due_date?: string | null;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface MeetingAttendee {
  id: number;
  full_name: string;
  initials: string;
  organization?: string | null;
}

export interface Meeting {
  id: number;
  project_id: number;
  meeting_date: string;
  title?: string | null;
  stage: string;
  schedule_version_at_meeting?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MeetingDetail extends Meeting {
  raw_notes?: string | null;
  closing_remarks?: string | null;
  attendees: MeetingAttendee[];
  agenda_items: AgendaItem[];
  discussion_points: DiscussionPoint[];
  raised_actions: ActionItem[];
  meeting_deliverables: MeetingDeliverable[];
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
