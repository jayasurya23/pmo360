import axios from "axios";
import type { MeetingRfi } from "@/lib/types";
import type {
  Client,
  Project,
  Meeting,
  MeetingDetail,
  ActionItem,
  ActionOwners,
  ActionScope,
  Note,
  Agenda,
  Schedule,
  ParsedSchedule,
  LeadOverview,
  TimelineBoard,
  TimelineResource,
  TimelineProject,
  TimelineAssignment,
  TimelineTimeOff,
  GlobalAttendee,
  Attendee,
  ParsedMeeting,
  DashboardResponse,
  Settings,
  ParseRequest,
  MeetingSaveRequest,
  AgendaSaveRequest,
  AgendaDocRequest,
  Deliverable,
  MeetingTemplate,
  MeetingTemplateInput,
  MeResponse,
  AdminUser,
  AdminUserGrid,
  AdminBulkMembershipRequest,
  AdminBulkMembershipResult,
  AdminBulkPermissionsRequest,
  AdminBulkRefusal,
  ProvisionUserRequest,
  UserPermissionsPatch,
  PortfolioProject,
  ProjectMember,
  ProposalBoard,
  ProposalListItem,
  ProposalOut,
  ProposalLinkProjectResult,
  ProposalVersionDetail,
  ProposalItemNode,
  ProposalLogos,
  ProposalToTimelineResult,
  ProposalTimelineMilestones,
  ProposalTimelineResync,
  ProposalTimelineOrphan,
  ChangeOrder,
  ChangeOrderLineItem,
  ChangeOrderSendCheck,
  ApprovalRecipientInput,
  ApprovalRequest,
  ApprovalRequestResult,
  ClientContact,
  ClientContactInput,
  ClientContactImportResult,
  MyWork,
} from "./types";

// Re-exported so the approval UI can pull the request shape from the same module
// as the calls that take it — `ChangeOrderCreate` and friends live here, and
// making one half of the CO contract come from ./types and the other from ./api
// is a trap for the next person wiring a dialog.
export type { ApprovalRecipientInput, ApprovalRequest } from "./types";

// Honor VITE_API_BASE at build-time so the same artefact can talk to
// a backend at /api (same origin), https://api.example.com, etc.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "/api";

export const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
});

/**
 * Custom error class that preserves the HTTP status + structured detail body.
 * 409 stale-version errors carry `{error: "stale_version", current_version,
 * submitted_version, message}` which the auto-save flow needs to inspect.
 */
export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

apiClient.interceptors.response.use(
  (r) => r,
  (err) => {
    const status: number = err?.response?.status ?? 0;
    const body = err?.response?.data;
    // A `responseType: "blob"` request parses its ERROR body as a Blob as well,
    // so the server's sentence is sealed inside it and `.detail` is undefined —
    // which is how a carefully worded 403 reaches the user as "Request failed
    // with status code 403". Carry the Blob through so `readBlobDetail()` can
    // open it. It was dropped before, so nothing can depend on the old value.
    const detail = body instanceof Blob ? body : body?.detail;
    // detail can be either a string (FastAPI's default) or a dict (our 409
    // payload). Surface a readable message either way.
    let message: string;
    if (typeof detail === "string") {
      message = detail;
    } else if (detail && typeof detail === "object" && "message" in detail) {
      message = String((detail as any).message);
    } else if (
      detail &&
      typeof detail === "object" &&
      typeof (detail as any).detail === "string"
    ) {
      // Same idea one key over. Our structured 4xx payloads mostly carry the
      // human sentence as `message`, but the approve-time staleness 409
      // (`{error: "stale_co", ..., detail: "...re-review before approving"}`)
      // names it `detail`. Without this branch that one reads "Request failed
      // with status code 409" — a blank refusal on the money path, at the exact
      // moment the sentence explaining WHY is the whole point. Reached only when
      // there is no `message`, so nothing that works today changes.
      message = (detail as any).detail;
    } else {
      message = err.message || "Request failed";
    }
    return Promise.reject(new ApiError(message, status, detail));
  }
);

/** True for the optimistic-concurrency 409 our backend emits on stale writes. */
export function isStaleVersionError(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.status === 409 &&
    typeof e.detail === "object" &&
    e.detail !== null &&
    (e.detail as any).error === "stale_version"
  );
}

/**
 * True for the OTHER staleness 409 — the one only the approve path raises.
 *
 * `stale_version` means "you sent a version and it was old". `stale_co` means
 * "you were ASKED to approve version N and this change order is now on N+1",
 * which the server works out from the approver's own request row and so fires
 * even when the client sends nothing. Two separate refusals with two
 * separate fixes: reload vs re-read the numbers. Branching on
 * `isStaleVersionError` alone catches only the first and drops the second into a
 * generic failure toast, which is why this exists as its own guard.
 *
 * `detail` carries `current_version`, `requested_version` and the sentence to
 * show — read it rather than writing new copy, so the app and the server can't
 * disagree about what went wrong.
 */
export function isStaleCoError(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.status === 409 &&
    typeof e.detail === "object" &&
    e.detail !== null &&
    (e.detail as any).error === "stale_co"
  );
}

/**
 * True for the 422 the proposal scheduler raises when a scheduled task depends
 * on a Price Only row.
 *
 * Branches on `detail.error`, NOT on the bare 422, because 422 was already
 * spoken for: the circular-dependency refusal shares the status, and the
 * Proposals catch blocks fall back to "Circular dependency in predecessors" copy
 * whenever a 422 arrives with no message. Telling them apart by status alone
 * would diagnose the wrong defect out loud.
 *
 * `e.message` is already the server's sentence naming the offending rows, which
 * is what the banner shows. `detail.links` carries the same pairs structurally
 * ({successor_id, successor_name, predecessor_id, predecessor_name, ...}) for
 * any caller that wants to highlight rows off the response — the Proposals page
 * doesn't need it, because it runs the same rule locally and tints as you type.
 */
export function isPriceOnlyPredecessorError(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.status === 422 &&
    typeof e.detail === "object" &&
    e.detail !== null &&
    (e.detail as any).error === "price_only_predecessor"
  );
}

// ---------- clients / projects ----------
export const listClients = () =>
  apiClient.get<Client[]>("/clients").then((r) => r.data);
export const createClient = (payload: { name: string; email_domain?: string }) =>
  apiClient.post<Client>("/clients", payload).then((r) => r.data);
export const updateClient = (
  id: number,
  payload: { name?: string; email_domain?: string },
) => apiClient.patch<Client>(`/clients/${id}`, payload).then((r) => r.data);
export const deleteClient = (id: number) => apiClient.delete(`/clients/${id}`);

/**
 * List projects under a client. When `myOnly=true` AND the user is signed
 * in AND not an admin, the backend filters to projects the user is
 * explicitly a member of. Anonymous + admin users see every project
 * regardless of the flag.
 */
/** Fetch every portfolio the current user can see, across all clients.
 *  Used by the calendar card's manual-override dropdown so PMs can pin an
 *  Outlook event to any portfolio without first navigating to the right
 *  client. Scoped server-side by membership when ``myOnly=true``. */
export const listAllPortfolios = (myOnly = false) =>
  apiClient
    .get<Project[]>(`/projects${myOnly ? "?my_only=true" : ""}`)
    .then((r) => r.data);

export const listProjects = (clientId: number, myOnly = false) =>
  apiClient
    .get<Project[]>("/projects", {
      params: { client_id: clientId, my_only: myOnly },
    })
    .then((r) => r.data);
export const getProject = (id: number) =>
  apiClient.get<Project>(`/projects/${id}`).then((r) => r.data);
export const createProject = (payload: {
  client_id: number;
  name: string;
  scope?: string;
  schedule_version?: string;
  sub_projects_json?: string[];
}) => apiClient.post<Project>("/projects", payload).then((r) => r.data);
export const updateProject = (
  id: number,
  payload: Partial<{
    name: string;
    scope: string;
    location: string;
    state: string;
    size_mw: string;
    schedule_version: string;
    sub_projects_json: string[];
  }>
) => apiClient.patch<Project>(`/projects/${id}`, payload).then((r) => r.data);
export const deleteProject = (id: number) => apiClient.delete(`/projects/${id}`);
export const listProjectDeliverables = (projectId: number) =>
  apiClient
    .get<Deliverable[]>(`/projects/${projectId}/deliverables`)
    .then((r) => r.data);

// ---------- portfolio metrics (PortfolioDashboard page) ----------
export interface BurndownPoint {
  week_start: string;
  open_at_end_of_week: number;
  completed_this_week: number;
}
export interface PortfolioMetrics {
  project_id: number;
  project_name: string;
  client_name: string | null;
  total_meetings: number;
  total_actions: number;
  open_actions: number;
  overdue_actions: number;
  completed_actions: number;
  cancelled_actions: number;
  action_close_rate: number;
  avg_actions_per_meeting: number;
  deliverables_total: number;
  deliverables_on_time: number;
  on_time_rate: number;
  last_meeting_date: string | null;
  days_since_last_meeting: number | null;
  burndown: BurndownPoint[];
  risks_by_likelihood: Record<string, number>;
}
export const fetchPortfolioMetrics = (projectId: number) =>
  apiClient
    .get<PortfolioMetrics>(`/projects/${projectId}/metrics`)
    .then((r) => r.data);

// ---------- roster ----------
export const listGlobalRoster = () =>
  apiClient.get<GlobalAttendee[]>("/roster/global").then((r) => r.data);
export const addGlobalRoster = (payload: {
  full_name: string;
  initials: string;
  organization?: string;
  email?: string;
}) =>
  apiClient.post<GlobalAttendee>("/roster/global", payload).then((r) => r.data);
export const removeGlobalRoster = (id: number) =>
  apiClient.delete(`/roster/global/${id}`);
export const updateGlobalRoster = (
  id: number,
  payload: {
    full_name?: string;
    initials?: string;
    organization?: string;
    email?: string;
  }
) =>
  apiClient
    .patch<GlobalAttendee>(`/roster/global/${id}`, payload)
    .then((r) => r.data);

export const listProjectRoster = (projectId: number) =>
  apiClient
    .get<Attendee[]>("/roster/project", { params: { project_id: projectId } })
    .then((r) => r.data);
export const addProjectRoster = (
  projectId: number,
  payload: {
    full_name: string;
    initials: string;
    organization?: string;
    email?: string;
  }
) =>
  apiClient
    .post<Attendee>("/roster/project", payload, {
      params: { project_id: projectId },
    })
    .then((r) => r.data);
export const removeProjectRoster = (id: number) =>
  apiClient.delete(`/roster/project/${id}`);
export const updateProjectRoster = (
  id: number,
  payload: {
    full_name?: string;
    initials?: string;
    organization?: string;
    email?: string;
  }
) =>
  apiClient
    .patch<Attendee>(`/roster/project/${id}`, payload)
    .then((r) => r.data);

// ---------- meetings ----------
export const listMeetings = (projectId: number) =>
  apiClient
    .get<Meeting[]>("/meetings", { params: { project_id: projectId } })
    .then((r) => r.data);
export const getLatestMeeting = (projectId: number) =>
  apiClient
    .get<MeetingDetail | null>("/meetings/latest", {
      params: { project_id: projectId },
    })
    .then((r) => r.data);
export const getMeeting = (id: number) =>
  apiClient.get<MeetingDetail>(`/meetings/${id}`).then((r) => r.data);
export const saveMeeting = (payload: MeetingSaveRequest) =>
  apiClient.post<MeetingDetail>("/meetings/save", payload).then((r) => r.data);
export const deleteMeeting = (id: number) => apiClient.delete(`/meetings/${id}`);
/** Lightweight rename / stage change from History. Send just the field
 *  you're changing — omitted fields are left untouched server-side. */
export const updateMeetingMeta = (
  id: number,
  payload: { title?: string; stage?: "draft" | "final" | "sent" },
) =>
  apiClient.patch<Meeting>(`/meetings/${id}`, payload).then((r) => r.data);
export const regenerateMeetingSummary = (id: number) =>
  apiClient
    .post<MeetingDetail>(`/meetings/${id}/regenerate-summary`)
    .then((r) => r.data);

// ---------- parsing ----------
export const parseNotes = (payload: ParseRequest) =>
  apiClient.post<ParsedMeeting>("/parse", payload).then((r) => r.data);

export const parseTranscriptFile = async (file: File) => {
  const form = new FormData();
  form.append("file", file);
  const res = await apiClient.post<{
    filename: string;
    format: string;
    char_count: number;
    text: string;
  }>("/parse/transcript", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
};


// ---------- documents ----------
/* The four `${API_BASE}/...` builders that used to live here are GONE on
 * purpose. Each returned a URL for an <a href>, an <iframe> or window.open,
 * and each pointed at a route behind `require_db_user` — so each answered 401
 * for every user, forever. That shipped four separate times (meeting
 * documents, attachments, the actions CSV, the agenda .ics) and the meeting
 * one went unnoticed in production for six days.
 *
 * Anything the browser downloads goes through lib/documents.ts, which pulls
 * the bytes with the token attached and hands back a blob. If you find
 * yourself building an API URL as a string to put in an href, that is the
 * bug. */

// Note: helper returns a URL the browser can hit directly (img/iframe/a[href]).
// We deliberately use `${API_BASE}` so production builds pick up an absolute
// backend URL when VITE_API_BASE is set.
export const finalizeMeeting = (meetingId: number) =>
  apiClient
    .post<{ paths: Record<string, string>; stage: string }>(
      `/documents/meeting/${meetingId}/finalize`
    )
    .then((r) => r.data);
export const finalizedFileUrl = (path: string) =>
  `${API_BASE}/documents/file?path=${encodeURIComponent(path)}`;

// ---------- actions ----------

/**
 * The scope query params for `/actions`, `/actions/owners` and
 * `/actions/export.csv`. ONE builder for all three on purpose: the way scope
 * filtering fails is that the table, the owner dropdown and the exported file
 * quietly stop describing the same rows, and a CSV of the wrong portfolio
 * looks exactly as plausible as a CSV of the right one.
 *
 * Only the WINNING id is sent. project_id beats client_id — narrower beats
 * broader, matching the backend's documented precedence — so a scope that
 * somehow carries both never leaves it to the server to break the tie.
 *
 * A level whose id is missing sends nothing and so widens to the next query
 * rather than throwing; the page disables those buttons, but a hand-edited URL
 * is not worth a crash over.
 *
 * It also NORMALISES the legacy positional form, so this is the single place
 * that knows a bare number means "this one portfolio". Callers that only ever
 * meant that (the delete-portfolio pre-check, the agenda's open-action pull,
 * the owner dropdown) keep passing an id and keep working, and there is still
 * exactly one function deciding what reaches the server.
 */
export function actionScopeParams(scope?: number | ActionScope | null): {
  project_id?: number;
  client_id?: number;
} {
  const s: ActionScope | null =
    typeof scope === "number" ? { level: "portfolio", projectId: scope } : (scope ?? null);
  if (!s) return {};
  if (s.level === "portfolio" && s.projectId != null)
    return { project_id: s.projectId };
  if (s.level === "client" && s.clientId != null)
    return { client_id: s.clientId };
  return {};
}

/**
 * Can this scope actually be asked for? A "portfolio" level with no portfolio
 * id (or "client" with no client id) sends NO params, which the server reads as
 * "every action in the company" — the widest possible answer to the narrowest
 * possible question.
 *
 * `actionScopeParams` degrades rather than throwing, deliberately; this is how
 * callers tell the two apart. The page uses it to disable the export and show
 * an empty state, and the owner dropdown uses it to not fetch a company-wide
 * directory to sit beside a table that is showing nothing. Both must agree, so
 * they read the same predicate.
 */
export function actionScopeIsResolved(
  scope?: number | ActionScope | null,
): boolean {
  // A bare id and an absent scope are the two legacy forms; both are resolved
  // by construction ("this portfolio" / "everything").
  if (scope == null || typeof scope === "number") return true;
  if (scope.level === "portfolio") return scope.projectId != null;
  if (scope.level === "client") return scope.clientId != null;
  return true;
}

/**
 * Actions in scope. Takes either a bare portfolio id (the original form) or an
 * `ActionScope`, which additionally allows "every portfolio under this client"
 * — the shape a client call actually has, and the reason this took a scope at
 * all. Rows carry project_name / client_name so a multi-portfolio result can
 * label and group itself.
 *
 * `undefined` is NOT accepted: a forgotten argument would typecheck and quietly
 * return every action in the company, which is the wrong way for this call to
 * fail (the delete-portfolio dialog counts rows with it before offering a
 * destructive confirmation). `null` still means "all", explicitly.
 */
export const listActions = (
  scope: number | ActionScope | null,
  onlyOpen = false,
) =>
  apiClient
    .get<ActionItem[]>("/actions", {
      params: { ...actionScopeParams(scope), only_open: onlyOpen },
    })
    .then((r) => r.data);

/** Every action across every portfolio in the company. Identical to
 *  `listActions({ level: "all" })`; kept because callers that mean "all" read
 *  better saying so. */
export const listAllActions = (onlyOpen = false) =>
  apiClient
    .get<ActionItem[]>("/actions", { params: { only_open: onlyOpen } })
    .then((r) => r.data);

/** Distinct action owners in scope, grouped by the company they resolve to.
 *
 *  Pass the SAME scope the table is showing. Mismatch it and the dropdown
 *  offers owners the table has no rows for, so picking one empties the list for
 *  no visible reason — which is why this takes the same scope object as
 *  `listActions` rather than its own idea of one. */
export const fetchActionOwners = (scope?: number | ActionScope | null) =>
  apiClient
    .get<ActionOwners>("/actions/owners", {
      params: actionScopeParams(scope),
    })
    .then((r) => r.data);

export const updateAction = (
  id: number,
  payload: Partial<{
    text: string;
    owner: string;
    /** Sub-project under this action's own portfolio. Pass an id to file it
     *  against one, null to put it back on the portfolio as a whole, omit to
     *  leave it alone. The server refuses a sub-project belonging to a
     *  different portfolio — this is not enforced by the picker alone. */
    portfolio_project_id: number | null;
    /** Pass a user id to bind this action to a PMO 360 PM. Pass null to
     *  explicitly clear the link (action reassigned to a vendor). Omit
     *  to leave the existing link untouched. */
    owner_user_id: number | null;
    due_date: string | null;
    status: string;
    closing_meeting_id: number;
  }>
) => apiClient.patch<ActionItem>(`/actions/${id}`, payload).then((r) => r.data);
export const createAction = (payload: {
  project_id: number;
  originating_meeting_id: number;
  text: string;
  owner?: string;
  owner_user_id?: number | null;
  due_date?: string | null;
  status?: string;
}) => apiClient.post<ActionItem>("/actions", payload).then((r) => r.data);
export const deleteAction = (id: number) => apiClient.delete(`/actions/${id}`);

/**
 * Re-file an action under a different portfolio. The action keeps its
 * originating meeting (that meeting really did raise it) but stops appearing
 * on that meeting's client-facing minutes, because those go to a client who
 * has no business reading another portfolio's work.
 *
 * `portfolio_project_id` is validated against the TARGET portfolio, so a
 * sub-project that was valid before the move is rejected after it.
 */
export const moveAction = (
  id: number,
  target: { project_id: number; portfolio_project_id?: number | null }
) => apiClient.post<ActionItem>(`/actions/${id}/move`, target).then((r) => r.data);

/**
 * Duplicate an action into another portfolio, leaving the original in place —
 * for one commitment that turns out to bind two portfolios. The two rows are
 * independent from that moment: closing one does not close the other.
 */
export const copyAction = (
  id: number,
  target: { project_id: number; portfolio_project_id?: number | null }
) => apiClient.post<ActionItem>(`/actions/${id}/copy`, target).then((r) => r.data);

// ---------- notes ----------
export const listNotes = (projectId: number) =>
  apiClient
    .get<Note[]>("/notes", { params: { project_id: projectId } })
    .then((r) => r.data);
export const createNote = (payload: Partial<Note> & {
  project_id: number;
  note_date: string;
}) => apiClient.post<Note>("/notes", payload).then((r) => r.data);
export const updateNote = (id: number, payload: Partial<Note>) =>
  apiClient.patch<Note>(`/notes/${id}`, payload).then((r) => r.data);
export const deleteNote = (id: number) => apiClient.delete(`/notes/${id}`);

/** LLM-suggested action extracted from a note. Empty `text` = informational. */
export interface SuggestedAction {
  text: string;
  owner: string;
  due_date: string | null;
  rationale: string;
}
export const suggestActionFromNote = (noteId: number) =>
  apiClient
    .post<SuggestedAction>(`/notes/${noteId}/suggest-action`)
    .then((r) => r.data);

// ---------- agendas ----------
export const listAgendas = (projectId: number) =>
  apiClient
    .get<Agenda[]>("/agendas", { params: { project_id: projectId } })
    .then((r) => r.data);
export const getAgenda = (id: number) =>
  apiClient.get<Agenda>(`/agendas/${id}`).then((r) => r.data);
export const saveAgenda = (payload: AgendaSaveRequest) =>
  apiClient.post<Agenda>("/agendas", payload).then((r) => r.data);
export const deleteAgenda = (id: number) => apiClient.delete(`/agendas/${id}`);
/** Server-assembled draft of an upcoming agenda — open actions, carried-
 *  forward risks/decisions/schedule changes, last meeting's recap by
 *  discipline. Read-only; nothing is persisted until the PM clicks Save. */
export interface AgendaAutoDraft {
  upcoming_date: string;
  title: string | null;
  source_meeting_id: number | null;
  meeting_duration_minutes: number;
  schedule_version_override: string | null;
  disciplines: string[];
  dp_text: Record<string, string>;
  recap_text: Record<string, string>;
  attendees: { full_name: string; initials: string; organization: string }[];
  open_actions: { text: string; owner: string; due_date: string | null; status: string }[];
  risks: Record<string, any>[];
  decisions: Record<string, any>[];
  schedule_changes: Record<string, any>[];
  sources_summary: string;
}
export const autoDraftAgenda = (projectId: number, upcomingDate?: string) =>
  apiClient
    .post<AgendaAutoDraft>("/agendas/auto-draft", null, {
      params: { project_id: projectId, upcoming_date: upcomingDate },
    })
    .then((r) => r.data);

export const generateAgendaDoc = async (
  payload: AgendaDocRequest,
  fmt: "pdf" | "docx"
) => {
  const res = await apiClient.post(`/agendas/generate?fmt=${fmt}`, payload, {
    responseType: "blob",
  });
  return res.data as Blob;
};

// ---------- lead / admin overview ----------
export const fetchLeadOverview = () =>
  apiClient.get<LeadOverview>("/lead/overview").then((r) => r.data);

// ---------- timeline estimator ----------
export const fetchTimelineBoard = (start?: string, end?: string) =>
  apiClient
    .get<TimelineBoard>("/timeline/board", { params: { start, end } })
    .then((r) => r.data);
export const listTimelineResources = (includeInactive = false) =>
  apiClient
    .get<TimelineResource[]>("/timeline/resources", {
      params: { include_inactive: includeInactive },
    })
    .then((r) => r.data);
export const createTimelineResource = (body: Partial<TimelineResource>) =>
  apiClient.post<TimelineResource>("/timeline/resources", body).then((r) => r.data);
export const patchTimelineResource = (id: number, body: Partial<TimelineResource>) =>
  apiClient.patch<TimelineResource>(`/timeline/resources/${id}`, body).then((r) => r.data);
export const deleteTimelineResource = (id: number) =>
  apiClient.delete(`/timeline/resources/${id}`);
export const listTimelineProjects = () =>
  apiClient.get<TimelineProject[]>("/timeline/projects").then((r) => r.data);
export const createTimelineProject = (body: Partial<TimelineProject>) =>
  apiClient.post<TimelineProject>("/timeline/projects", body).then((r) => r.data);
export const patchTimelineProject = (id: number, body: Partial<TimelineProject> & { expected_version?: number }) =>
  apiClient.patch<TimelineProject>(`/timeline/projects/${id}`, body).then((r) => r.data);
export const deleteTimelineProject = (id: number) =>
  apiClient.delete(`/timeline/projects/${id}`);
export const createTimelineAssignment = (body: Partial<TimelineAssignment>) =>
  apiClient.post<TimelineAssignment>("/timeline/assignments", body).then((r) => r.data);
export const patchTimelineAssignment = (id: number, body: Partial<TimelineAssignment> & { expected_version?: number }) =>
  apiClient.patch<TimelineAssignment>(`/timeline/assignments/${id}`, body).then((r) => r.data);
export const deleteTimelineAssignment = (id: number) =>
  apiClient.delete(`/timeline/assignments/${id}`);
/** Hand a Timeline bar back to auto-resync ownership. Clears the manual-edit
 *  latch that a drag/resize/edit set, so the next proposal save re-dates it. */
export const releaseTimelineAssignment = (assignmentId: number) =>
  apiClient
    .post<TimelineAssignment>(`/timeline/assignments/${assignmentId}/release`)
    .then((r) => r.data);
export const createTimelineTimeOff = (body: {
  resource_id: number;
  start_date: string;
  end_date: string;
  reason?: string;
}) => apiClient.post<TimelineTimeOff>("/timeline/timeoff", body).then((r) => r.data);
export const deleteTimelineTimeOff = (id: number) =>
  apiClient.delete(`/timeline/timeoff/${id}`);

// ---------- schedules ----------
export const listSchedules = (projectId: number) =>
  apiClient
    .get<Schedule[]>("/schedules", { params: { project_id: projectId } })
    .then((r) => r.data);
export const parseScheduleFile = async (
  file: File,
  engine: "auto" | "regex" | "llm" = "auto",
) => {
  const form = new FormData();
  form.append("file", file);
  form.append("engine", engine);
  const res = await apiClient.post<ParsedSchedule>("/schedules/parse", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
};
export const saveSchedule = (project_id: number, parsed: ParsedSchedule) =>
  apiClient
    .post<Schedule>("/schedules", { project_id, parsed })
    .then((r) => r.data);
export const deleteSchedule = (id: number) =>
  apiClient.delete(`/schedules/${id}`);

// ---------- proposals ----------
/** Upload a Castillo cost workbook (.xlsx/.xlsm). The backend parses it into
 *  the editable schedule tree and returns the freshly-created proposal board
 *  (V1 active). Optional portfolio link + project start + utilization seed
 *  the first version's config. */
export const uploadProposal = async (
  file: File,
  opts?: {
    portfolio_id?: number;
    project_start?: string;
    utilization_percent?: number;
  },
) => {
  const form = new FormData();
  form.append("file", file);
  if (opts?.portfolio_id != null)
    form.append("portfolio_id", String(opts.portfolio_id));
  if (opts?.project_start) form.append("project_start", opts.project_start);
  if (opts?.utilization_percent != null)
    form.append("utilization_percent", String(opts.utilization_percent));
  const res = await apiClient.post<ProposalBoard>("/proposals/upload", form, {
    // Let the browser set the multipart boundary.
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 5 * 60 * 1000,
  });
  return res.data;
};
export const listProposals = (
  portfolio_id?: number,
  opts?: { project_id?: number; active_only?: boolean },
) =>
  apiClient
    .get<ProposalListItem[]>("/proposals", {
      params: {
        ...(portfolio_id != null ? { portfolio_id } : {}),
        ...(opts?.project_id != null ? { project_id: opts.project_id } : {}),
        ...(opts?.active_only ? { active_only: true } : {}),
      },
    })
    .then((r) => r.data);
export const fetchProposalBoard = (id: number) =>
  apiClient.get<ProposalBoard>(`/proposals/${id}/board`).then((r) => r.data);
export const patchProposal = (
  id: number,
  body: Partial<ProposalOut> & { expected_version?: number },
) => apiClient.patch<ProposalOut>(`/proposals/${id}`, body).then((r) => r.data);
export const deleteProposal = (id: number) =>
  apiClient.delete(`/proposals/${id}`);
/** Branding logos for the deliverable header (data URLs). Fetched on demand —
 *  kept off the board/list responses to keep those lean. */
export const fetchProposalLogos = (id: number) =>
  apiClient.get<ProposalLogos>(`/proposals/${id}/logos`).then((r) => r.data);
/** Set/replace/clear logos. Omit a field to leave it; pass null to clear it
 *  (company => bundled Castillo default, client => none). */
export const updateProposalLogos = (
  id: number,
  body: { company_logo?: string | null; client_logo?: string | null },
) => apiClient.put<ProposalLogos>(`/proposals/${id}/logos`, body).then((r) => r.data);
export const putProposalTree = (
  id: number,
  vid: number,
  body: {
    tree: ProposalItemNode[];
    info?: Record<string, any>;
    config?: Record<string, any>;
    expected_version?: number;
  },
) =>
  apiClient
    .put<ProposalVersionDetail>(`/proposals/${id}/versions/${vid}/tree`, body)
    .then((r) => r.data);
export const recomputeProposal = (
  id: number,
  vid: number,
  body: { unpin_all?: boolean; config?: Record<string, any>; expected_version?: number },
) =>
  apiClient
    .post<ProposalVersionDetail>(
      `/proposals/${id}/versions/${vid}/recompute`,
      body,
    )
    .then((r) => r.data);
export const createProposalVersion = (id: number) =>
  apiClient
    .post<ProposalBoard>(`/proposals/${id}/versions`)
    .then((r) => r.data);
/** Increment the version of an EXISTING proposal from a freshly uploaded Excel.
 *  `source`: "workbook" = Castillo cost workbook, "template" = saved template.
 *  Returns the same board shape as createProposalVersion, new version active.
 *
 *  Leave `utilization_percent` undefined unless the PM actually typed one: the
 *  field is OMITTED from the form then, which is how the server knows to inherit
 *  the superseded version's utilization rather than snap a 60% schedule to 100%.
 *  Sending a defaulted 100 here silently re-bids the whole thing at full rate. */
export const createProposalVersionFromUpload = async (
  id: number,
  file: File,
  opts?: {
    source?: "workbook" | "template";
    project_start?: string;
    utilization_percent?: number;
    update_identity?: boolean;
  },
) => {
  const form = new FormData();
  form.append("file", file);
  form.append("source", opts?.source ?? "workbook");
  if (opts?.project_start) form.append("project_start", opts.project_start);
  if (opts?.utilization_percent != null)
    form.append("utilization_percent", String(opts.utilization_percent));
  if (opts?.update_identity) form.append("update_identity", "true");
  const res = await apiClient.post<ProposalBoard>(
    `/proposals/${id}/versions/from-upload`,
    form,
    // Let the browser set the multipart boundary; a big workbook parse can
    // outrun the default timeout, same as the create-proposal upload.
    { headers: { "Content-Type": "multipart/form-data" }, timeout: 5 * 60 * 1000 },
  );
  return res.data;
};
export const activateProposalVersion = (id: number, vid: number) =>
  apiClient
    .post<ProposalBoard>(`/proposals/${id}/versions/${vid}/activate`)
    .then((r) => r.data);
/** kind: "sov" (Schedule of Values), "schedule" (Project Schedule, default),
 *  or "both" (SOV + Project Schedule in one PDF). */
export const generateProposalPdf = (
  id: number,
  vid: number,
  kind: "sov" | "schedule" | "both" = "schedule",
) =>
  apiClient
    .post<{ document_id: number; filename: string; file_size_bytes: number }>(
      `/proposals/${id}/versions/${vid}/pdf`,
      undefined,
      { params: { kind } },
    )
    .then((r) => r.data);
/** Path of the serve-PDF endpoint. The endpoint requires a Bearer token, so
 *  use `fetchProposalPdfBlob` (authed axios) to preview/download rather than
 *  hitting this URL directly from an <iframe>/<a href> which can't carry the
 *  token. Kept for callers that already have cookie-based auth. */
export const proposalPdfUrl = (id: number, vid: number) =>
  `${API_BASE}/proposals/${id}/versions/${vid}/pdf/file`;
/** Authed blob fetch — the proposal PDF endpoint is behind require_db_user,
 *  so we pull it through the axios client (Bearer attached) and hand back a
 *  Blob the caller turns into an object URL for preview + download. */
export const fetchProposalPdfBlob = async (
  id: number,
  vid: number,
  // Which deliverable to render. Omitted means "newest stored file", the
  // original contract. Passing it matters for a caller whose `proposals`
  // permission is unticked: they cannot run the generate step, so this GET is
  // the only thing building their PDF and it has to know which one they asked
  // for rather than serving whatever someone else persisted last.
  kind?: "sov" | "schedule" | "both",
) => {
  const res = await apiClient.get(
    `/proposals/${id}/versions/${vid}/pdf/file`,
    { responseType: "blob", ...(kind ? { params: { kind } } : {}) },
  );
  return res.data as Blob;
};
/** Authed blob fetch of the saved-template .xlsx (the desktop "Save Template").
 *  Built server-side from the persisted version, so the caller must Save any
 *  pending edits first (same contract the PDF serve relies on). */
export const downloadProposalTemplate = async (id: number, vid: number) => {
  const res = await apiClient.get(
    `/proposals/${id}/versions/${vid}/template.xlsx`,
    { responseType: "blob" },
  );
  return res.data as Blob;
};
/** Authed blob fetch of a ZIP bundling this version's PDF + Excel template. */
export const downloadProposalBundle = async (id: number, vid: number) => {
  const res = await apiClient.get(
    `/proposals/${id}/versions/${vid}/bundle.zip`,
    { responseType: "blob" },
  );
  return res.data as Blob;
};
/** Import a saved proposal template .xlsx -> creates a fresh Proposal + V1 and
 *  returns the board (mirrors uploadProposal's multipart contract). */
export const importProposalTemplate = async (
  file: File,
  opts?: { portfolio_id?: number },
) => {
  const form = new FormData();
  form.append("file", file);
  if (opts?.portfolio_id != null)
    form.append("portfolio_id", String(opts.portfolio_id));
  const res = await apiClient.post<ProposalBoard>("/proposals/template", form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 5 * 60 * 1000,
  });
  return res.data;
};
export const linkProposal = (id: number, portfolio_id: number) =>
  apiClient
    .patch<ProposalOut>(`/proposals/${id}/link`, { portfolio_id })
    .then((r) => r.data);
/** Link a proposal to a Project (the tier under a Portfolio); the portfolio is
 *  derived from the project server-side. Linking promotes by default, so the
 *  result also carries whichever sibling it just filed as history. */
export const linkProposalProject = (
  id: number, project_id: number, make_active?: boolean,
) =>
  apiClient
    .patch<ProposalLinkProjectResult>(`/proposals/${id}/link-project`, {
      project_id,
      ...(make_active != null ? { make_active } : {}),
    })
    .then((r) => r.data);
/** Make this proposal the ACTIVE one for its Project (demotes the incumbent).
 *  Several proposals may share a Project — revisions, re-bids — but only the
 *  active one represents the live scope. */
export const activateProposalForProject = (id: number) =>
  apiClient
    .post<ProposalOut>(`/proposals/${id}/activate-for-project`)
    .then((r) => r.data);
export const unlinkProposal = (id: number) =>
  apiClient.patch<ProposalOut>(`/proposals/${id}/unlink`).then((r) => r.data);

// ---------- portfolio projects (the "Project" tier under a Portfolio) ----------
export const listPortfolioProjects = (
  portfolioId?: number | null,
  clientId?: number | null,
) =>
  apiClient
    .get<PortfolioProject[]>("/portfolio-projects", {
      params: {
        ...(portfolioId != null ? { portfolio_id: portfolioId } : {}),
        ...(clientId != null ? { client_id: clientId } : {}),
      },
    })
    .then((r) => r.data);
export const createPortfolioProject = (payload: {
  portfolio_id: number;
  name: string;
  location?: string | null;
  state?: string | null;
  size_mw?: string | null;
}) =>
  apiClient.post<PortfolioProject>("/portfolio-projects", payload).then((r) => r.data);
export const updatePortfolioProject = (
  id: number,
  payload: Partial<{
    name: string;
    location: string | null;
    state: string | null;
    size_mw: string | null;
    portfolio_id: number;
    expected_version: number;
  }>,
) =>
  apiClient.patch<PortfolioProject>(`/portfolio-projects/${id}`, payload).then((r) => r.data);
export const deletePortfolioProject = (id: number) =>
  apiClient.delete(`/portfolio-projects/${id}`);
export const syncProposal = (
  id: number,
  body: { version_id?: number; seed_deliverables: boolean },
) =>
  apiClient
    .post<{
      schedule_id: number;
      schedule_version: string;
      item_count: number;
      deliverable_count: number;
    }>(`/proposals/${id}/sync`, body)
    .then((r) => r.data);
/** Project a proposal version's schedule into the Timeline module as one
 *  project + unassigned phase bars. Re-import replaces the prior import. */
export const sendProposalToTimeline = (
  id: number,
  body?: { version_id?: number; replace_existing?: boolean },
) =>
  apiClient
    .post<ProposalToTimelineResult>(`/proposals/${id}/send-to-timeline`, body ?? {})
    .then((r) => r.data);
/** A proposal version's design-phase milestones, as a draggable Timeline palette. */
export const fetchProposalTimelineMilestones = (id: number, versionId?: number) =>
  apiClient
    .get<ProposalTimelineMilestones>(`/proposals/${id}/timeline-milestones`, {
      params: versionId ? { version_id: versionId } : undefined,
    })
    .then((r) => r.data);
/** Place ONE proposal milestone onto the board (palette drag-drop) — ensures the
 *  proposal's Timeline project exists, then creates the assignment. */
export const placeProposalMilestone = (
  id: number,
  body: {
    version_id?: number;
    resource_id?: number | null;
    discipline?: string | null;
    milestone?: string | null;
    start_date: string;
    end_date: string;
    utilization?: number;
  },
) =>
  apiClient
    .post<{ timeline_project_id: number; assignment_id: number }>(
      `/proposals/${id}/timeline-bar`,
      body,
    )
    .then((r) => r.data);

// ---------- meeting templates ----------
export const listTemplates = (projectId: number) =>
  apiClient
    .get<MeetingTemplate[]>("/templates", { params: { project_id: projectId } })
    .then((r) => r.data);
export const getTemplate = (id: number) =>
  apiClient.get<MeetingTemplate>(`/templates/${id}`).then((r) => r.data);
export const createTemplate = (payload: MeetingTemplateInput) =>
  apiClient.post<MeetingTemplate>("/templates", payload).then((r) => r.data);
export const updateTemplate = (
  id: number,
  payload: Partial<MeetingTemplateInput>,
) =>
  apiClient
    .patch<MeetingTemplate>(`/templates/${id}`, payload)
    .then((r) => r.data);
export const deleteTemplate = (id: number) =>
  apiClient.delete(`/templates/${id}`);
/** Bumps the template's last_used_at to now() — called by the Capture page
 *  right after a PM clones a template. Drives the "recently used" rail. */
export const touchTemplate = (id: number) =>
  apiClient
    .post<MeetingTemplate>(`/templates/${id}/touch`)
    .then((r) => r.data);

// ---------- dashboard + settings ----------
export const fetchDashboard = () =>
  apiClient.get<DashboardResponse>("/dashboard").then((r) => r.data);
export const fetchMyDashboard = () =>
  apiClient.get<DashboardResponse>("/dashboard/mine").then((r) => r.data);

/** One open risk surfaced on the Home risk-rollup card. Matches
 *  ``schemas.common.DashboardRiskOut`` on the backend. */
export interface DashboardRisk {
  project_id: number;
  project_name: string;
  client_name: string | null;
  agenda_id: number;
  upcoming_date: string;
  description: string;
  impact: string | null;
  likelihood: string | null;
  mitigation: string | null;
  owner: string | null;
}

/** Open risks aggregated from the most-recent agenda of every portfolio
 *  the user can see. ``scope="mine"`` honours the Mine/All toggle; admins
 *  always see everything regardless. Pre-sorted by likelihood. */
export const fetchOpenRisks = (scope: "mine" | "all" = "all") =>
  apiClient
    .get<{ risks: DashboardRisk[] }>("/dashboard/risks", { params: { scope } })
    .then((r) => r.data.risks);

/** Everything on the signed-in person's plate: action counts, which portfolios
 *  the open work is concentrated in, and the change-order / agenda / draft
 *  queue.
 *
 *  ALWAYS cross-portfolio — the endpoint takes no scope argument. The
 *  per-portfolio card narrows the response client-side, which it can only do
 *  honestly for the figures the payload breaks down per portfolio (`open`,
 *  `overdue`, and the queue rows, which carry `project_id`). The date-window
 *  counts are whole-plate totals and must not be relabelled as one
 *  portfolio's. */
export const fetchMyWork = () =>
  apiClient.get<MyWork>("/dashboard/my-work").then((r) => r.data);
export const fetchSettings = () =>
  apiClient.get<Settings>("/settings").then((r) => r.data);

// ---------- current user (/api/me) ----------
/**
 * Fetch the DB-backed identity for the signed-in user. 401s when the
 * Bearer token isn't valid — callers should treat that as "anonymous"
 * and skip the call. `is_admin` drives the "scope" toggle defaulting
 * + the membership-aware list-projects bypass.
 */
export const fetchMe = () =>
  apiClient.get<MeResponse>("/me").then((r) => r.data);

/** Lightweight user directory used by the action-owner typeahead. ``q``
 *  is a case-insensitive substring filter on name/email; empty returns
 *  everyone (fine at our team size). */
export interface UserStub {
  id: number;
  name: string | null;
  email: string | null;
}
export const listUsers = (q = "", limit = 20) =>
  apiClient
    .get<UserStub[]>("/users", { params: { q, limit } })
    .then((r) => r.data);

// ---------- project members (PM membership) ----------
/** List PMs assigned to a portfolio. Used by the Manage Team modal and
 *  the ContextSwitcher's "👤 …" secondary line. */
export const listProjectMembers = (projectId: number) =>
  apiClient
    .get<ProjectMember[]>(`/projects/${projectId}/members`)
    .then((r) => r.data);

/** Assign a user to a portfolio. Pass `user_id` for a known User row, or
 *  `email` for a Castillo-directory lookup. Email triggers a 404 when no
 *  matching User row exists — surface the message and ask the target to
 *  sign in once before retrying. */
export const addProjectMember = (
  projectId: number,
  payload: { user_id?: number; email?: string },
) =>
  apiClient
    .post<ProjectMember>(`/projects/${projectId}/members`, payload)
    .then((r) => r.data);

/** Remove a PM from a portfolio. Uses the member row id, not the user id —
 *  matches the backend's `/api/project-members/{member_id}` route. */
export const removeProjectMember = (memberId: number) =>
  apiClient.delete(`/project-members/${memberId}`);

// ---------- admin console (user + client management) ----------
/**
 * Full user directory for the admin console — role, active state, last seen
 * and portfolio memberships in one round trip.
 *
 * Admin-gated on the server: a non-admin gets 403 here regardless of what
 * the SPA chooses to render, so hiding the Settings section is presentation
 * only and never the control.
 */
/** The User Management grid: the eight column definitions plus a row per
 *  person. Admin-or-`user_mgmt` only, enforced server-side. */
export const listAdminUsers = () =>
  apiClient.get<AdminUserGrid>("/admin/users").then((r) => r.data);

/**
 * Edit one row of the grid: title, department, any of the eight permissions,
 * admin, or active/offboarded. Never deletes — an offboarded user keeps every
 * meeting, action and record they authored.
 *
 * Every field is optional and omitted fields are left untouched, `permissions`
 * included: send only the box that moved, so two toggles a second apart merge
 * instead of racing to write the whole map.
 *
 * The server owns the refusals (an ADMIN_EMAILS floor admin, the last
 * remaining admin, acting on yourself, a non-admin reaching for an admin) and
 * each comes back as a 4xx whose message explains the fix. Surface
 * `ApiError.message` verbatim instead of re-deriving which rule fired — that
 * logic would drift from the backend, and the backend is the one that counts.
 */
export const updateAdminUser = (
  userId: number,
  payload: {
    is_admin?: boolean;
    is_active?: boolean;
    /** "" deliberately blanks the field; omit to leave it alone. */
    title?: string;
    department?: string;
    permissions?: UserPermissionsPatch;
  },
) =>
  apiClient
    .patch<AdminUser>(`/admin/users/${userId}`, payload)
    .then((r) => r.data);

/**
 * Tick one permission for several people at once — the whole point of the
 * select-rows-then-act bar.
 *
 * ALL-OR-NOTHING on the server. A permission change has to have one answer to
 * "did that land?", and "for five of them" is not an answer anyone can act on
 * without re-reading the grid row by row, which is the work this route exists
 * to remove. So a batch containing even one untouchable person (an admin, an
 * ADMIN_EMAILS floor admin, yourself) writes nothing and comes back 409 —
 * carrying EVERY refusal, not just the first, so retrying isn't whack-a-mole.
 * Read them with `bulkPermissionRefusals()`; `ApiError.message` already
 * carries the human sentence.
 *
 * Only permissions. `is_admin` and `is_active` stay per-row on purpose:
 * minting an administrator deserves a look, and bulk offboarding is how a
 * whole team vanishes in one mis-click.
 *
 * Returns the updated rows in the grid's own shape, so the caller splices them
 * in instead of refetching the table.
 */
export const bulkUpdatePermissions = (
  userIds: number[],
  permissions: UserPermissionsPatch,
) => {
  const body: AdminBulkPermissionsRequest = {
    user_ids: userIds,
    permissions,
  };
  return apiClient
    .post<AdminUser[]>("/admin/users/bulk", body)
    .then((r) => r.data);
};

/** The per-person refusals inside a rejected `bulkUpdatePermissions()` call,
 *  so the grid can mark the exact rows rather than making the admin match
 *  names out of a sentence. Returns `[]` for any other failure — a network
 *  drop is not a refusal, and treating it as "nobody was blocked" is the safe
 *  reading. */
export function bulkPermissionRefusals(e: unknown): AdminBulkRefusal[] {
  if (!(e instanceof ApiError) || e.status !== 409) return [];
  const detail = e.detail as { error?: string; refusals?: unknown } | null;
  if (!detail || typeof detail !== "object") return [];
  if (detail.error !== "bulk_refused") return [];
  const rows = Array.isArray(detail.refusals) ? detail.refusals : [];
  return rows.filter(
    (r): r is AdminBulkRefusal =>
      !!r && typeof r === "object" && typeof (r as AdminBulkRefusal).user_id === "number",
  );
}

/**
 * Create the PMO 360 row for a Castillo colleague who has never signed in, so
 * they can be set up before their first day.
 *
 * `oid` MUST be the Entra directory GUID — Graph's `/users` `id`, which is
 * what the directory picker hands over. The sign-in path matches on that and
 * nothing else, so any other value creates a row the person will never
 * authenticate into while a second one silently takes their place. The server
 * refuses a non-GUID with a 422 rather than accepting an invisible mistake.
 *
 * 409 means they are already here — same object id, or the same email under a
 * different one. Surface it; the fix is to edit (or reactivate) the existing
 * row, never to add a second.
 *
 * The new row starts with the same default grants a self-signup would get, so
 * provisioning changes *when* the account exists, not *what* it can do.
 */
export const provisionUser = (payload: ProvisionUserRequest) =>
  apiClient
    .post<AdminUser>("/admin/users/provision", payload)
    .then((r) => r.data);

/**
 * Assign or unassign several people across several portfolios in one act.
 *
 * Idempotent by design: re-adding an existing assignment or removing one that
 * was never there is counted in `skipped`, not an error, so the caller can
 * offer 8 people × 6 portfolios without first working out which of the 48
 * pairs already exist.
 *
 * `flipped` IS A VISIBILITY REPORT, NOT A SECURITY ONE — read the note on
 * `MembershipFlip` before writing UI copy from it. Portfolio scoping is off
 * (auth/permissions.py::is_portfolio_member returns true for any signed-in
 * user), so an assignment changes whose Mine/dashboard a portfolio appears on
 * and nothing else. It never limits who may write there.
 */
export const bulkAssignMemberships = (
  userIds: number[],
  projectIds: number[],
  action: "add" | "remove",
) => {
  const body: AdminBulkMembershipRequest = {
    user_ids: userIds,
    project_ids: projectIds,
    action,
  };
  return apiClient
    .post<AdminBulkMembershipResult>("/admin/memberships/bulk", body)
    .then((r) => r.data);
};

// ---------- calendar sync ----------
/** Raw event-summary the calendar match endpoint accepts. ``key`` is whatever
 *  identifier the caller wants echoed back in the response (we always pass
 *  the Graph event id so the frontend can splice the project match back
 *  onto the original event row). */
export interface CalendarMatchEventIn {
  /** The occurrence's own Graph event id — echoed back so the frontend can
   *  splice the match onto the right row. */
  key: string;
  /** The link key — series master id for recurring meetings, else the event
   *  id. Manual links are stored + looked up against this, so linking one
   *  occurrence of a weekly meeting matches every occurrence. */
  series_key?: string;
  subject?: string;
  attendee_emails?: string[];
}

/** One row of the match result. ``project_id === null`` means the event
 *  didn't match any portfolio the user can see — the frontend still renders
 *  the event but tags it as "unassigned" and offers a manual picker.
 *  ``is_manual: true`` means the match came from a persisted
 *  CalendarEventLink (PM-confirmed); we don't second-guess those. */
export interface CalendarMatchOut {
  key: string;
  project_id: number | null;
  project_name: string | null;
  client_name: string | null;
  match_reason: "manual" | "email" | "subject" | null;
  is_manual: boolean;
}

/**
 * Send a list of Outlook events to the backend and get back which PMO
 * portfolio (if any) each one matches.
 *
 * Why the matching happens server-side: the per-portfolio attendee email
 * index is private data — we don't want to dump every roster email to
 * every browser session. The backend joins against ProjectAttendee +
 * MeetingAttendee, layers in any persisted manual links, and falls back
 * to a name-substring match on the event subject for portfolios that
 * don't yet have any attendee emails on file.
 */
export const matchCalendarEvents = (events: CalendarMatchEventIn[]) =>
  apiClient
    .post<{ matches: CalendarMatchOut[] }>("/calendar/match", { events })
    .then((r) => r.data.matches);

/** Pin a Microsoft Graph event to a specific PMO portfolio. The link
 *  persists across reloads and takes priority over auto-match. Idempotent. */
export interface CalendarLinkOut {
  graph_event_id: string;
  project_id: number;
  project_name: string | null;
  client_name: string | null;
  linked_at: string;
}
export const linkCalendarEvent = (
  graph_event_id: string,
  project_id: number,
) =>
  apiClient
    .post<CalendarLinkOut>("/calendar/link", { graph_event_id, project_id })
    .then((r) => r.data);

/** Remove a manual link. After unlink the next /match call falls back to
 *  the email/subject heuristics. Safe to call on a non-existent link
 *  (backend returns 204 either way). */
export const unlinkCalendarEvent = (graph_event_id: string) =>
  apiClient.delete(`/calendar/link/${encodeURIComponent(graph_event_id)}`);

// ---------- user preferences ----------
export interface UserPreferences {
  default_project_id?: number | null;
  default_meeting_duration: number;
  default_action_due_offset_days: number;
  email_signature?: string | null;
  /** When true, the Send page auto-emails minutes to attendees right after
   *  the PM finalizes a meeting (client-side Graph send). Off by default. */
  auto_send_minutes_on_finalize?: boolean;
  /** Portfolios the PM has starred, in pin order. Rendered as quick-jump
   *  chips in the header's context row. */
  pinned_project_ids?: number[];
}
export const fetchMyPreferences = () =>
  apiClient.get<UserPreferences>("/users/me/preferences").then((r) => r.data);
export const updateMyPreferences = (p: UserPreferences) =>
  apiClient.put<UserPreferences>("/users/me/preferences", p).then((r) => r.data);

// ---------- meeting attachments ----------
export interface MeetingAttachment {
  id: number;
  meeting_id: number;
  filename: string;
  content_type?: string | null;
  file_size_bytes?: number | null;
  description?: string | null;
  created_by?: import("./types").UserStub | null;
  created_at?: string;
}

export const listAttachments = (meetingId: number) =>
  apiClient
    .get<MeetingAttachment[]>(`/meetings/${meetingId}/attachments`)
    .then((r) => r.data);

export const uploadAttachment = async (
  meetingId: number,
  file: File,
  description?: string,
) => {
  const form = new FormData();
  form.append("file", file);
  if (description) form.append("description", description);
  const res = await apiClient.post<MeetingAttachment>(
    `/meetings/${meetingId}/attachments`,
    form,
    {
      // Let the browser pick the multipart boundary; do NOT set Content-Type
      // by hand or the boundary parameter is lost.
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 5 * 60 * 1000,
    },
  );
  return res.data;
};


export const deleteAttachment = (id: number) =>
  apiClient.delete(`/attachments/${id}`);

// ---------- global Cmd+K search ----------
export interface SearchResult {
  kind: "client" | "portfolio" | "meeting" | "agenda" | "action";
  id: number;
  label: string;
  subtitle?: string | null;
  client_id?: number | null;
  project_id?: number | null;
  // Pre-computed slugs so the palette can build a destination URL without a
  // round-trip to /clients + /projects.
  client_slug?: string | null;
  portfolio_slug?: string | null;
}

export const search = (q: string) =>
  apiClient
    .get<{ results: SearchResult[] }>("/search", { params: { q } })
    .then((r) => r.data.results);

// ---------- AI Home briefing ----------
/** Personalized "since you were last here..." card shown at the top of Home.
 * Counts are scoped to the signed-in user (owner-substring match for actions,
 * created_by for notes/agendas). `briefing` is the LLM prose, never null —
 * the backend falls back to a deterministic template on LLM failure so the
 * endpoint never 502s. */
export interface Briefing {
  last_seen_at: string | null;
  new_actions_assigned_to_me: number;
  overdue_actions_assigned_to_me: number;
  new_meetings_touched: number;
  new_agendas_touched: number;
  new_follow_up_notes: number;
  briefing: string;
}
export const fetchBriefing = () =>
  apiClient.get<Briefing>("/dashboard/briefing").then((r) => r.data);

// ---------- change orders ----------
/** Line-item payload for create/update (server replaces the full list). */
export interface ChangeOrderAllocationInput {
  role?: string | null;
  rate?: number | null;
  hours?: number | null;
}
export interface ChangeOrderLineItemInput {
  details?: string;
  cost?: number | null;
  allocations?: ChangeOrderAllocationInput[] | null;
  role?: string | null;
  hourly_rate?: number | null;
  hours?: number | null;
  internal_notes?: string | null;
}
export interface ChangeOrderCreate {
  project_id: number;
  /** Optional sub-project under that portfolio — internal filing for rollups
   *  and filtering. Distinct from `project_name` below, which is the label
   *  that prints on the client's PDF. Null = the portfolio as a whole. */
  portfolio_project_id?: number | null;
  co_version?: string;
  project_name?: string | null;
  title?: string | null;
  rate_type: "fixed" | "hourly";
  request_date?: string | null;
  requested_by?: string | null;
  requested_by_user_id?: number | null;
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
  /** Internal cost adders as percentages of the line-item subtotal (5 = 5%).
   *  Additive on the base, never compounded. Send a number and never null: the
   *  columns are NOT NULL server-side, and an omitted key on a PATCH would
   *  leave a cleared field priced at its old markup. */
  pmo_pct?: number;
  admin_pct?: number;
  notes?: string | null;
  line_items: ChangeOrderLineItemInput[];
}

// projectId omitted → aggregate across all portfolios (optionally narrowed to a
// client). Used by the "All clients" CO view + the Home rollup card.
// `sent` splits approved COs into still-to-send (false) vs already-delivered
// (true); omit it to get both.
export const listChangeOrders = (
  projectId?: number | null,
  status?: "draft" | "pending" | "sent_back" | "approved",
  clientId?: number | null,
  sent?: boolean,
) =>
  apiClient
    .get<ChangeOrder[]>("/change-orders", {
      params: {
        ...(projectId != null ? { project_id: projectId } : {}),
        ...(clientId != null ? { client_id: clientId } : {}),
        ...(status ? { status } : {}),
        ...(sent != null ? { sent } : {}),
      },
    })
    .then((r) => r.data);

export const getChangeOrder = (id: number) =>
  apiClient.get<ChangeOrder>(`/change-orders/${id}`).then((r) => r.data);

export const createChangeOrder = (payload: ChangeOrderCreate) =>
  apiClient.post<ChangeOrder>("/change-orders", payload).then((r) => r.data);

export const updateChangeOrder = (
  id: number,
  payload: Partial<ChangeOrderCreate> & {
    expected_version?: number;
    line_items?: ChangeOrderLineItemInput[];
  },
) => apiClient.patch<ChangeOrder>(`/change-orders/${id}`, payload).then((r) => r.data);

export const submitChangeOrder = (id: number) =>
  apiClient.post<ChangeOrder>(`/change-orders/${id}/submit`).then((r) => r.data);
/**
 * Approve a pending CO — the money decision.
 *
 * `expected_version` is the version the approver was ACTUALLY LOOKING AT. Send
 * it. A pending CO is still fully PATCH-editable (the edit freeze only starts at
 * approved), so it can be re-priced between the request email going out and the
 * approver clicking the link, and an approval is an approval of a number. A
 * mismatch comes back as the same `{error: "stale_version", current_version}`
 * 409 `updateChangeOrder` returns — `isStaleVersionError()` recognises it.
 *
 * The whole body is optional ONLY so an SPA tab loaded before this shipped keeps
 * working; new callers have no reason to omit it. That backwards compatibility
 * is also why the server does not rely on it: it independently compares the CO's
 * current version against the one recorded on the caller's last UNANSWERED
 * approval request — pending or withdrawn, since withdrawing is a CO_CREATION
 * route and must not double as a way to switch the guard off — and refuses with
 * `{error: "stale_co", ...}`. See `isStaleCoError()`. Both guards can fire;
 * handle both.
 *
 * `note` is recorded on the approver's request row, which is the only place the
 * decision survives — a later send-back NULLs the approval columns on the CO.
 *
 * Approving does NOT email the client, and must not be wired to. The order is
 * approve -> send-check -> Graph -> mark-sent, deliberately and in that order —
 * see `checkChangeOrderSendable`, which exists because getting it wrong once put
 * the same priced change order in a client's inbox twice.
 */
export const approveChangeOrder = (
  id: number,
  body?: { expected_version?: number | null; note?: string | null },
) =>
  apiClient
    .post<ChangeOrder>(`/change-orders/${id}/approve`, body ?? {})
    .then((r) => r.data);

/** Send a pending CO back to the requester. `note` is the reason, recorded on
 *  the rejecter's own approval-request row. The rows themselves survive: reject
 *  clears the approval stamp on the change order, so they are the only record
 *  that anyone was ever asked or ever answered. */
export const rejectChangeOrder = (id: number, body?: { note?: string | null }) =>
  apiClient
    .post<ChangeOrder>(`/change-orders/${id}/reject`, body ?? {})
    .then((r) => r.data);

/**
 * Ask one or more named people to approve a pending CO.
 *
 * FIRST RESPONDER DECIDES — this is a list of people who MAY decide, not a chain
 * that all must. The first to approve or send back settles it and every other
 * outstanding request on that CO closes as "superseded". Adding a second name is
 * insurance against one person being on leave, not a second signature.
 *
 * Re-asking somebody who is already pending on this CO closes their old request
 * as "superseded" and files a fresh one at the CO's current version and price,
 * so nobody is ever outstanding twice and the button is safe to press again.
 * That is also the supported way to clear a `stale_co` refusal after a pending
 * CO has been re-priced — the new row is what the approver is being shown now,
 * and the old one stays on the record as what they were first asked. Send the
 * email when you do it: the server has no way to know whether you did, and the
 * person still holding the old figure is the one clicking Approve.
 * 409 if the CO is not `pending` (only a submitted one can be sent for
 * approval), 400 on an empty `recipients` list or on a `user_id` whose account
 * does not match the address next to it.
 *
 * THIS DOES NOT SEND THE EMAIL. The mail goes out client-side from the PM's own
 * mailbox over Graph, exactly like the CO delivery mail — the server never sees
 * it. What comes back is the recorded requests plus `approval_path`, the in-app
 * path of the change order; prefix the app origin to build the link for the mail
 * body. The link is a normal authenticated route: the recipient signs in with
 * Microsoft as usual and lands on the CO. No token in the URL, nothing public.
 */
export const requestChangeOrderApproval = (
  coId: number,
  body: { recipients: ApprovalRecipientInput[]; note?: string | null },
) =>
  apiClient
    .post<ApprovalRequestResult>(`/change-orders/${coId}/request-approval`, body)
    .then((r) => r.data);

/** Every approval request raised on this CO, newest first — answered ones
 *  included, because together they ARE the approval history. Open to anyone who
 *  can read the CO, same as the other CO reads. */
export const fetchChangeOrderApprovalRequests = (coId: number) =>
  apiClient
    .get<{ requests: ApprovalRequest[] }>(
      `/change-orders/${coId}/approval-requests`,
    )
    .then((r) => r.data.requests);

/** Withdraw one outstanding request — pending becomes "cancelled". The row is
 *  not deleted: who was asked, and that the ask was pulled, both stay on the
 *  record. Only a pending request can be cancelled. */
export const cancelChangeOrderApprovalRequest = (coId: number, reqId: number) =>
  apiClient.delete(`/change-orders/${coId}/approval-requests/${reqId}`);
// `method` records HOW it went out ("graph" | "outlook" | "manual"). Omitted by
// older callers, which the server stores as an unknown method.
export const markChangeOrderSent = (
  id: number,
  recipients: string,
  method?: "graph" | "outlook" | "manual",
) =>
  apiClient
    .post<ChangeOrder>(`/change-orders/${id}/mark-sent`, {
      recipients,
      ...(method ? { method } : {}),
    })
    .then((r) => r.data);
export const deleteChangeOrder = (id: number) =>
  apiClient.delete(`/change-orders/${id}`);

/** Authed blob fetch of the branded CO PDF (require_db_user behind it). */
export const fetchChangeOrderPdfBlob = async (id: number) => {
  const res = await apiClient.get(`/change-orders/${id}/pdf/file`, {
    responseType: "blob",
  });
  return res.data as Blob;
};

/**
 * "May I send this, and has it already gone out?" — ASK BEFORE emailing.
 *
 * The send itself is client-side: the PM's own delegated Mail.Send, straight
 * from the browser, which the server never sees and cannot stop. So this is the
 * only place a refusal can happen in time to matter, and it only works if the
 * caller asks FIRST. Await it, and email nothing until it resolves.
 *
 * It replaces an ordering bug worth remembering: the dialog fetched the PDF,
 * called Graph, and only then called mark-sent — which is gated on CO_APPROVAL.
 * A PM holding only CO_CREATION therefore delivered the change order to the
 * client, got a permission error that read like "the send failed", and left
 * `sent_at` NULL. The CO stayed in the to-send queue and the next person sent
 * it again, so the client received the same priced change order twice.
 *
 * THROWS on refusal rather than returning a flag — 403 for a missing
 * CO_APPROVAL permission, 409 for a CO that is not approved yet. Both carry the
 * server's own sentence in `ApiError.message`, which names the permission or
 * the status; show it rather than a generic failure, and distinguish the two by
 * `ApiError.status` if the dialog needs to. Resolving at all IS the yes.
 *
 * A resolved result with a non-null `already_sent_at` is the duplicate warning:
 * it has reached the client once already. Not a refusal — a genuine re-send to
 * a new recipient is legitimate — so confirm with the PM before continuing.
 */
export const checkChangeOrderSendable = (coId: number) =>
  apiClient
    .post<ChangeOrderSendCheck>(`/change-orders/${coId}/send-check`)
    .then((r) => r.data);

/**
 * Render the CO exactly as the client will receive it, from the UNSAVED form.
 *
 * Takes the create payload rather than an id because the Create tab has none
 * until the first save, and saving a draft just to look at it would drop a
 * half-finished change order into the In-flight rail every time somebody wanted
 * to sanity-check a total. The server persists nothing — not the CO, not the
 * number it shows.
 *
 * The bytes are identical to the issued document, so the FILENAME carries
 * "-PREVIEW" as the only thing standing between this and someone downloading it
 * from the viewer and emailing a change order that was never approved. Keep
 * that marker on anything the caller saves or names.
 *
 * Gated on CO_CREATION, same as create: it composes a Castillo-branded,
 * client-facing document out of caller-supplied text.
 */
export const previewChangeOrderPdfBlob = async (payload: ChangeOrderCreate) => {
  try {
    const res = await apiClient.post("/change-orders/preview", payload, {
      responseType: "blob",
    });
    return res.data as Blob;
  } catch (e) {
    throw await readBlobDetail(e);
  }
};

/** Reopen the JSON error body that `responseType: "blob"` sealed into a Blob,
 *  and rebuild the ApiError around the server's actual message.
 *
 *  Without this, every refusal on a blob route reads "Request failed with
 *  status code 403" — and the sentence this app's permission layer goes to the
 *  trouble of writing (it names the missing permission and where to ask for it)
 *  is thrown away at the one moment it would have helped. Returns the original
 *  error untouched when the body is not JSON, which is the real-PDF-that-died
 *  case. */
async function readBlobDetail(e: unknown): Promise<unknown> {
  if (!(e instanceof ApiError) || !(e.detail instanceof Blob)) return e;
  try {
    const detail = JSON.parse(await e.detail.text())?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : detail && typeof detail === "object" && "message" in detail
          ? String((detail as { message: unknown }).message)
          : null;
    return message ? new ApiError(message, e.status, detail) : e;
  } catch {
    return e;
  }
}

// ---------- client contacts (Settings -> Clients) ----------
/** Everyone we know on the client side. Omit `clientId` for the whole
 *  directory — which is also the ONLY way to reach the unfiled rows, since a
 *  contact with no client cannot be found by filtering on one. Open like every
 *  other GET in this module. */
export const listClientContacts = (clientId?: number) =>
  apiClient
    .get<ClientContact[]>("/client-contacts", {
      params: clientId != null ? { client_id: clientId } : {},
    })
    .then((r) => r.data);

/** Needs `client_mgmt`, as do patch/delete/import below. */
export const createClientContact = (payload: ClientContactInput) =>
  apiClient.post<ClientContact>("/client-contacts", payload).then((r) => r.data);

/** Partial by design: omitted keys are left alone server-side, so two fields
 *  edited a moment apart can't clobber each other with a whole-row write.
 *  Sending `client_id: null` is the deliberate "unfile this one" — distinct
 *  from omitting the key, which changes nothing. */
export const updateClientContact = (
  id: number,
  payload: Partial<ClientContactInput>,
) =>
  apiClient
    .patch<ClientContact>(`/client-contacts/${id}`, payload)
    .then((r) => r.data);

export const deleteClientContact = (id: number) =>
  apiClient.delete(`/client-contacts/${id}`);

/** Sweep the addresses the app has already collected into the directory.
 *
 *  Takes no argument: the source is server-side, and re-runnable — a second
 *  pass counts known contacts in `skipped` rather than duplicating them, so
 *  the button is safe to press twice.
 *
 *  Contacts whose domain matches no client are IMPORTED UNFILED, not rejected,
 *  and named in `unmatched` so the tab can send an admin straight to them. */
export const importClientContacts = () =>
  apiClient
    .post<unknown>("/client-contacts/import")
    .then((r) => toImportResult(r.data));

/** Normalise the import result instead of trusting the cast.
 *
 *  This is the one route in the contract with no sibling to copy, so `unmatched`
 *  is the likeliest field to come back as objects rather than the strings this
 *  module promises — and an admin reading a list of "[object Object]" is a worse
 *  outcome than a slightly lossy label. Cheap insurance at exactly one seam;
 *  delete it once the server side is pinned down. */
function toImportResult(raw: unknown): ClientContactImportResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(r.unmatched) ? r.unmatched : [];
  return {
    imported: typeof r.imported === "number" ? r.imported : 0,
    skipped: typeof r.skipped === "number" ? r.skipped : 0,
    unmatched: rows.map((v) => {
      if (typeof v === "string") return v;
      const o = (v ?? {}) as Record<string, unknown>;
      const label = o.email ?? o.domain ?? o.name;
      return typeof label === "string" ? label : String(v);
    }),
  };
}

// ---------- monday.com ----------
export interface MondayStatus {
  configured: boolean;
  error?: string | null;
  project_count: number;
  mapped_count: number;
}
/** One PMO 360 row a Monday project is (or could be) linked to. */
export interface MondayTarget {
  kind: "portfolio" | "project";
  id: number;
  name: string;
  client_name?: string | null;
  /** Set for kind="project" — the portfolio it sits under. */
  portfolio_name?: string | null;
}
export interface MondayProject {
  monday_item_id: number;
  name: string;
  project_code?: string | null;
  client_name?: string | null;
  project_site?: string | null;
  contract_status?: string | null;
  /** Many, because one Monday project can cover several of ours. */
  linked: MondayTarget[];
  /** Name matches we would propose; empty once anything is linked. */
  suggestions: MondayTarget[];
}
export interface AutoMapResult {
  applied: string[];
  skipped_ambiguous: string[];
  skipped_no_match: string[];
  skipped_already_linked: string[];
}

export const mondayStatus = () =>
  apiClient.get<MondayStatus>("/monday/status").then((r) => r.data);
export const listMondayProjects = () =>
  apiClient.get<MondayProject[]>("/monday/projects").then((r) => r.data);
export const setMondayMapping = (payload: {
  monday_item_id: number;
  project_code?: string | null;
  kind: "portfolio" | "project";
  id: number;
}) => apiClient.post<MondayProject>("/monday/mapping", payload).then((r) => r.data);
/** Removes ONE link. monday_item_id is required so dropping one of several
 *  linked Monday projects cannot take its siblings with it. */
export const clearMondayMapping = (params: {
  kind: "portfolio" | "project";
  id: number;
  monday_item_id: number;
}) => apiClient.delete("/monday/mapping", { params });
export const autoMapMonday = () =>
  apiClient.post<AutoMapResult>("/monday/automap").then((r) => r.data);
/** RFIs from monday.com, already tagged with the sub-project they print under.
 *
 *  Four widths, narrowest id winning, mirroring the Actions list:
 *    { portfolio_project_id } -> one project
 *    { project_id }           -> one portfolio and everything under it
 *    { client_id }            -> every portfolio under that client
 *    {}                       -> every mapped RFI in the company
 */
export const listPortfolioRfis = (
  scope: {
    project_id?: number;
    client_id?: number;
    portfolio_project_id?: number;
  } | number,
) =>
  apiClient
    .get<MeetingRfi[]>("/monday/rfis", {
      // A bare number is still accepted so the meeting picker, which only ever
      // asks for one portfolio, does not have to change.
      params: typeof scope === "number" ? { project_id: scope } : scope,
    })
    .then((r) => r.data);

// ---- monday.com bridge (demo surface) -------------------------------------
// Two-way: reads the sandbox boards, pushes change orders onto them. The
// backend refuses to push at all unless it is pointed at the sandbox, so a
// misconfigured deployment turns the demo off rather than arming it.

export interface BridgeStatus {
  configured: boolean;
  profile: string;
  can_push: boolean;
  boards: Record<string, string>;
  note?: string | null;
}

export interface BridgeRow {
  id: number;
  name: string;
  url: string;
  cells: Record<string, string | number | number[] | null>;
}

export interface BridgeBoard {
  key: string;
  label: string;
  board_id: number;
  /** semantic name -> monday column id, so the page never hardcodes an id */
  columns: Record<string, string>;
  rows: BridgeRow[];
}

export interface BridgePushRequest {
  monday_project_item_id: number;
  co_number: number;
  total_amount: number;
  status: string;
  portfolio_name: string;
  project_code?: string | null;
  subject?: string | null;
  description?: string | null;
  effective_date?: string | null;
  sent_to?: string | null;
}

export interface BridgeMoney {
  id: number;
  name: string;
  linked_change_orders: number[];
  change_order_amount: string | null;
  total_contract_value: string | null;
  deal_value: string | null;
}

export interface BridgePushResult {
  payload: { item_name: string; column_values: Record<string, unknown>; board: string };
  item: { id: string; name: string; url: string; action: string };
  before: BridgeMoney;
  after: BridgeMoney;
}

export const bridgeStatus = () =>
  apiClient.get<BridgeStatus>("/monday/bridge/status").then((r) => r.data);
export const bridgeBoard = (key: "portfolio" | "rfis" | "change_orders") =>
  apiClient.get<BridgeBoard>(`/monday/bridge/board/${key}`).then((r) => r.data);
export const bridgePreview = (payload: BridgePushRequest) =>
  apiClient
    .post<{ payload: BridgePushResult["payload"] }>("/monday/bridge/preview", payload)
    .then((r) => r.data.payload);
export const bridgePush = (payload: BridgePushRequest) =>
  apiClient.post<BridgePushResult>("/monday/bridge/push", payload).then((r) => r.data);

export interface BridgeClientRollup {
  client: string;
  projects: number;
  /** Sum across only this client's priced projects — see projects_priced. */
  contract_value: number;
  /** How many carry a contract value at all. 0 means "nothing recorded",
   *  which is not the same claim as "zero dollars". */
  projects_priced: number;
  change_order_value: number;
  open_rfis: number;
  /** Open RFIs whose response owner is the client — the accountability number. */
  rfis_on_client: number;
  avg_open_age_days: number | null;
  oldest_open_age_days: number | null;
  statuses: Record<string, number>;
}

export interface BridgeProjectRollup {
  id: number;
  name: string;
  project_code: string | null;
  client: string | null;
  contract_status: string | null;
  /** null = not set on the board. Never render this as $0. */
  contract_value: number | null;
  change_order_value: number;
  open_rfis: number;
  oldest_open_age_days: number | null;
}

export interface BridgeRollup {
  as_of: string;
  totals: {
    clients: number;
    projects: number;
    contract_value: number;
    change_order_value: number;
    rfis_total: number;
    rfis_open: number;
    rfis_on_client: number;
    pct_on_client: number;
    projects_priced: number;
  };
  by_client: BridgeClientRollup[];
  by_project: BridgeProjectRollup[];
  data_quality: Record<string, number>;
}

export const bridgeRollup = () =>
  apiClient.get<BridgeRollup>("/monday/bridge/rollup").then((r) => r.data);

// ---- live per-project task boards -----------------------------------------
// These read the REAL task boards, not the sandbox: the sandbox exists to make
// writes safe, and a status dashboard built on copied data would be a mock-up.

export interface BridgeTaskBoardRef {
  board_id: number;
  name: string;
  task_count: number;
}

export interface BridgePhaseRollup {
  phase: string;
  total: number;
  done: number;
  in_progress: number;
  blocked: number;
  not_started: number;
  pct_complete: number;
}

export interface BridgeTaskFlag {
  id: number;
  name: string;
  phase: string | null;
  status: string | null;
  owner: string | null;
  discipline: string | null;
  reason: string;
  days_overdue: number | null;
}

export interface BridgeTaskBoard {
  board_id: number;
  board_name: string;
  task_count: number;
  totals: {
    done: number;
    open: number;
    pct_complete: number;
    targeted_hours: number;
    actual_hours: number;
    hours_variance: number;
    billable_cost: number;
    actual_cost: number;
    flagged: number;
  };
  by_phase: BridgePhaseRollup[];
  by_status: Record<string, number>;
  by_discipline: Record<string, number>;
  by_owner: { owner: string; total: number; open: number; blocked: number }[];
  flags: BridgeTaskFlag[];
}

export const bridgeTaskBoards = () =>
  apiClient.get<BridgeTaskBoardRef[]>("/monday/bridge/task-boards").then((r) => r.data);
export const bridgeTasks = (boardId: number) =>
  apiClient.get<BridgeTaskBoard>(`/monday/bridge/tasks/${boardId}`).then((r) => r.data);
