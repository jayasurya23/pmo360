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
  GlobalAttendee,
  Attendee,
  ParsedMeeting,
  DashboardResponse,
  Settings,
  ParseRequest,
  MeetingSaveRequest,
  AgendaSaveRequest,
  AgendaDocRequest,
} from "./types";

// Honor VITE_API_BASE at build-time so the same artefact can talk to
// a backend at /api (same origin), https://api.example.com, etc.
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "/api";

export const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
});

apiClient.interceptors.response.use(
  (r) => r,
  (err) => {
    const msg = err?.response?.data?.detail || err.message || "Request failed";
    return Promise.reject(new Error(msg));
  }
);

// ---------- clients / projects ----------
export const listClients = () =>
  apiClient.get<Client[]>("/clients").then((r) => r.data);
export const createClient = (payload: { name: string; email_domain?: string }) =>
  apiClient.post<Client>("/clients", payload).then((r) => r.data);
export const deleteClient = (id: number) => apiClient.delete(`/clients/${id}`);

export const listProjects = (clientId: number) =>
  apiClient
    .get<Project[]>("/projects", { params: { client_id: clientId } })
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
export const meetingDocUrl = (meetingId: number, kind: "pdf" | "docx" | "xlsx") =>
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
export const listActions = (projectId: number, onlyOpen = false) =>
  apiClient
    .get<ActionItem[]>("/actions", {
      params: { project_id: projectId, only_open: onlyOpen },
    })
    .then((r) => r.data);
export const updateAction = (
  id: number,
  payload: Partial<{
    text: string;
    owner: string;
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
export const generateAgendaDoc = async (
  payload: AgendaDocRequest,
  fmt: "pdf" | "docx"
) => {
  const res = await apiClient.post(`/agendas/generate?fmt=${fmt}`, payload, {
    responseType: "blob",
  });
  return res.data as Blob;
};

// ---------- schedules ----------
export const listSchedules = (projectId: number) =>
  apiClient
    .get<Schedule[]>("/schedules", { params: { project_id: projectId } })
    .then((r) => r.data);
export const parseScheduleFile = async (file: File) => {
  const form = new FormData();
  form.append("file", file);
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

// ---------- dashboard + settings ----------
export const fetchDashboard = () =>
  apiClient.get<DashboardResponse>("/dashboard").then((r) => r.data);
export const fetchSettings = () =>
  apiClient.get<Settings>("/settings").then((r) => r.data);
