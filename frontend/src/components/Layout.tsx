import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";
import { useEffect, useState, useRef } from "react";
import clsx from "clsx";
import NewClientDialog from "@/components/admin/NewClientDialog";
import NewPortfolioDialog from "@/components/admin/NewPortfolioDialog";
import DeletePortfolioDialog from "@/components/admin/DeletePortfolioDialog";
import ManageTeamDialog from "@/components/admin/ManageTeamDialog";
import { listProjectMembers } from "@/lib/api";
import type { ProjectMember } from "@/lib/types";
import CommandPalette from "./CommandPalette";

interface NavItem {
  to: string;
  label: string;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/", label: "Home" },
  { to: "/portfolio", label: "📊 Dashboard" },
  { to: "/capture", label: "Capture" },
  { to: "/next-agenda", label: "Next Agenda" },
  { to: "/actions", label: "Actions" },
  { to: "/notes", label: "Notes" },
  { to: "/history", label: "History" },
  { to: "/schedule", label: "Schedule" },
  { to: "/timeline", label: "📆 Timeline" },
];

// Admin/lead-only — appended to the nav when the signed-in user is an admin.
const LEAD_NAV: NavItem = { to: "/lead", label: "👑 Lead" };

// The "this meeting" minutes flow — Capture → Review → Preview → Send.
const MEETING_FLOW: NavItem[] = [
  { to: "/capture", label: "Capture" },
  { to: "/review", label: "Review" },
  { to: "/preview", label: "Preview" },
  { to: "/send", label: "Send" },
];

// The pre-meeting agenda is the START of the NEXT weekly cycle. It hangs
// off the end of the minutes stepper as a visually-distinct "plan ahead"
// segment so PMs see the full loop: capture this week's minutes → plan
// next week's agenda → (next week) capture again.
const NEXT_CYCLE_STEP: NavItem = { to: "/next-agenda", label: "Next agenda" };
const STEPPER_PATHS = [...MEETING_FLOW.map((s) => s.to), NEXT_CYCLE_STEP.to];

export default function Layout() {
  const { settings, currentProject } = useApp();
  const location = useLocation();

  // ----- Admin dialog state (gear popover -> create/delete/team) -----
  // Lifted here so the modal portals are mounted once at the top of the tree
  // and remain available even when ContextBar re-renders.
  const [showNewClient, setShowNewClient] = useState(false);
  const [showNewPortfolio, setShowNewPortfolio] = useState(false);
  const [showDeletePortfolio, setShowDeletePortfolio] = useState(false);
  const [showManageTeam, setShowManageTeam] = useState(false);

  useEffect(() => {
    if (settings)
      document.title = `${settings.app.title} — ${settings.app.tool_name}`;
  }, [settings]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <TopNav />
      <ContextBar
        onNewClient={() => setShowNewClient(true)}
        onNewPortfolio={() => setShowNewPortfolio(true)}
        onDeletePortfolio={() => setShowDeletePortfolio(true)}
        onManageTeam={() => setShowManageTeam(true)}
      />
      <MeetingStepper currentPath={location.pathname} />
      <main className="flex-1 px-6 md:px-10 py-8 max-w-screen-2xl w-full mx-auto">
        <Outlet />
      </main>
      <Footer />

      <NewClientDialog
        open={showNewClient}
        onClose={() => setShowNewClient(false)}
      />
      <NewPortfolioDialog
        open={showNewPortfolio}
        onClose={() => setShowNewPortfolio(false)}
      />
      <DeletePortfolioDialog
        open={showDeletePortfolio}
        onClose={() => setShowDeletePortfolio(false)}
      />
      <ManageTeamDialog
        open={showManageTeam}
        onClose={() => setShowManageTeam(false)}
        project={currentProject}
      />

      <CommandPalette />
    </div>
  );
}

function TopNav() {
  const location = useLocation();
  const { me } = useApp();
  const navItems = me?.is_admin ? [...PRIMARY_NAV, LEAD_NAV] : PRIMARY_NAV;
  return (
    <header className="sticky top-0 z-40 bg-white/90 backdrop-blur border-b border-slate-200">
      <div className="max-w-screen-2xl mx-auto px-6 md:px-10 h-16 flex items-center gap-6">
        <NavLink to="/" className="shrink-0" aria-label="PMO 360 home">
          <img
            src="/assets/logo/pmo360_logo.png"
            alt="PMO 360"
            className="h-8"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        </NavLink>

        <nav className="hidden md:flex items-center gap-1">
          {navItems.map((item) => {
            const active =
              location.pathname === item.to ||
              (item.to === "/capture" &&
                ["/capture", "/review", "/preview", "/send"].includes(
                  location.pathname
                ));
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={clsx(
                  "px-3.5 py-1.5 rounded-full text-sm font-medium transition",
                  active
                    ? "bg-brand-red text-white shadow-sm"
                    : "text-slate-700 hover:text-slate-900 hover:bg-slate-100"
                )}
              >
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="flex-1" />

        <CommandSearch />
        <ScopeToggle />
        <UserMenu />
      </div>

      <MobileNav />
    </header>
  );
}

/**
 * Segmented "My portfolios / All portfolios" toggle.
 *
 * Hidden when the user isn't signed in (the choice has no meaning since
 * the membership table is keyed on User rows). Always visible when
 * signed-in — including for admins. For admins the toggle still
 * affects dashboard scope (e.g. "show me my own to-dos vs. everyone's"),
 * but never affects the underlying project visibility because the
 * backend's membership filter is bypassed for them.
 */
function ScopeToggle() {
  const { scope, setScope, me } = useApp();
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return null;
  return (
    <div
      role="group"
      aria-label="Dashboard scope"
      title={
        me?.is_admin
          ? "Admins see all portfolios regardless — this toggle controls dashboard scope only"
          : "Filter to portfolios you're a member of"
      }
      className="hidden sm:inline-flex items-center rounded-full border border-slate-200 bg-slate-50 p-0.5 text-xs font-semibold"
    >
      <button
        type="button"
        onClick={() => setScope("mine")}
        aria-pressed={scope === "mine"}
        className={clsx(
          "px-3 py-1 rounded-full transition",
          scope === "mine"
            ? "bg-white text-brand-red shadow-sm"
            : "text-slate-500 hover:text-slate-900",
        )}
      >
        My portfolios
      </button>
      <button
        type="button"
        onClick={() => setScope("all")}
        aria-pressed={scope === "all"}
        className={clsx(
          "px-3 py-1 rounded-full transition",
          scope === "all"
            ? "bg-white text-brand-red shadow-sm"
            : "text-slate-500 hover:text-slate-900",
        )}
      >
        All portfolios
      </button>
    </div>
  );
}

function MobileNav() {
  const location = useLocation();
  const { me } = useApp();
  const navItems = me?.is_admin ? [...PRIMARY_NAV, LEAD_NAV] : PRIMARY_NAV;
  return (
    <nav className="md:hidden border-t border-slate-200 overflow-x-auto">
      <div className="flex items-center gap-1 px-3 py-2">
        {PRIMARY_NAV.map((item) => {
          const active = location.pathname === item.to;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={clsx(
                "px-3 py-1.5 text-xs font-semibold rounded-full whitespace-nowrap",
                active ? "bg-brand-red text-white" : "text-slate-600"
              )}
            >
              {item.label}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

interface ContextBarProps {
  onNewClient: () => void;
  onNewPortfolio: () => void;
  onDeletePortfolio: () => void;
  onManageTeam: () => void;
}

function ContextBar({
  onNewClient,
  onNewPortfolio,
  onDeletePortfolio,
  onManageTeam,
}: ContextBarProps) {
  const { clients, projects, selectedClientId, selectedProjectId } = useApp();
  const client = clients.find((c) => c.id === selectedClientId);
  const project = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="bg-white border-b border-slate-200">
      <div className="max-w-screen-2xl mx-auto px-6 md:px-10 py-3 flex items-center gap-2">
        <ContextSwitcher />
        <ContextAdminGear
          hasProject={!!project}
          onNewClient={onNewClient}
          onNewPortfolio={onNewPortfolio}
          onDeletePortfolio={onDeletePortfolio}
          onManageTeam={onManageTeam}
        />
        <div className="flex-1" />
        {project?.schedule_version && (
          <span className="hidden md:inline-flex items-center text-xs font-semibold text-slate-500">
            Schedule&nbsp;
            <span className="text-slate-900">{project.schedule_version}</span>
          </span>
        )}
        {project?.scope && (
          <span className="hidden lg:inline-flex items-center text-xs text-slate-500 max-w-md truncate">
            {project.scope}
          </span>
        )}
        {client && (
          <img
            src="/assets/logo/Castillo_logo_color.png"
            alt="Castillo"
            className="h-6 hidden md:block"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Small gear-icon popover next to the ContextSwitcher.
 *
 * Three actions:
 *   - + New client
 *   - + New portfolio
 *   - Delete portfolio (destructive, requires a portfolio to be selected)
 *
 * Uses the same click-outside dismiss pattern as ContextSwitcher above.
 */
function ContextAdminGear({
  hasProject,
  onNewClient,
  onNewPortfolio,
  onDeletePortfolio,
  onManageTeam,
}: {
  hasProject: boolean;
  onNewClient: () => void;
  onNewPortfolio: () => void;
  onDeletePortfolio: () => void;
  onManageTeam: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", click);
    return () => document.removeEventListener("mousedown", click);
  }, []);

  function fire(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Manage clients and portfolios"
        title="Manage clients and portfolios"
        className={clsx(
          "h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 transition",
          open && "border-slate-300 text-slate-900 bg-slate-50"
        )}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8.34 1.804A1 1 0 019.32 1h1.36a1 1 0 01.98.804l.247 1.232a7.011 7.011 0 011.255.726l1.18-.418a1 1 0 011.21.443l.68 1.178a1 1 0 01-.222 1.268l-.962.838a7.04 7.04 0 010 1.458l.962.838a1 1 0 01.222 1.268l-.68 1.178a1 1 0 01-1.21.443l-1.18-.418a7.014 7.014 0 01-1.255.727l-.247 1.232a1 1 0 01-.98.803H9.32a1 1 0 01-.98-.803l-.247-1.232a7.022 7.022 0 01-1.255-.727l-1.18.418a1 1 0 01-1.21-.443l-.68-1.178a1 1 0 01.222-1.268l.962-.838a7.04 7.04 0 010-1.458l-.962-.838a1 1 0 01-.222-1.268l.68-1.178a1 1 0 011.21-.443l1.18.418a7.011 7.011 0 011.255-.726l.247-1.232zM10 13a3 3 0 100-6 3 3 0 000 6z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg z-50 py-1.5">
          <button
            type="button"
            onClick={() => fire(onNewClient)}
            className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
          >
            <span className="text-slate-400">+</span> New client
          </button>
          <button
            type="button"
            onClick={() => fire(onNewPortfolio)}
            className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
          >
            <span className="text-slate-400">+</span> New portfolio
          </button>
          <div className="my-1 border-t border-slate-100" />
          <button
            type="button"
            onClick={() => hasProject && fire(onManageTeam)}
            disabled={!hasProject}
            className={clsx(
              "w-full text-left px-3 py-2 text-sm flex items-center gap-2",
              hasProject
                ? "text-slate-700 hover:bg-slate-50"
                : "text-slate-400 cursor-not-allowed",
            )}
            title={
              hasProject
                ? "Add or remove PMs on this portfolio"
                : "Pick a portfolio first to manage its team"
            }
          >
            <span aria-hidden="true">👥</span> Manage team
          </button>
          <div className="my-1 border-t border-slate-100" />
          <button
            type="button"
            onClick={() => hasProject && fire(onDeletePortfolio)}
            disabled={!hasProject}
            className={clsx(
              "w-full text-left px-3 py-2 text-sm flex items-center gap-2",
              hasProject
                ? "text-rose-600 hover:bg-rose-50"
                : "text-slate-400 cursor-not-allowed"
            )}
            title={
              hasProject
                ? undefined
                : "Pick a portfolio first to delete it"
            }
          >
            <span aria-hidden="true">🗑️</span> Delete portfolio
          </button>
        </div>
      )}
    </div>
  );
}

function ContextSwitcher() {
  const {
    clients,
    projects,
    selectedClientId,
    setSelectedClientId,
    selectedProjectId,
    setSelectedProjectId,
  } = useApp();

  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", click);
    return () => document.removeEventListener("mousedown", click);
  }, []);

  const client = clients.find((c) => c.id === selectedClientId);
  const project = projects.find((p) => p.id === selectedProjectId);

  // Members of the active portfolio — fetched only for the selected one
  // (avoids N+1 hits against the dropdown). Cleared whenever the
  // selection changes so the chip never shows stale names.
  const [members, setMembers] = useState<ProjectMember[]>([]);
  useEffect(() => {
    if (!selectedProjectId) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    listProjectMembers(selectedProjectId)
      .then((rows) => {
        if (!cancelled) setMembers(rows);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  const memberFirstNames = members
    .map((m) => firstNameOf(m.user?.name || m.user?.email || ""))
    .filter((s) => s.length > 0);
  // Cap the inline list at three names; the popover/Manage Team modal
  // is the place for the full roster. "+N more" handles the overflow.
  const shownNames = memberFirstNames.slice(0, 3);
  const moreCount = Math.max(0, memberFirstNames.length - shownNames.length);

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex flex-col items-start gap-0.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:border-slate-300 transition text-sm"
      >
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-brand-red" />
          <span className="font-medium text-slate-900">
            {project?.name || "No portfolio"}
          </span>
          <span className="text-slate-400">/</span>
          <span className="text-slate-600">{client?.name || "No client"}</span>
          <svg
            className={clsx(
              "h-4 w-4 text-slate-400 transition",
              open && "rotate-180",
            )}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.24 4.5a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        {project && shownNames.length > 0 && (
          <div
            className="text-[11px] text-slate-500 leading-none mt-0.5 max-w-[28rem] truncate"
            title={memberFirstNames.join(", ")}
          >
            <span aria-hidden="true">👤</span> {shownNames.join(", ")}
            {moreCount > 0 && (
              <span className="text-slate-400"> · +{moreCount} more</span>
            )}
          </div>
        )}
      </button>

      {open && (
        <div className="absolute left-0 mt-2 w-80 bg-white border border-slate-200 rounded-xl shadow-lg z-50 p-3 space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Client
            </div>
            <select
              className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-red/30"
              value={selectedClientId || ""}
              onChange={(e) =>
                setSelectedClientId(
                  e.target.value ? Number(e.target.value) : null
                )
              }
            >
              <option value="">— Pick a client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
              Portfolio
            </div>
            <select
              className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-red/30"
              value={selectedProjectId || ""}
              onChange={(e) =>
                setSelectedProjectId(
                  e.target.value ? Number(e.target.value) : null
                )
              }
              disabled={!projects.length}
            >
              <option value="">— Pick a portfolio —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

function CommandSearch() {
  // The chip is a thin shortcut to the Cmd+K palette; clicking it triggers
  // the same imperative open that the global keydown listener uses.
  const openPalette = () => {
    const fn = (window as any).__pmo360OpenPalette as
      | (() => void)
      | undefined;
    fn?.();
  };
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label="Open search palette"
      title="Search (⌘K)"
      className="hidden md:flex items-center gap-2 text-xs text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-md border border-slate-200 bg-slate-50 hover:border-slate-300 transition"
    >
      <span>Search</span>
      <kbd className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[10px] font-mono">
        ⌘K
      </kbd>
    </button>
  );
}

function UserMenu() {
  const { settings } = useApp();
  const { user, isAuthenticated, signIn, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Click-outside close
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Two-letter avatar from the signed-in name; falls back to "CE" when
  // anonymous so the header doesn't look broken before the user clicks in.
  const initials = (() => {
    if (!user?.name) return "CE";
    const parts = user.name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  })();

  if (!isAuthenticated) {
    return (
      <div className="flex items-center gap-2">
        {settings?.app.local_dev_mode && (
          <span className="hidden lg:inline rounded-full bg-amber-100 text-amber-700 text-[11px] font-medium px-2 py-0.5">
            Local dev
          </span>
        )}
        <button
          type="button"
          onClick={() => void signIn()}
          className="btn-ghost h-9 text-sm"
        >
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-2" ref={wrapRef}>
      {settings?.app.local_dev_mode && (
        <span className="hidden lg:inline rounded-full bg-amber-100 text-amber-700 text-[11px] font-medium px-2 py-0.5">
          Local dev
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-9 w-9 rounded-full bg-brand-red text-white flex items-center justify-center font-semibold text-sm hover:bg-brand-darkred"
        title={user?.name || user?.email || "Signed in"}
        aria-label="Open user menu"
      >
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-50 w-64 card p-3 shadow-xl">
          <div className="text-sm font-semibold text-slate-900 truncate">
            {user?.name || "Signed in"}
          </div>
          {user?.email && (
            <div className="text-xs text-slate-500 truncate mb-2">
              {user.email}
            </div>
          )}
          <button
            type="button"
            className="w-full text-left px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50 rounded-md flex items-center gap-2"
            onClick={() => {
              setOpen(false);
              navigate("/settings");
            }}
          >
            <span aria-hidden="true">⚙</span> Settings
          </button>
          <button
            type="button"
            className="btn-ghost w-full text-sm mt-1"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function MeetingStepper({ currentPath }: { currentPath: string }) {
  const nav = useNavigate();
  if (!STEPPER_PATHS.includes(currentPath)) return null;

  // Index across all 5 stepper paths (0-3 minutes, 4 = next agenda).
  const idx = STEPPER_PATHS.indexOf(currentPath);
  const onNextCycle = idx === 4;

  // When the PM is on /next-agenda we treat the four minutes steps as
  // neutral (not green-done) — they may have jumped straight here from the
  // top nav without doing minutes, so claiming those are "done" would lie.
  // Only show green ticks for genuinely-completed earlier steps within the
  // minutes flow itself.
  return (
    <div className="bg-gradient-to-b from-white to-slate-50 border-b border-slate-200">
      <div className="max-w-screen-2xl mx-auto px-6 md:px-10 py-3">
        <div className="flex items-center gap-2 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold pr-1 shrink-0">
            This meeting
          </span>
          {MEETING_FLOW.map((s, i) => {
            const isDone = !onNextCycle && i < idx;
            const isActive = !onNextCycle && i === idx;
            return (
              <div key={s.to} className="flex items-center">
                <button
                  onClick={() => nav(s.to)}
                  className={clsx(
                    "flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold transition whitespace-nowrap",
                    isActive && "bg-brand-red text-white shadow-sm",
                    isDone &&
                      "bg-emerald-50 text-emerald-700 border border-emerald-200",
                    !isActive &&
                      !isDone &&
                      "text-slate-500 hover:text-slate-700",
                  )}
                >
                  <span
                    className={clsx(
                      "h-5 w-5 rounded-full flex items-center justify-center text-[10px]",
                      isActive && "bg-white/20",
                      isDone && "bg-emerald-100 text-emerald-700",
                      !isActive && !isDone && "bg-slate-100 text-slate-500",
                    )}
                  >
                    {isDone ? "✓" : i + 1}
                  </span>
                  {s.label}
                </button>
                {i < MEETING_FLOW.length - 1 && (
                  <div className="mx-1.5 h-px w-5 bg-slate-200" />
                )}
              </div>
            );
          })}

          {/* Cycle divider → the next weekly cycle starts here. */}
          <div className="flex items-center gap-2 pl-1 shrink-0">
            <span className="text-slate-300 text-sm">→</span>
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold shrink-0">
              Plan ahead
            </span>
          </div>
          <button
            onClick={() => nav(NEXT_CYCLE_STEP.to)}
            className={clsx(
              "flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold transition whitespace-nowrap",
              onNextCycle
                ? "bg-brand-red text-white shadow-sm"
                : "text-[#185fa5] bg-sky-50 border border-sky-200 hover:bg-sky-100",
            )}
            title="Plan the next coordination meeting's agenda"
          >
            <span aria-hidden="true">📅</span>
            {NEXT_CYCLE_STEP.label}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pull the first whitespace-delimited token out of a name string for the
 *  inline member chip ("👤 Arun, Cheyne"). Falls back to the email's
 *  local-part when the user has no display name yet. */
function firstNameOf(value: string): string {
  const v = (value || "").trim();
  if (!v) return "";
  // If it looks like an email, take the local-part before any '.'
  if (v.includes("@")) {
    const local = v.split("@")[0];
    return local.split(/[._]/)[0].replace(/^\w/, (c) => c.toUpperCase());
  }
  return v.split(/\s+/)[0];
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white py-4 mt-auto">
      <div className="max-w-screen-2xl mx-auto px-6 md:px-10 text-xs text-slate-500 flex justify-between">
        <span>Castillo Engineering · Project Management Office</span>
        <span className="hidden md:inline">© {new Date().getFullYear()}</span>
      </div>
    </footer>
  );
}
