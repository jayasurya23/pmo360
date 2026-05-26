import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import * as api from "./api";
import type { Client, Project, Settings, ParsedMeeting } from "./types";
import { findBySlug, nameToSlug } from "./slugs";

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
  // `useSearchParams` gives us a reactive view of the URL search params.
  // We mirror `selectedClientId` / `selectedProjectId` into `?client` and
  // `?portfolio` so links like
  //   /actions?client=testco-renewables&portfolio=full-coverage-sample
  // open straight to the right context.
  const [searchParams, setSearchParams] = useSearchParams();

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

  // ============================================================
  // URL <-> selection sync
  // ============================================================
  // Strategy:
  //  - On mount (and whenever `clients` list arrives) read `?client=` to
  //    seed the selection. Fall back to localStorage, then first client.
  //  - On `projects` list arrival, do the same for `?portfolio=`.
  //  - When the user manually picks via the setter, write the slug back to
  //    the URL. We use a ref to avoid an infinite write-read-write loop.
  const urlSyncDirection = useRef<"reading" | "writing" | null>(null);

  const setSelectedClientId = (id: number | null) => {
    // Idempotent path: caller picked the client that's already active (e.g.
    // clicked it from the Cmd+K palette). Just normalize the URL — DO NOT
    // clear projects/selectedProjectId or otherwise nuke state, because the
    // projects-load effect won't re-fire (selectedClientId didn't change)
    // and we'd be left with an empty portfolio dropdown.
    if (id === selectedClientId) {
      urlSyncDirection.current = "writing";
      setSearchParams(
        (sp) => {
          const next = new URLSearchParams(sp);
          const client = clients.find((c) => c.id === id);
          if (client) next.set("client", nameToSlug(client.name));
          else next.delete("client");
          return next;
        },
        { replace: true },
      );
      return;
    }

    _setSelectedClientId(id);
    // Clear stale project when client changes
    _setSelectedProjectId(null);
    setProjects([]);
    if (id) localStorage.setItem("pmo360_client", String(id));

    // Mirror to URL
    urlSyncDirection.current = "writing";
    setSearchParams(
      (sp) => {
        const next = new URLSearchParams(sp);
        const client = clients.find((c) => c.id === id);
        if (client) next.set("client", nameToSlug(client.name));
        else next.delete("client");
        // dropping portfolio too — selection no longer applies to old client
        next.delete("portfolio");
        return next;
      },
      { replace: true },
    );
  };

  const setSelectedProjectId = (id: number | null) => {
    _setSelectedProjectId(id);
    if (id) localStorage.setItem("pmo360_project", String(id));

    urlSyncDirection.current = "writing";
    setSearchParams(
      (sp) => {
        const next = new URLSearchParams(sp);
        const proj = projects.find((p) => p.id === id);
        if (proj) next.set("portfolio", nameToSlug(proj.name));
        else next.delete("portfolio");
        return next;
      },
      { replace: true },
    );
  };

  // ---- Initial load: clients + settings ----
  useEffect(() => {
    api
      .listClients()
      .then((cs) => {
        setClients(cs);
        // Resolution priority: URL > localStorage > first client.
        const urlSlug = searchParams.get("client");
        let pick: Client | null = findBySlug(cs, urlSlug);
        if (!pick) {
          const stored = Number(localStorage.getItem("pmo360_client"));
          pick = (stored && cs.find((c) => c.id === stored)) || cs[0] || null;
        }
        if (pick) _setSelectedClientId(pick.id);
      })
      .catch(console.error);

    api.fetchSettings().then(setSettings).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Same resolution priority as clients.
        const urlSlug = searchParams.get("portfolio");
        let pick: Project | null = findBySlug(ps, urlSlug);
        if (!pick) {
          const stored = Number(localStorage.getItem("pmo360_project"));
          pick = (stored && ps.find((p) => p.id === stored)) || ps[0] || null;
        }
        if (pick) _setSelectedProjectId(pick.id);
        else _setSelectedProjectId(null);
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId]);

  // ---- React to URL changes that came from elsewhere (e.g. browser back
  //      button, manual edit, a link click). We re-resolve selection from
  //      the new ?client / ?portfolio. If `urlSyncDirection` is "writing"
  //      we just wrote them ourselves, so skip.
  useEffect(() => {
    if (urlSyncDirection.current === "writing") {
      urlSyncDirection.current = null;
      return;
    }
    if (!clients.length) return;
    const clientSlug = searchParams.get("client");
    if (clientSlug) {
      const c = findBySlug(clients, clientSlug);
      if (c && c.id !== selectedClientId) {
        _setSelectedClientId(c.id);
      }
    }
    // portfolio resolution happens in the projects-load effect once the
    // new projects[] arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, clients]);

  useEffect(() => {
    if (urlSyncDirection.current === "writing") {
      urlSyncDirection.current = null;
      return;
    }
    if (!projects.length) return;
    const portfolioSlug = searchParams.get("portfolio");
    if (portfolioSlug) {
      const p = findBySlug(projects, portfolioSlug);
      if (p && p.id !== selectedProjectId) {
        _setSelectedProjectId(p.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, projects]);

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
