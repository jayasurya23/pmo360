// ===== Domain types — match backend Pydantic models =====

/** Per-user attribution stub embedded in models (matches backend UserStub). */
export interface UserStub {
  id: number;
  name?: string | null;
  email?: string | null;
}

/** The eight grantable write permissions, in the order the grid renders them.
 *  Mirrors `auth/permissions.py::PERMISSIONS` — the backend rejects any name it
 *  doesn't know, so a typo here fails loudly rather than granting nothing. */
export type PermissionName =
  | "meeting_minutes"
  | "co_creation"
  | "co_approval"
  | "agenda"
  | "proposals"
  | "timeline"
  | "user_mgmt"
  | "client_mgmt";

/** Every permission with a definite answer. What the API returns is always
 *  EFFECTIVE — an admin comes back all-true, because the super-role really does
 *  imply all eight. The SPA never folds the admin bypass in itself; a second
 *  copy of an authorization rule is a second place for it to be wrong. */
export type UserPermissions = Record<PermissionName, boolean>;

/** A partial grant/revoke. Omitted names are left untouched server-side, which
 *  is what stops two checkboxes toggled a second apart from clobbering each
 *  other with a whole-map write. */
export type UserPermissionsPatch = Partial<UserPermissions>;

/** One column of the grid, described by the server so the header renders from
 *  the backend's vocabulary rather than a hardcoded copy of it.
 *  `scope: "global"` marks the three that take no portfolio: the two console
 *  permissions, because managing people and clients isn't portfolio work, and
 *  Timeline, because the capacity board plans people company-wide and none of
 *  its tables carries a portfolio to be a member of. */
export interface PermissionDef {
  name: PermissionName;
  label: string;
  scope: "portfolio" | "global";
}

/** Shape returned by `GET /api/me` — the DB-backed MeOut. `is_admin`
 * controls scope-toggle defaulting and the "all projects" bypass on
 * the membership-aware list endpoints. */
export interface MeResponse {
  id: number;
  oid: string;
  email?: string | null;
  name?: string | null;
  is_admin: boolean;
  /** False once an admin has offboarded them. /api/me is the one route they can
   *  still read — every other call 403s — so this is what the shell branches on
   *  to explain that, rather than rendering an app where nothing works. */
  is_active: boolean;
  title?: string | null;
  department?: string | null;
  /** The caller's own effective permissions. Presentation only — greying out a
   *  button the backend would refuse anyway. Optional because it is served by
   *  /api/me, which may be older than this client. */
  permissions?: UserPermissions;
}

/** Project membership row — one user assigned as a PM to a portfolio.
 *  Returned from `GET /api/projects/{id}/members`. */
export interface ProjectMember {
  id: number;
  project_id: number;
  user_id: number;
  user?: UserStub | null;
  /** False once the member has been offboarded. The row stays on the roster —
   *  their assignment and the actions they own are real history — but renders
   *  as deactivated rather than silently vanishing. */
  user_is_active: boolean;
  created_at?: string;
}

/** One portfolio assignment, embedded in AdminUser. Mirrors the backend's
 *  AdminUserPortfolioOut: `member_id` is the ProjectMember row id — the
 *  handle `DELETE /api/project-members/{member_id}` takes — while
 *  `project_id` is what POST /api/projects/{id}/members needs. Both are
 *  present so the admin table can unassign without a second lookup. */
export interface AdminUserPortfolio {
  member_id: number;
  project_id: number;
  project_name: string;
  client_name?: string | null;
}

/** A row of the admin user directory (`GET /api/admin/users`). Everything
 *  here is richer than the `/api/users` typeahead exposes — it is the map of
 *  who can do what — so the endpoint is admin-gated server-side. */
export interface AdminUser {
  id: number;
  oid?: string | null;
  name?: string | null;
  email?: string | null;
  /** Derived server-side by splitting the Entra display name — NOT separate
   *  storage. `name` is refreshed from Entra on every sign-in, so a hand-edited
   *  first/last would be overwritten within the hour; the grid shows these two
   *  columns read-only for that reason. */
  first_name?: string | null;
  last_name?: string | null;
  /** Auto-filled from Entra (jobTitle / department) where we have it, and
   *  overridable here. `null` means "never learned"; `""` means an admin
   *  deliberately blanked it. */
  title?: string | null;
  department?: string | null;
  /** DB-authoritative: ADMIN_EMAILS only seeds this on the row's first
   *  insert, it no longer overwrites on every request. */
  is_admin: boolean;
  /** False = offboarded. The auth dependency rejects these users outright,
   *  so it is a real lock-out and not just a hidden row. */
  is_active: boolean;
  /** Listed in ADMIN_EMAILS — the permanent admin floor. The server refuses
   *  to revoke or deactivate these users until the env var changes. */
  is_env_admin: boolean;
  last_seen_at?: string | null;
  created_at?: string | null;
  /** EFFECTIVE, so an admin's row arrives all-true. The grid renders an
   *  admin's boxes ticked-and-locked rather than editable: they are implied by
   *  the super-role, and unticking one would change nothing. */
  permissions: UserPermissions;
  portfolios: AdminUserPortfolio[];
}

/** `GET /api/admin/users` — the whole User Management grid in one round-trip.
 *  Column definitions travel with the rows so the header can never offer a
 *  checkbox for a permission the backend doesn't enforce. */
export interface AdminUserGrid {
  permissions: PermissionDef[];
  users: AdminUser[];
}

/* ---------- Admin console: bulk edits ----------
 * These mirror `backend/schemas/common.py` field for field. They are an
 * INDEPENDENT copy of the wire contract, not a generated one: a rename on
 * either side type-checks clean here and fails at runtime, so change both
 * together or not at all.
 */

/** `POST /api/admin/users/bulk` — apply one grant/revoke across many rows.
 *
 *  No `is_admin` / `is_active`, matching the server: minting an administrator
 *  is a look-at-what-you-are-doing act, and offboarding in bulk is how a whole
 *  team disappears from one mis-click. Both stay per-row in the grid. */
export interface AdminBulkPermissionsRequest {
  user_ids: number[];
  permissions: UserPermissionsPatch;
}

/** One target the server refused, and why.
 *
 *  The bulk permission route is all-or-nothing and every refusal in the console
 *  is deterministic, so a rejected batch names EVERY blocked person at once —
 *  refusing on the first would have an admin untick one row, retry, and be
 *  refused again on the next. These arrive in the error body, not the success
 *  body; `bulkPermissionRefusals()` in lib/api.ts reads them back out. */
export interface AdminBulkRefusal {
  user_id: number;
  label: string;
  reason: string;
}

/** `POST /api/admin/users/provision` — create the row for a colleague who has
 *  never signed in, so they can be set up before day one.
 *
 *  `oid` is the Entra object id and it is the whole point of the shape: the
 *  sign-in upsert matches on `oid` and nothing else, so a row provisioned under
 *  any other key becomes a ghost — the real sign-in inserts a SECOND row and
 *  the permissions an admin carefully set sit on one that never authenticates.
 *  Microsoft Graph's `/users` `id` IS that object id, which is why this can
 *  only be driven from the directory picker and never from a typed email. */
export interface ProvisionUserRequest {
  oid: string;
  email: string;
  name: string;
  title?: string | null;
  department?: string | null;
}

/** `POST /api/admin/memberships/bulk` — assign or unassign several people
 *  across several portfolios in one act. */
export interface AdminBulkMembershipRequest {
  user_ids: number[];
  project_ids: number[];
  action: "add" | "remove";
}

/** A portfolio that crossed the zero-members line, in either direction.
 *
 *  A VISIBILITY report, not a security one — do not write access-control copy
 *  from it. It was added when zero members meant "unowned" and the permission
 *  alone governed writes there, so crossing zero silently granted or revoked
 *  write access for everyone else. That rule is gone: Castillo's instruction is
 *  that every PM reaches every portfolio, so
 *  `auth/permissions.py::is_portfolio_member` returns true for any signed-in
 *  user and membership decides no authorization question at all. It still
 *  drives the Mine/all filter, the dashboard scope toggle and Manage Team,
 *  which is why a portfolio going from nobody's to somebody's is worth
 *  reporting — it changes whose dashboard it shows up on. 3 members going to 4
 *  changes nothing and is not reported.
 *
 *  The field names are the server's and stay as they are: renaming a wire key
 *  to match new prose is how two hand-kept copies of a contract drift apart. */
export interface MembershipFlip {
  project_id: number;
  project_name: string;
  client_name?: string | null;
  members_before: number;
  members_after: number;
  /** 0 -> >0. Now appears under "Mine" for the listed people, and nobody else. */
  became_scoped: boolean;
  /** >0 -> 0. Belongs to nobody, so it surfaces only in the all-portfolios views. */
  became_unowned: boolean;
}

/** What the membership batch actually did. `skipped` is the idempotent half —
 *  re-adding an existing assignment, or removing one that was never there —
 *  so the panel can offer 8 people × 6 portfolios without the admin first
 *  working out which of the 48 pairs already exist. */
export interface AdminBulkMembershipResult {
  added: number;
  removed: number;
  skipped: number;
  flipped: MembershipFlip[];
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
  location?: string | null;
  state?: string | null;
  size_mw?: string | null;
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
  /** OPTIONAL sub-project under that portfolio. null means the action belongs
   *  to the portfolio as a whole — the default, and what every action meant
   *  before sub-projects existed. Tagged actions still roll up: they appear in
   *  the portfolio, client and all lists exactly as before. */
  portfolio_project_id?: number | null;
  /** Denormalised by the API so a row renders its tag without the page
   *  fetching the sub-projects of every portfolio on screen. */
  portfolio_project_name?: string | null;
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
  /** Portfolio context — set by the list endpoint so the cross-portfolio
   *  "All portfolios" Actions view can label each row. */
  project_name?: string | null;
  client_name?: string | null;
  originating_meeting_date?: string | null;
}

/**
 * How wide the Actions page is looking — the ONE scope vocabulary shared by
 * the page, the list call, the owner directory and the CSV export.
 *
 * It is a three-way LEVEL rather than a boolean because the old boolean could
 * only say "this portfolio" or "the whole company", and client calls are run
 * per portfolio with the client's other portfolios one click away. A level
 * also survives a header change in a way an id pair cannot: the user picked
 * "this client", so switching clients keeps them at client level rather than
 * silently widening or narrowing the view under them.
 *
 * A row of actions belongs to exactly one portfolio (`ActionItem.project_id`
 * IS the portfolio), so "client" means "every portfolio under that client" —
 * there is no sub-portfolio tier to filter on here.
 */
export type ActionScopeLevel = "portfolio" | "client" | "all";

/**
 * A resolved scope: the level plus the ids the header currently has selected.
 *
 * The ids are carried at every level, not only the one in use, so a caller can
 * hand the same object to the list, the owners directory and the export and
 * trust all three to look at the same rows. Whichever id the level doesn't
 * need is simply not sent.
 *
 * Both ids are nullable because the header genuinely may have nothing picked.
 * A level whose id is missing degrades to the next wider query rather than
 * throwing — the page disables those buttons, but a hand-edited URL is not
 * something to crash on.
 */
export interface ActionScope {
  level: ActionScopeLevel;
  /** Portfolio (`projects.id`) — used when level is "portfolio". */
  projectId?: number | null;
  /** Client (`clients.id`) — used when level is "client". */
  clientId?: number | null;
}

/** One distinct action owner in the owner-filter dropdown.
 *
 *  `name` is a VALUE, not a label: the Actions filter and the CSV export both
 *  match on it, so the server must emit the owner string exactly as it is
 *  stored (comma-split and trimmed, nothing else) or picking a name here
 *  filters to nothing.
 *
 *  `owner_user_id` is the only CERTAIN company signal in the payload — a real
 *  FK to a PMO 360 user. Every other row was matched by hand-typed name against
 *  the rosters / client directory, so its company is a best guess.
 */
export interface ActionOwnerEntry {
  name: string;
  owner_user_id?: number | null;
  /** The server's split of `name` (schemas/common.py::split_display_name),
   *  which is what it sorted the group by. Null when the stored string has no
   *  discernible given name — "CK" and other initials land here. */
  first_name?: string | null;
  action_count: number;
}

/** One company section of the owner filter. */
export interface ActionOwnerGroup {
  company: string;
  /** Castillo's own section. Pinned first, and pinned to the brand red — it is
   *  never part of the derived palette, so no client can collide with us. */
  is_castillo: boolean;
  /** Owners we could not place with any company. A worklist, not an error:
   *  adding these people to the directory fixes them permanently. */
  is_unmatched: boolean;
  owners: ActionOwnerEntry[];
}

/** GET /api/actions/owners.
 *
 *  Groups arrive ORDERED and their owners SORTED. The client deliberately does
 *  not re-sort: two sort implementations would eventually disagree, and the
 *  dropdown would then change order between renders of the same data. */
export interface ActionOwners {
  groups: ActionOwnerGroup[];
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
  /** Optional sub-project this meeting covered. Null = the whole portfolio,
   *  which is what every meeting is until somebody says otherwise. Actions
   *  raised in a tagged meeting inherit this unless they carry their own. */
  portfolio_project_id?: number | null;
  /** Resolved by the API. Null both when untagged and when the sub-project has
   *  been deleted — no badge either way. */
  portfolio_project_name?: string | null;
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
  /** Set when the owner is picked from the PMO 360 team — carried through to
   *  the saved ActionItem so it shows in "Mine" / dashboards. */
  owner_user_id?: number | null;
  /** Sub-project under the MEETING's portfolio. null = the portfolio as a
   *  whole, which is the default. Carried through to the saved ActionItem and
   *  round-tripped on reopen, so a saved meeting keeps its tags. */
  portfolio_project_id?: number | null;
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
  /** YYYY-MM-DD — anchors relative action due dates ("next Friday"). */
  meeting_date?: string;
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
  /** Omit to leave an existing meeting's tag alone; send null to clear it.
   *  The backend distinguishes the two — it does not treat null as "absent". */
  portfolio_project_id?: number | null;
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
  /** False once offboarded. The row stays — their portfolios and open actions
   *  still need reassigning — but must not read as a working colleague. */
  is_active: boolean;
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
  /** "proposal" = projected from a proposal schedule; "manual" = hand-built. */
  origin: "proposal" | "manual";
  /** Latched true once a human drags/resizes/reassigns/edits it — a proposal
   *  resync then leaves the bar alone. */
  manual_edit: boolean;
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
  // Project tier (a site under the portfolio). When set, portfolio_id is the
  // project's portfolio; project_name is a read-only derived label.
  project_id: number | null;
  project_name: string | null;
  /** Exactly one proposal per Project is the ACTIVE one; the rest are history. */
  is_active_for_project: boolean;
  linked_schedule_id: number | null;
  current_version_id: number | null;
  version: number;
  created_at: string | null;
  updated_at: string | null;
}

/** The sibling that just lost its Project's ACTIVE slot. */
export interface ProposalDemoted {
  id: number;
  title: string;
}
/** ProposalOut plus the collateral damage of the link. Linking promotes by
 *  default, which files the Project's incumbent — often a signed proposal — as
 *  history; naming it is what stops that being something the PM has to spot. */
export interface ProposalLinkProjectResult extends ProposalOut {
  demoted_proposal: ProposalDemoted | null;
}

/** The "Project" tier: a site (e.g. "Cobra") under a Portfolio. */
export interface PortfolioProject {
  id: number;
  portfolio_id: number;
  name: string;
  location: string | null;
  state: string | null;
  size_mw: string | null;
  version: number;
  created_at: string | null;
  updated_at: string | null;
}
/** Deliverable branding logos as data URLs. company_logo null => bundled
 *  Castillo logo; client_logo null => no client logo. */
export interface ProposalLogos {
  company_logo: string | null;
  client_logo: string | null;
}
/** A hand-scheduled Timeline bar whose phase no longer exists in the schedule.
 *  The (discipline, milestone) pair is the only link between a proposal phase
 *  and its bar, so renaming a phase strands the bar rather than moving it. */
export interface ProposalTimelineOrphan {
  assignment_id: number;
  discipline: string;
  milestone: string | null;
  resource_id: number | null;
  start_date: string; // ISO yyyy-mm-dd
  end_date: string;
}
/** What an implicit resync did to the proposal's Timeline project. Absent
 *  whenever the proposal has no Timeline project, the edited version isn't the
 *  active one, or the projection produced no bars. */
export interface ProposalTimelineResync {
  timeline_project_id: number;
  version_label: string;
  bars_added: number;
  bars_updated: number;
  /** An implicit resync never deletes, so this is 0 outside an explicit import. */
  bars_removed: number;
  preserved_manual: number;
  skipped_no_dates: number;
  /** `orphaned_manual` + `orphaned_auto`. The server keeps the merged list for
   *  consumers written before the split; this UI reads the two halves. */
  orphaned: ProposalTimelineOrphan[];
  /** A human staffed this phase and it left the schedule — actionable. */
  orphaned_manual: ProposalTimelineOrphan[];
  /** The projection placed it and no longer deletes it — informational. */
  orphaned_auto: ProposalTimelineOrphan[];
}
/** Result of sending a proposal version's schedule to the Timeline module. */
export interface ProposalToTimelineResult {
  timeline_project_id: number;
  project_name: string;
  assignment_count: number;
  replaced_existing: boolean;
  skipped_no_dates: number;
  start_date: string | null;
  end_date: string | null;
  preserved_manual: number;
  /** Same three-way split as ProposalTimelineResync. */
  orphaned: ProposalTimelineOrphan[];
  orphaned_manual: ProposalTimelineOrphan[];
  orphaned_auto: ProposalTimelineOrphan[];
}
/** A draggable design-phase milestone for the Timeline palette. */
export interface ProposalTimelineMilestone {
  discipline: string;
  milestone: string | null;
  start_date: string;
  end_date: string;
}
export interface ProposalTimelineMilestones {
  proposal_id: number;
  project_name: string;
  version_id: number;
  version_label: string;
  timeline_project_id: number | null;
  milestones: ProposalTimelineMilestone[];
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
  /** Set by tree save / recompute when the edit re-projected onto the Timeline. */
  timeline_resync?: ProposalTimelineResync | null;
}
export interface ProposalBoard {
  proposal: ProposalOut;
  version: ProposalVersionDetail;
  versions: ProposalVersionOut[];
  /** Set by activate / new version / from-upload; always null on a plain board read. */
  timeline_resync?: ProposalTimelineResync | null;
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

// ---- "Assigned to you" (GET /api/dashboard/my-work) ----
// Ownership is NOT `owner_user_id` alone, and a count built on it alone reads
// low. Every person-picker asked for more users than the endpoint would return,
// so the picker list came back empty and owners were saved as free-text names;
// the prod backfill covered some rows, not all. The server resolves ownership
// the way /api/dashboard/mine does — owner_user_id, then a case-insensitive
// name match on the free-text `owner`, then created_by_id — and these numbers
// are only trustworthy because it does.
// Mirrors backend `schemas.common.MyWorkOut`. The window lengths travel in the
// payload on purpose — the tiles label themselves from the response instead of
// hardcoding "7 days" and drifting the day someone retunes the backend.
export interface MyWorkActions {
  /** status open OR pending — the app-wide meaning of "open". */
  open: number;
  /** open AND due strictly before today. Due today is due, not late. */
  overdue: number;
  /** open AND due between today and today + (due_window_days - 1). */
  due_this_week: number;
  /** open with no due date at all. Not overdue, but not invisible either. */
  no_due_date: number;
  closed_recently: number;
  /** Counted apart from `closed_recently`: dropped work is not throughput. */
  cancelled_recently: number;
  due_window_days: number;
  closed_window_days: number;
  /** How many of `open` are the user's ONLY because they created the row — no
   *  owner link, no name match. Shown when non-zero so the weakest rung of the
   *  ownership rule is visible rather than folded silently into the headline. */
  open_authored_only: number;
}

/** One portfolio's slice of the open pile — where the work is concentrated.
 *  Server-sorted worst-first, so the top row is the one to go work on. */
export interface MyWorkPortfolio {
  project_id: number;
  project_name: string;
  client_name: string | null;
  open: number;
  overdue: number;
}

export type MyWorkKind =
  | "co_approval"
  | "co_send"
  | "agenda"
  | "meeting_draft";

/** A row in the personal queue — one shape for all four kinds. `kind` + `id` +
 *  `project_id` is everything a link needs. */
export interface MyWorkItem {
  kind: MyWorkKind;
  id: number;
  project_id: number;
  project_name: string | null;
  client_name: string | null;
  /** Primary line, e.g. "CO-3 — Re-trenching". */
  label: string;
  /** Secondary line, e.g. "Raised by Ana Ruiz". */
  detail: string | null;
  /** Change orders only — the client-inclusive total. Null elsewhere. */
  amount: number | null;
  /** CO request date / agenda date / meeting date. Named `event_date` rather
   *  than `date` to match the server, where the shorter name shadowed the
   *  `date` type in its own annotation. */
  event_date: string | null;
  updated_at: string | null;
}

export interface MyWorkQueue {
  co_approvals: MyWorkItem[];
  co_to_send: MyWorkItem[];
  /** Upcoming agendas the user authored. The server cannot know "unsent" —
   *  SendAgendaDialog mails through Graph client-side and records nothing — so
   *  these are the still-ahead ones. Label them upcoming, never "unsent". */
  agendas: MyWorkItem[];
  meeting_drafts: MyWorkItem[];
  co_approval_amount: number;
  co_to_send_amount: number;
  total: number;
}

/** A change order somebody asked THIS person, by name, to approve.
 *
 *  Distinct from `waiting_on_me.co_approvals`, which is every pending CO the
 *  user's `co_approval` permission lets them decide on — a permission, not an
 *  invitation. These rows exist only where a named request was raised, so this
 *  is the list that answers "who is actually waiting on me". Same CO can appear
 *  in both.
 *
 *  Flat rather than a `MyWorkItem`: it carries the request's own facts
 *  (`requested_at`, `requested_by`, `stale`) which that shared shape has no room
 *  for, and losing `stale` is losing the warning. */
export interface MyWorkCoApproval {
  change_order_id: number;
  /** A LABEL, not the numeric `ChangeOrder.co_number` — the server formats it
   *  for display and may send null. */
  co_number: string | null;
  title: string | null;
  client_name: string | null;
  project_name: string | null;
  /** Client-inclusive total, same meaning as `ChangeOrder.total_amount`. */
  total_amount: number | null;
  requested_at: string;
  requested_by: string | null;
  /** The CO was edited after this person was asked. Approving it would be
   *  approving a price they have not read, and the server refuses — so the row
   *  has to say so before they click. */
  stale: boolean;
}

export interface MyWork {
  /** The calendar date every comparison above was made against, in `timezone`.
   *  The server runs UTC in a container while the people reading it do not, so
   *  an "overdue" count that doesn't say which day it means is unfalsifiable. */
  as_of: string;
  timezone: string;
  actions: MyWorkActions;
  by_portfolio: MyWorkPortfolio[];
  waiting_on_me: MyWorkQueue;
  /** COs where this person has an outstanding named approval request. Its own
   *  top-level section rather than a fifth `waiting_on_me` list, because
   *  `waiting_on_me.co_approvals` already means something different (see
   *  `MyWorkCoApproval`) and the two totals must not be added together. */
  co_approvals: MyWorkCoApproval[];
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

// ---------- Change Orders ----------
export interface COAllocation {
  role?: string | null;
  rate?: number | null;
  hours?: number | null;
}

export interface ChangeOrderLineItem {
  id?: number;
  order_index?: number;
  details?: string | null;
  cost?: number | null; // fixed mode
  allocations?: COAllocation[] | null; // hourly: people × rates
  role?: string | null; // legacy single-person hourly
  hourly_rate?: number | null; // legacy single-person hourly
  hours?: number | null; // legacy single-person hourly
  internal_notes?: string | null;
}

/** The internal money breakdown behind `total_amount`, computed server-side by
 *  `co_pricing` and returned on every CO the API hands back.
 *
 *  INTERNAL ONLY. The client's PDF prints line costs that already contain both
 *  adders and no percentage anywhere, so these four numbers exist to explain the
 *  total to Castillo, never to the client. They always reconcile:
 *  `base_amount + pmo_amount + admin_amount === total_amount`, in that order —
 *  the adders are additive on the base, never compounded. */
export interface ChangeOrderPricing {
  /** Sum of the line items, before either adder. */
  base_amount: number;
  /** Dollars the PMO adder contributes — not the percentage. */
  pmo_amount: number;
  /** Dollars the admin adder contributes — not the percentage. */
  admin_amount: number;
  /** What the client pays; mirrors the stored `total_amount` column. */
  total_amount: number;
}

export interface ChangeOrder {
  id: number;
  project_id: number;
  /** Optional sub-project this CO was raised for. Null = the whole portfolio.
   *  INTERNAL filing only — the PDF's "Project" line is `project_name`, the
   *  free-text label the PM types. Settable while draft or pending; approved
   *  and delivered COs are frozen outright. */
  portfolio_project_id?: number | null;
  /** Resolved by the API. Null both when untagged and when the sub-project has
   *  been deleted. */
  portfolio_project_name?: string | null;
  co_number: number;
  co_version?: string | null;
  title?: string | null;
  rate_type: "fixed" | "hourly";
  status: "draft" | "pending" | "sent_back" | "approved";
  request_date?: string | null;
  requested_by?: string | null;
  requested_by_user_id?: number | null;
  approved_by?: string | null;
  approved_by_user_id?: number | null;
  approved_at?: string | null;
  client_name?: string | null;
  location?: string | null;
  state?: string | null;
  size_mw?: string | null;
  signatory_name?: string | null;
  signatory_title?: string | null;
  signatory_phone?: string | null;
  signatory_email?: string | null;
  client_signatory_name?: string | null;
  client_signatory_title?: string | null;
  client_signatory_email?: string | null;
  client_signatory_phone?: string | null;
  /** Internal cost adders, percent of the line-item subtotal (5 = 5%). Additive
   *  on the base, so 5 + 5 on $100 is $110, not $110.25. The client never sees
   *  either number: the PDF marks the markup into the printed line costs so they
   *  sum to `total_amount` with no adder row and no residual cent. */
  pmo_pct?: number | null;
  admin_pct?: number | null;
  notes?: string | null;
  /** WHAT THE CLIENT PAYS — inclusive of both adders, not the line-item
   *  subtotal. The Proposals revised-contract-value rollup and the Dashboard CO
   *  card both read this and are correct because of that meaning. */
  total_amount?: number | null;
  pdf_storage_path?: string | null;
  sent_at?: string | null;
  sent_to?: string | null;
  /** How it reached the client: "graph" | "outlook" | "manual". Null on rows
   *  recorded before the method was tracked. */
  sent_method?: string | null;
  version?: number;
  line_items: ChangeOrderLineItem[];
  created_by?: UserStub | null;
  updated_by?: UserStub | null;
  created_at?: string;
  updated_at?: string;
  project_name?: string | null;
  /** Derived, not stored — filled in by the CO endpoints' shared `_out()` helper.
   *  The server has always sent it; this interface just never declared it, so
   *  anything wanting the breakdown had to cast its way to the field it was
   *  already being given. Optional because `_out()` is the one place that can
   *  forget it. */
  pricing?: ChangeOrderPricing | null;
}

/** The pre-flight answer from `POST /api/change-orders/{id}/send-check`.
 *
 *  `ok` IS ALWAYS TRUE WHEN YOU HOLD THIS OBJECT. A refusal is an HTTP error,
 *  never `ok: false` — no permission is a 403, an unapproved CO is a 409 — so a
 *  caller that branches on `ok` instead of catching has no guard at all. The
 *  field exists because the server's response model declares it; treat reaching
 *  the `.then()` as the yes.
 *
 *  The three `already_*` fields are the duplicate-send warning: non-null means
 *  this change order has already reached the client once, and sending again
 *  puts a second copy of the same priced document in their inbox. They are a
 *  warning rather than a refusal on purpose — a genuine re-send to a new
 *  recipient is legitimate, and the server records it by appending. */
export interface ChangeOrderSendCheck {
  ok: boolean;
  /** ISO timestamp of the FIRST delivery, kept across re-sends so the record of
   *  when the client actually received it survives. */
  already_sent_at?: string | null;
  already_sent_to?: string | null;
  /** "graph" | "outlook" | "manual", or null on rows predating the tracking. */
  already_sent_method?: string | null;
}

/* ---------- CO approval requests ----------
 * "Please look at this change order" — one row per person asked, on one CO.
 *
 * THESE ROWS ARE THE APPROVAL HISTORY. The CO itself records an approval in four
 * mutable columns that `reject` sets back to NULL, so nothing on the change order
 * survives a send-back to say that anyone ever approved it, or that anyone was
 * ever asked. These rows do: they are appended, answered, and never deleted.
 *
 * FIRST RESPONDER DECIDES. Asking three people is not a three-signature chain —
 * whoever acts first decides, and the other outstanding requests go
 * "superseded". There is exactly one approval step, and the CO status machine is
 * untouched by any of this: draft | pending | approved | sent_back.
 */

/** Where one request ended up.
 *
 *  `superseded` is not a refusal — it means somebody else answered first and this
 *  person's request closed itself. `cancelled` is the requester withdrawing it.
 *  Only `pending` rows are actionable, and only they gate the server-side
 *  staleness check on approve. */
export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "superseded"
  | "cancelled";

export interface ApprovalRequest {
  id: number;
  change_order_id: number;
  /** The PMO 360 account this was addressed to, when the picker resolved one.
   *  Null for someone asked by email address alone. */
  requested_user_id: number | null;
  requested_name: string | null;
  /** The only field the server requires — it is what the request mail is
   *  addressed to, and (lowercased) what deduping and the approve-time match
   *  run on. */
  requested_email: string;
  requested_by_id: number | null;
  requested_by_name: string | null;
  requested_at: string;
  /** THE CO VERSION THIS PERSON WAS ASKED ABOUT, snapshotted at request time. A
   *  pending CO is still fully editable, so the numbers can move between the mail
   *  and the click; this is what the server compares against to refuse an
   *  approval of a price nobody read. */
  co_version_at_request: number;
  /** `total_amount` as it stood when they were asked — the figure the mail
   *  quoted. Shown next to the current total so a re-price is visible rather
   *  than inferred. */
  total_at_request: number | null;
  status: ApprovalRequestStatus;
  responded_at: string | null;
  responded_by_user_id: number | null;
  /** Resolved server-side from `responded_by_user_id` — the ONLY name on this
   *  row the server stamped itself. `requested_name` is free text on a
   *  free-text ask, so an answered row must be captioned with this one:
   *  "Approved" beside a name nobody verified is a claim, not a record. */
  responded_by_name: string | null;
  response_note: string | null;
  /** Computed server-side (`co_version_at_request !== co.version`), not stored —
   *  a stored copy would go wrong the moment the CO is edited again. True means
   *  the change order moved after this person was asked. */
  stale: boolean;
}

/** One person to ask. `email` is required; `name` is display only, and `user_id`
 *  binds the request to a PMO 360 account when the picker resolved one, which is
 *  what lets the approver be matched by id rather than by address. */
export interface ApprovalRecipientInput {
  email: string;
  name?: string | null;
  user_id?: number | null;
}

/** What `POST /api/change-orders/{id}/request-approval` did.
 *
 *  `requests` is the CURRENT ask for each person named, one row each — asking
 *  someone who is already pending on this CO closes their old row as
 *  "superseded" and returns a fresh one, so they are never outstanding twice
 *  and the figure they were originally asked about survives in the history.
 *  `approval_path` is the in-app path of the change order; the caller prefixes
 *  the app origin to build the link it pastes into the mail. */
export interface ApprovalRequestResult {
  requests: ApprovalRequest[];
  approval_path: string;
}

/* ---------- Client contacts (Settings -> Clients) ----------
 * The directory of the people on the CLIENT side of a meeting. Deliberately its
 * own table rather than a flag on something existing: `User` is Castillo staff
 * who sign in, and `Attendee` records who was in one room on one day, so
 * neither can answer "who do we know at this client, and how do we reach them".
 *
 * Same warning as the admin block above — these mirror the backend schemas by
 * hand, so a rename on one side type-checks clean here and fails at runtime.
 * Change both or neither.
 */

/** One client-side contact. */
export interface ClientContact {
  id: number;
  /** NULLABLE ON PURPOSE, and the import is why: a contact whose domain matches
   *  no client still lands, unfiled, instead of being dropped. An unfiled row an
   *  admin can assign from the Clients tab beats one that has to be retyped out
   *  of somebody's inbox. Render null as "Unassigned", not as an error. */
  client_id?: number | null;
  /** ALL THREE ARE NULLABLE, and the imported data really does contain nulls:
   *  16 of 118 rows from the live roster have no last name (split_display_name
   *  on a single-token entry like "Ana"), and 25 have no email at all. Typing
   *  them as plain `string` here does not make them strings — it only stops
   *  TypeScript warning about the null, which is how `last_name.localeCompare`
   *  shipped and took the whole SPA down on the first import. */
  first_name: string | null;
  last_name: string | null;
  title?: string | null;
  email: string | null;
  /** The mail domain. Stored on the row rather than derived from `email` when
   *  read, because it is what the importer matches against
   *  `clients.email_domain` — so it has to be a thing an admin can actually see
   *  and correct. Tolerates null: the rows most likely to have no usable domain
   *  are exactly the unmatched ones this tab exists to clean up. */
  domain?: string | null;
  created_at?: string;
}

/** Create body, and (partially) the patch body. `domain` is optional because
 *  the server derives it from `email` when omitted — the form asks for an
 *  address, not for both halves of one. */
export interface ClientContactInput {
  client_id?: number | null;
  first_name: string;
  last_name: string;
  title?: string | null;
  email: string;
  domain?: string | null;
}

/** What `POST /api/client-contacts/import` did. */
export interface ClientContactImportResult {
  imported: number;
  /** Already on file — the import is re-runnable, so a second pass over the same
   *  source is a no-op rather than a pile of duplicate contacts. */
  skipped: number;
  /** The ones that landed with NO client attached, so the Clients tab can point
   *  an admin straight at the rows needing a home. These were still imported —
   *  they are counted in `imported`, not instead of it. */
  unmatched: string[];
}
