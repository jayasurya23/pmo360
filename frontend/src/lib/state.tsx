import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import * as api from "./api";
import type {
  Client,
  Project,
  Settings,
  ParsedMeeting,
  MeResponse,
} from "./types";
import { findBySlug, nameToSlug } from "./slugs";

/** Persistence key for the dashboard/portfolio scope toggle. */
const SCOPE_LS_KEY = "pmo360_scope";

/** "mine" = membership-filtered (when signed-in + non-admin);
 *  "all"  = everything. Admins and anonymous users always see everything
 *  regardless of this flag — the toggle is a dashboard-scoping
 *  preference, not an access-control rule. */
export type Scope = "mine" | "all";

interface AppState {
  // ---- reference data ----
  clients: Client[];
  projects: Project[];
  settings: Settings | null;
  /** DB-backed signed-in user, or null when anonymous / /api/me 401d. */
  me: MeResponse | null;
  /** Refresh `me` from /api/me — call after a Bearer is attached so the
   *  admin flag flips correctly on first sign-in. */
  refreshMe: () => Promise<void>;
  // ---- selection ----
  selectedClientId: number | null;
  selectedProjectId: number | null;
  /** The "Project" level (a free-text tag from the portfolio's
   *  sub_projects_json). Third tier of the Client → Portfolio → Project
   *  picker; null = "All projects". */
  selectedSubProject: string | null;
  setSelectedClientId: (id: number | null) => void;
  setSelectedProjectId: (id: number | null) => void;
  setSelectedSubProject: (name: string | null) => void;
  // ---- scope (My / All toggle) ----
  scope: Scope;
  setScope: (s: Scope) => void;
  // ---- draft meeting wizard state ----
  draftMeetingId: number | null;
  setDraftMeetingId: (id: number | null) => void;
  parsed: ParsedMeeting | null;
  setParsed: (p: ParsedMeeting | null) => void;
  rawNotes: { minutes: string; agenda: string; actions: string };
  // Declared as the raw `useState` setters (which is what they already are at
  // runtime) rather than the narrower `(next) => void`, so callers can use the
  // functional form. That is what lets an inline editor's commit handler be
  // built once with useCallback([]) instead of closing over the current value —
  // see components/DraftField.tsx.
  setRawNotes: Dispatch<
    SetStateAction<{ minutes: string; agenda: string; actions: string }>
  >;
  meetingTitle: string;
  setMeetingTitle: Dispatch<SetStateAction<string>>;
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
  setSelectedDeliverables: Dispatch<
    SetStateAction<
      {
        project_segment: string;
        task: string;
        start_status: string;
        delivery_date: string | null;
      }[]
    >
  >;
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
  const [me, setMe] = useState<MeResponse | null>(null);
  const [selectedClientId, _setSelectedClientId] = useState<number | null>(null);
  const [selectedProjectId, _setSelectedProjectId] = useState<number | null>(null);
  const [selectedSubProject, _setSelectedSubProject] = useState<string | null>(
    null,
  );

  // ----- Scope toggle (My portfolios / All portfolios) -----
  // Read the persisted choice on mount. Default depends on identity —
  // admins land on "all" (their typical workflow), everyone else on "mine".
  // We can't know admin status until /api/me resolves, so we start with
  // the stored value (or "mine" as the safe default) and let the post-me
  // effect promote anonymous/admin users to "all" only if no explicit
  // user choice is stored yet.
  const [scope, _setScope] = useState<Scope>(() => {
    const stored = localStorage.getItem(SCOPE_LS_KEY);
    if (stored === "mine" || stored === "all") return stored;
    return "mine";
  });
  const setScope = useCallback((s: Scope) => {
    _setScope(s);
    localStorage.setItem(SCOPE_LS_KEY, s);
  }, []);

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
    // Clear stale portfolio + project when client changes
    _setSelectedProjectId(null);
    _setSelectedSubProject(null);
    localStorage.removeItem("pmo360_subproject");
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
        // dropping portfolio + project too — selection no longer applies
        next.delete("portfolio");
        next.delete("project");
        return next;
      },
      { replace: true },
    );
  };

  const setSelectedProjectId = (id: number | null) => {
    _setSelectedProjectId(id);
    // Switching portfolio resets the Project tier (and its stored value, so a
    // tag name doesn't bleed across portfolios); the resolver effect below
    // re-picks from the URL against the new portfolio's list.
    _setSelectedSubProject(null);
    localStorage.removeItem("pmo360_subproject");
    if (id) localStorage.setItem("pmo360_project", String(id));

    urlSyncDirection.current = "writing";
    setSearchParams(
      (sp) => {
        const next = new URLSearchParams(sp);
        const proj = projects.find((p) => p.id === id);
        if (proj) next.set("portfolio", nameToSlug(proj.name));
        else next.delete("portfolio");
        next.delete("project");
        return next;
      },
      { replace: true },
    );
  };

  // The Project tier is a free-text tag, scoped to the selected portfolio.
  // We persist it in `?project=<slug>` + localStorage, mirroring client /
  // portfolio. No urlSyncDirection dance needed: the resolver effect below
  // re-reads the same value we just wrote (idempotent), and the client /
  // portfolio resolvers ignore the `project` param.
  const setSelectedSubProject = (name: string | null) => {
    _setSelectedSubProject(name);
    if (name) localStorage.setItem("pmo360_subproject", name);
    else localStorage.removeItem("pmo360_subproject");
    setSearchParams(
      (sp) => {
        const next = new URLSearchParams(sp);
        if (name) next.set("project", nameToSlug(name));
        else next.delete("project");
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

  // ---- /api/me: resolve identity + admin flag once the Bearer is attached ----
  // We poll briefly on mount because the MSAL interceptor may not have a token
  // ready on the first try (silent acquire happens async). After 401 we treat
  // the user as anonymous and never retry — they'll get re-fetched on the
  // next manual `refreshMe()` call (e.g. after sign-in completes).
  const refreshMe = useCallback(async () => {
    try {
      const m = await api.fetchMe();
      setMe(m);
      // Bootstrap scope on first identity resolution. If the user has
      // never touched the toggle, admins land on "all" (their typical
      // workflow), everyone else stays on the "mine" default.
      if (!localStorage.getItem(SCOPE_LS_KEY)) {
        const initial: Scope = m.is_admin ? "all" : "mine";
        _setScope(initial);
        localStorage.setItem(SCOPE_LS_KEY, initial);
      }
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    // Try once now (covers the case where MSAL already has a cached token)
    // and again after 500ms (covers the cold-start race where the
    // interceptor's acquireTokenSilent is still pending).
    void refreshMe();
    const t = setTimeout(() => {
      if (me === null) void refreshMe();
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Projects load whenever client changes ----
  // The picker dropdown ALWAYS shows every portfolio under the chosen
  // client, regardless of the Mine/All scope toggle or membership. The
  // dropdown is for *navigation* — restricting it would hide portfolios
  // the PM is allowed to view (the backend already scopes data access at
  // the row level), and silently break navigation when a non-member picks
  // an unrelated client.
  //
  // The Mine/All scope toggle is honoured by the dashboard endpoints
  // (Home, briefing) which call fetchMyDashboard / fetchDashboard
  // explicitly — it doesn't need to filter the picker too.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // "All clients" (no client selected) -> load every portfolio so the
        // portfolio dropdown still works and the dashboard can aggregate
        // across clients. A stale transient null on first render is harmless:
        // the `cancelled` guard drops its result once a client resolves.
        const ps = selectedClientId
          ? await api.listProjects(selectedClientId, false)
          : await api.listAllPortfolios(false);
        if (cancelled) return;
        setProjects(ps);
        if (!selectedClientId) {
          // Stay on the aggregate ("All portfolios") view unless the URL pins
          // a specific portfolio — never auto-pick under "All clients".
          const pick = findBySlug(ps, searchParams.get("portfolio"));
          _setSelectedProjectId(pick ? pick.id : null);
          return;
        }
        // Same resolution priority as clients.
        const urlSlug = searchParams.get("portfolio");
        let pick: Project | null = findBySlug(ps, urlSlug);
        if (!pick) {
          const stored = Number(localStorage.getItem("pmo360_project"));
          pick = (stored && ps.find((p) => p.id === stored)) || ps[0] || null;
        }
        if (pick) _setSelectedProjectId(pick.id);
        else _setSelectedProjectId(null);
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      cancelled = true;
    };
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

  // ---- Resolve the Project tier against the selected portfolio's list ----
  // Runs whenever the portfolio (or its data / the URL) changes. Resolution
  // priority: ?project= slug > localStorage > none. A value that isn't in the
  // current portfolio's sub_projects_json resolves to null, so a stale tag
  // from another portfolio never sticks.
  useEffect(() => {
    const proj = projects.find((p) => p.id === selectedProjectId) || null;
    const list = proj?.sub_projects_json || [];
    let pick: string | null = null;
    const urlSlug = searchParams.get("project");
    if (urlSlug) pick = list.find((n) => nameToSlug(n) === urlSlug) || null;
    if (!pick) {
      const stored = localStorage.getItem("pmo360_subproject");
      if (stored)
        pick = list.find((n) => n.toLowerCase() === stored.toLowerCase()) || null;
    }
    _setSelectedSubProject(pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, projects, searchParams]);

  const refreshClients = async () => {
    const cs = await api.listClients();
    setClients(cs);
  };
  const refreshProjects = async () => {
    if (!selectedClientId) return;
    // Always unfiltered — picker is for navigation. The Mine/All scope
    // toggle is honoured by the dashboard endpoints, not by the picker.
    const ps = await api.listProjects(selectedClientId, false);
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
    me,
    refreshMe,
    selectedClientId,
    selectedProjectId,
    selectedSubProject,
    setSelectedClientId,
    setSelectedProjectId,
    setSelectedSubProject,
    scope,
    setScope,
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
