import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";
import { useNavigate, useLocation } from "react-router-dom";
import * as api from "./api";
import type { Client, Project, Settings, ParsedMeeting } from "./types";

interface AppState {
  // ---- reference data ----
  clients: Client[];
  projects: Project[];
  settings: Settings | null;
  // ---- selection ----
  selectedClientId: number | null;
  selectedProjectId: number | null;
  setSelectedClientId: (id: number | null) => void;
  setSelectedProjectId: (id: number | null) => void;
  // ---- draft meeting wizard state ----
  draftMeetingId: number | null;
  setDraftMeetingId: (id: number | null) => void;
  parsed: ParsedMeeting | null;
  setParsed: (p: ParsedMeeting | null) => void;
  rawNotes: { minutes: string; agenda: string; actions: string };
  setRawNotes: (next: { minutes: string; agenda: string; actions: string }) => void;
  meetingTitle: string;
  setMeetingTitle: (s: string) => void;
  meetingDate: string;
  setMeetingDate: (s: string) => void;
  selectedAttendees: { full_name: string; initials: string; organization: string }[];
  setSelectedAttendees: (a: { full_name: string; initials: string; organization: string }[]) => void;
  selectedDeliverables: {
    project_segment: string;
    task: string;
    start_status: string;
    delivery_date: string | null;
  }[];
  setSelectedDeliverables: (
    d: {
      project_segment: string;
      task: string;
      start_status: string;
      delivery_date: string | null;
    }[]
  ) => void;
  // ---- helpers ----
  refreshClients: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  currentClient: Client | null;
  currentProject: Project | null;
  resetDraft: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();

  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedClientId, _setSelectedClientId] = useState<number | null>(null);
  const [selectedProjectId, _setSelectedProjectId] = useState<number | null>(null);

  const [draftMeetingId, setDraftMeetingId] = useState<number | null>(null);
  const [parsed, setParsed] = useState<ParsedMeeting | null>(null);
  const [rawNotes, setRawNotes] = useState({
    minutes: "",
    agenda: "",
    actions: "",
  });
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingDate, setMeetingDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [selectedAttendees, setSelectedAttendees] = useState<
    { full_name: string; initials: string; organization: string }[]
  >([]);
  const [selectedDeliverables, setSelectedDeliverables] = useState<
    {
      project_segment: string;
      task: string;
      start_status: string;
      delivery_date: string | null;
    }[]
  >([]);

  const setSelectedClientId = (id: number | null) => {
    _setSelectedClientId(id);
    // Clear stale project when client changes
    _setSelectedProjectId(null);
    setProjects([]);
    if (id) localStorage.setItem("pmo360_client", String(id));
  };
  const setSelectedProjectId = (id: number | null) => {
    _setSelectedProjectId(id);
    if (id) localStorage.setItem("pmo360_project", String(id));
  };

  // ---- Initial load: clients + settings ----
  useEffect(() => {
    api
      .listClients()
      .then((cs) => {
        setClients(cs);
        const stored = Number(localStorage.getItem("pmo360_client"));
        const pick =
          (stored && cs.find((c) => c.id === stored)) || cs[0] || null;
        if (pick) _setSelectedClientId(pick.id);
      })
      .catch(console.error);

    api.fetchSettings().then(setSettings).catch(console.error);
  }, []);

  // ---- Projects load whenever client changes ----
  useEffect(() => {
    if (!selectedClientId) {
      setProjects([]);
      return;
    }
    api
      .listProjects(selectedClientId)
      .then((ps) => {
        setProjects(ps);
        const stored = Number(localStorage.getItem("pmo360_project"));
        const pick =
          (stored && ps.find((p) => p.id === stored)) || ps[0] || null;
        if (pick) _setSelectedProjectId(pick.id);
        else _setSelectedProjectId(null);
      })
      .catch(console.error);
  }, [selectedClientId]);

  const refreshClients = async () => {
    const cs = await api.listClients();
    setClients(cs);
  };
  const refreshProjects = async () => {
    if (!selectedClientId) return;
    const ps = await api.listProjects(selectedClientId);
    setProjects(ps);
  };

  const resetDraft = () => {
    setDraftMeetingId(null);
    setParsed(null);
    setRawNotes({ minutes: "", agenda: "", actions: "" });
    setMeetingTitle("");
    setMeetingDate(new Date().toISOString().slice(0, 10));
    setSelectedAttendees([]);
    setSelectedDeliverables([]);
  };

  const currentClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId) || null,
    [clients, selectedClientId]
  );
  const currentProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  // expose nav for components if needed via context — keeps useNavigate use
  // contained.
  useEffect(() => {
    // no-op; just touch the location so child re-render on route change.
    void location;
  }, [location]);

  const value: AppState = {
    clients,
    projects,
    settings,
    selectedClientId,
    selectedProjectId,
    setSelectedClientId,
    setSelectedProjectId,
    draftMeetingId,
    setDraftMeetingId,
    parsed,
    setParsed,
    rawNotes,
    setRawNotes,
    meetingTitle,
    setMeetingTitle,
    meetingDate,
    setMeetingDate,
    selectedAttendees,
    setSelectedAttendees,
    selectedDeliverables,
    setSelectedDeliverables,
    refreshClients,
    refreshProjects,
    currentClient,
    currentProject,
    resetDraft,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

export function useNav() {
  return useNavigate();
}
