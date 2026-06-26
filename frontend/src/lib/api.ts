import axios from "axios";
import type {
  Client,
  Project,
  Meeting,
  MeetingDetail,
  ActionItem,
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
  ProjectMember,
  ProposalBoard,
  ProposalListItem,
  ProposalOut,
  ProposalVersionDetail,
  ProposalItemNode,
  ProposalLogos,
  ProposalToTimelineResult,
  ProposalTimelineMilestones,
} from "./types";

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
    const detail = err?.response?.data?.detail;
    // detail can be either a string (FastAPI's default) or a dict (our 409
    // payload). Surface a readable message either way.
    let message: string;
    if (typeof detail === "string") {
      message = detail;
    } else if (detail && typeof detail === "object" && "message" in detail) {
      message = String((detail as any).message);
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
// Note: helper returns a URL the browser can hit directly (img/iframe/a[href]).
// We deliberately use `${API_BASE}` so production builds pick up an absolute
// backend URL when VITE_API_BASE is set.
export const meetingDocUrl = (
  meetingId: number,
  kind: "pdf" | "docx" | "xlsx" | "zip",
) =>
  `${API_BASE}/documents/meeting/${meetingId}?kind=${kind}`;
export const finalizeMeeting = (meetingId: number) =>
  apiClient
    .post<{ paths: Record<string, string>; stage: string }>(
      `/documents/meeting/${meetingId}/finalize`
    )
    .then((r) => r.data);
export const finalizedFileUrl = (path: string) =>
  `${API_BASE}/documents/file?path=${encodeURIComponent(path)}`;

// ---------- actions ----------
/** Direct CSV download URL for the Actions page export button. The browser
 *  hits this in a new tab and the Content-Disposition header triggers the
 *  download. Use as an anchor `href`, not via the axios client. */
export const actionsCsvUrl = (
  projectId: number | null,
  status: string = "all",
  owner: string = "",
) => {
  const params = new URLSearchParams({ status });
  // Omit project_id entirely for the cross-portfolio ("All portfolios") export.
  if (projectId != null) params.set("project_id", String(projectId));
  if (owner) params.set("owner", owner);
  return `${API_BASE}/actions/export.csv?${params.toString()}`;
};

export const listActions = (projectId: number, onlyOpen = false) =>
  apiClient
    .get<ActionItem[]>("/actions", {
      params: { project_id: projectId, only_open: onlyOpen },
    })
    .then((r) => r.data);

/** Every action across all portfolios (the Actions page default view). Each
 *  row carries project_name / client_name so the table can label its portfolio. */
export const listAllActions = (onlyOpen = false) =>
  apiClient
    .get<ActionItem[]>("/actions", { params: { only_open: onlyOpen } })
    .then((r) => r.data);
export const updateAction = (
  id: number,
  payload: Partial<{
    text: string;
    owner: string;
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
/** URL helper for the .ics calendar download — anchor with this in `href`. */
export const agendaIcsUrl = (agendaId: number) =>
  `${API_BASE}/agendas/${agendaId}/ics`;

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
export const listProposals = (portfolio_id?: number) =>
  apiClient
    .get<ProposalListItem[]>("/proposals", {
      params: portfolio_id != null ? { portfolio_id } : {},
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
export const fetchProposalPdfBlob = async (id: number, vid: number) => {
  const res = await apiClient.get(
    `/proposals/${id}/versions/${vid}/pdf/file`,
    { responseType: "blob" },
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
export const unlinkProposal = (id: number) =>
  apiClient.patch<ProposalOut>(`/proposals/${id}/unlink`).then((r) => r.data);
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

/** URL the browser can hit directly to download an attachment. */
export const attachmentDownloadUrl = (id: number) =>
  `${API_BASE}/attachments/${id}/download`;

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
