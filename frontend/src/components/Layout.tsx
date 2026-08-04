import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";
import { useEffect, useState, useRef, Suspense } from "react";
import clsx from "clsx";
import NewPortfolioDialog from "@/components/admin/NewPortfolioDialog";
import DeletePortfolioDialog from "@/components/admin/DeletePortfolioDialog";
import ManageTeamDialog from "@/components/admin/ManageTeamDialog";
import RenameDialog from "@/components/admin/RenameDialog";
import ProjectDialog, { type ProjectMode } from "@/components/admin/ProjectDialog";
import {
  listProjectMembers,
  listAllPortfolios,
  fetchMyPreferences,
  updateMyPreferences,
  fetchDashboard,
  fetchMyDashboard,
  fetchOpenRisks,
  type UserPreferences,
} from "@/lib/api";
import type {
  MeResponse,
  PermissionName,
  Project,
  ProjectMember,
} from "@/lib/types";
import CommandPalette from "./CommandPalette";

interface NavItem {
  to: string;
  label: string;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/", label: "Home" },
  { to: "/portfolio", label: "Dashboard" },
  { to: "/capture", label: "Minutes" },
  { to: "/next-agenda", label: "Pre-Meeting" },
  { to: "/actions", label: "Actions" },
  { to: "/notes", label: "Notes" },
  { to: "/history", label: "History" },
  // Schedule tab retired — the Proposals module covers project schedules. The
  // /schedule route stays mounted so old deep links still resolve.
  { to: "/timeline", label: "Timeline" },
  { to: "/proposals", label: "Proposals" },
  { to: "/change-orders", label: "Change Orders" },
];

// The Lead dashboard no longer has its own tab — the top-left PMO 360 logo links
// to it (see TopNav). Visible to every signed-in user (not admin-gated).
const LEAD_PATH = "/lead";

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
const NEXT_CYCLE_STEP: NavItem = { to: "/next-agenda", label: "Plan next agenda" };
const STEPPER_PATHS = [...MEETING_FLOW.map((s) => s.to), NEXT_CYCLE_STEP.to];

/** Every route that renders a document-shaped page (a single reading column)
 *  rather than a board. Settings is narrower still. */
const DOC_WIDTH_PATHS = [
  "/review",
  "/preview",
  "/send",
  "/history",
  "/notes",
  "/change-orders",
];

/** localStorage key for the light/dark preference. It drives the `dark` class
 *  on <html>, which re-themes the whole palette via the CSS variables in
 *  styles/index.css. Both the key and the class name are load-bearing: the
 *  inline script in index.html reads them before first paint to avoid a white
 *  flash, so renaming either here alone reintroduces that flash. */
const THEME_LS_KEY = "theme";

/** `pinned_project_ids` is on the backend UserPreferences schema but not yet
 *  on the shared api.ts interface — widen here rather than reshaping a type
 *  the Settings screen also writes. */
type PrefsWithPins = UserPreferences & { pinned_project_ids?: number[] };

export default function Layout() {
  const { settings, currentProject, me } = useApp();
  const location = useLocation();

  // ----- Admin dialog state (gear popover -> create/delete/team) -----
  // Lifted here so the modal portals are mounted once at the top of the tree
  // and remain available even when the header re-renders.
  //
  // Client create/rename is NOT here any more: it lives in Settings behind an
  // admin check, because the shell renders for every signed-in PM and a
  // client rename or delete reaches every portfolio beneath it.
  const [showNewPortfolio, setShowNewPortfolio] = useState(false);
  const [showDeletePortfolio, setShowDeletePortfolio] = useState(false);
  const [showManageTeam, setShowManageTeam] = useState(false);
  const [showEditPortfolio, setShowEditPortfolio] = useState(false);
  const [projectMode, setProjectMode] = useState<ProjectMode | null>(null);

  useEffect(() => {
    if (settings)
      document.title = `${settings.app.title} — ${settings.app.tool_name}`;
  }, [settings]);

  const contentWidth =
    location.pathname === "/settings"
      ? "max-w-narrow"
      : DOC_WIDTH_PATHS.includes(location.pathname)
        ? "max-w-doc"
        : "max-w-shell";

  // An offboarded user still holds a valid Entra token, so the auth gate lets
  // them through — /api/me is the one route that still answers them, and every
  // other call 403s. Without this they would get the whole shell with nothing
  // working and no explanation. Told plainly instead, with who to ask.
  if (me && me.is_active === false) {
    return (
      <div className="min-h-screen bg-surface-page text-brand-black flex items-center justify-center px-4">
        <div className="card p-8 max-w-md text-center space-y-2">
          <div className="text-2xl">🔒</div>
          <h1 className="text-lg font-semibold">Your access has been removed</h1>
          <p className="text-sm text-brand-gray">
            This {settings?.app.tool_name ?? "PMO 360"} account is no longer
            active. Your work is untouched — an administrator can restore access
            from Settings if this was a mistake.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-page text-brand-black flex flex-col">
      {/* Brand rule across the very top of the viewport. */}
      <div className="h-[3px] bg-brand-red" />
      <TopNav
        admin={{
          onNewPortfolio: () => setShowNewPortfolio(true),
          onDeletePortfolio: () => setShowDeletePortfolio(true),
          onManageTeam: () => setShowManageTeam(true),
          onRenamePortfolio: () => setShowEditPortfolio(true),
          onNewProject: () => setProjectMode("new"),
          onRenameProject: () => setProjectMode("rename"),
          onDeleteProject: () => setProjectMode("delete"),
        }}
      />
      <main className={clsx("flex-1 px-9 py-7 w-full mx-auto", contentWidth)}>
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-24 text-sm text-brand-gray">
              Loading…
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
      <Footer />

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
      <RenameDialog
        open={showEditPortfolio}
        onClose={() => setShowEditPortfolio(false)}
      />
      <ProjectDialog mode={projectMode} onClose={() => setProjectMode(null)} />

      <CommandPalette />
    </div>
  );
}

/** The header is a two-row block: the nav row (58px) and the context row
 *  below a hairline. Both are full-bleed with 36px side padding — only the
 *  page content is width-capped. */
function TopNav({ admin }: { admin: AdminActions }) {
  const location = useLocation();
  const headerRef = useRef<HTMLElement | null>(null);

  // Pages with their own sticky elements (the Proposals schedule toolbar and
  // its table head) need to park below this header. Publish the measured
  // height as `--app-header-h` rather than hardcoding it — the context row
  // grows a second line on narrow widths, and the meeting stepper swaps in on
  // the capture/review/preview/send routes.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty(
        "--app-header-h",
        `${el.getBoundingClientRect().height}px`,
      );
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [location.pathname]);

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-40 bg-surface-card border-b border-surface-border"
    >
      <div className="px-9 h-[58px] flex items-center gap-[26px]">
        <NavLink
          to={LEAD_PATH}
          className="shrink-0"
          aria-label="PMO 360 — Lead dashboard"
        >
          {/* "PMO" is solid black in the artwork and there is no white variant
              of this mark, so on the dark header it would simply vanish.
              brightness(0) flattens every opaque pixel to black and invert()
              lifts it to white — a flat white knockout, the same compromise
              the Castillo white wordmark already makes. */}
          <img
            src="/assets/logo/pmo360_logo.png"
            alt="PMO 360"
            className="h-[30px] block dark:brightness-0 dark:invert"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        </NavLink>

        {/* Tabs are stretched to the full header height so the active
            underline sits flush with the header's bottom border. */}
        <nav className="hidden md:flex items-stretch gap-5 h-[58px] text-sm">
          {PRIMARY_NAV.map((item) => {
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
                  "flex items-center whitespace-nowrap border-b-[2.5px] transition",
                  active
                    ? "text-brand-red font-semibold border-brand-red -mb-px"
                    : "text-brand-gray border-transparent hover:text-brand-black"
                )}
              >
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          <ScopeToggle />
          <CommandSearch />
          <NotificationsBell />
          <ThemeToggle />
          <UserMenu />
        </div>
      </div>

      <ContextRow admin={admin} />

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
      className="hidden lg:inline-flex rounded-lg border border-surface-border overflow-hidden text-[11px]"
    >
      {/* Abbreviated because the tab row eats the header's width — the group
          title and each button's aria-label carry the full wording. */}
      <ScopeButton
        label="Mine"
        fullLabel="My portfolios"
        active={scope === "mine"}
        onClick={() => setScope("mine")}
      />
      <ScopeButton
        label="All"
        fullLabel="All portfolios"
        active={scope === "all"}
        onClick={() => setScope("all")}
      />
    </div>
  );
}

function ScopeButton({
  label,
  fullLabel,
  active,
  onClick,
}: {
  label: string;
  fullLabel: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={fullLabel}
      className={clsx(
        "px-2.5 py-1.5 font-semibold transition",
        active
          ? "bg-brand-red text-white"
          : "bg-surface-card text-brand-gray hover:bg-surface-page"
      )}
    >
      {label}
    </button>
  );
}

function MobileNav() {
  const location = useLocation();
  return (
    <nav className="md:hidden border-t border-surface-hairline overflow-x-auto">
      <div className="flex items-center gap-1 px-3 py-2">
        {PRIMARY_NAV.map((item) => {
          const active = location.pathname === item.to;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={clsx(
                "inline-flex items-center justify-center text-center px-3 py-1.5 text-xs font-semibold rounded-full whitespace-nowrap",
                active ? "bg-brand-red text-white" : "text-brand-gray"
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

/** Openers for the admin dialogs, whose state lives on Layout. */
interface AdminActions {
  onNewPortfolio: () => void;
  onDeletePortfolio: () => void;
  onManageTeam: () => void;
  onRenamePortfolio: () => void;
  onNewProject: () => void;
  onRenameProject: () => void;
  onDeleteProject: () => void;
}

/** Second header row: the Client › Portfolio › Project context, plus whichever
 *  of the two secondary groups the current route calls for. */
function ContextRow({ admin }: { admin: AdminActions }) {
  const location = useLocation();
  const dark = useIsDark();
  const { clients, projects, selectedClientId, selectedProjectId, selectedSubProject } =
    useApp();
  const client = clients.find((c) => c.id === selectedClientId);
  const project = projects.find((p) => p.id === selectedProjectId);
  const onMeetingFlow = STEPPER_PATHS.includes(location.pathname);

  return (
    <div className="px-9 py-[9px] border-t border-surface-hairline flex items-center gap-2.5 flex-wrap">
      <span className="micro-label shrink-0">Context</span>
      <ContextSwitcher />
      <ContextAdminGear
        hasProject={!!project}
        hasSubProject={!!selectedSubProject}
        {...admin}
      />

      {/* The minutes stepper takes over the second half of the row while the
          PM is inside a meeting; pinned portfolios own it everywhere else. */}
      {onMeetingFlow ? (
        <MeetingStepper currentPath={location.pathname} />
      ) : (
        <PinnedPortfolios />
      )}

      <div className="flex-1" />

      {project?.schedule_version && (
        <span className="hidden md:inline-flex items-center text-xs text-brand-gray shrink-0">
          Schedule&nbsp;
          <b className="text-brand-black">{project.schedule_version}</b>
        </span>
      )}
      {project?.scope && (
        <span className="hidden 2xl:inline-flex items-center text-xs text-brand-gray max-w-md truncate">
          {project.scope}
        </span>
      )}
      {/* Castillo_logo.png is the brand's all-white knockout of the wordmark —
          the sanctioned asset for a dark surface, where the colour version's
          brown "Engineering" and tagline go muddy. Same folder and same mount
          as the colour file, so the onError fallback still covers both. */}
      {client && (
        <img
          src={
            dark
              ? "/assets/logo/Castillo_logo.png"
              : "/assets/logo/Castillo_logo_color.png"
          }
          alt="Castillo"
          className="h-[22px] hidden md:block shrink-0"
          onError={(e) => (e.currentTarget.style.display = "none")}
        />
      )}
    </div>
  );
}

/** 18px vertical hairline that separates groups inside the context row. */
function RowDivider() {
  return <span className="w-px h-[18px] bg-surface-border mx-1.5 shrink-0" aria-hidden="true" />;
}

/**
 * One permission as this user experiences it, read off /api/me.
 *
 * `permissions` is optional on MeResponse — an /api/me older than this client
 * omits it — so an absent map falls back to the admin flag rather than locking
 * an admin out of their own console. Everyone else lands on the closed side,
 * which is the safe direction for the destructive items below.
 */
function can(me: MeResponse | null, name: PermissionName): boolean {
  if (!me) return false;
  // The server already folds the admin bypass into `permissions`; keeping it
  // here too costs nothing and covers the older-payload case above.
  if (me.is_admin) return true;
  return !!me.permissions?.[name];
}

/**
 * Small gear-icon popover next to the ContextSwitcher.
 *
 * Scoped to the portfolio and project tiers — create, rename, delete, and
 * team. Client-level actions are gone from here: they live in Settings. The
 * one exception is the shortcut at the bottom, which only navigates, and only
 * renders for someone the console actually serves.
 *
 * Uses the same click-outside dismiss pattern as ContextSwitcher above.
 */
function ContextAdminGear({
  hasProject,
  hasSubProject,
  onNewPortfolio,
  onDeletePortfolio,
  onManageTeam,
  onRenamePortfolio,
  onNewProject,
  onRenameProject,
  onDeleteProject,
}: AdminActions & {
  hasProject: boolean;
  hasSubProject: boolean;
}) {
  const { me } = useApp();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Deleting a portfolio cascades into every meeting, agenda, schedule and
  // attendee beneath it — the same shape as deleting a client, which the server
  // gates on client_mgmt (api/clients.py::delete_client). Structure changes that
  // are additive and correctable — new portfolio, new project, rename — stay
  // open to any PM, matching the split that router already drew.
  //
  // Presentation, not protection: the matching server gate belongs on
  // api/projects.py::delete_project and api/portfolio_projects.py. This only
  // spares people a two-click path to a refusal.
  //
  // Disabled, not hidden: this menu already refuses items with a reason ("Pick
  // a portfolio first"), and a destructive control that silently vanishes tells
  // nobody what they are missing or who to ask for it.
  const canDeleteStructure = can(me, "client_mgmt");
  const structureBlocked = canDeleteStructure
    ? undefined
    : "Needs the Client Management permission — ask an administrator to grant it in Settings → Users.";

  // The console below now serves permission holders, not just admins, so the
  // shortcut to it has to widen with it or a client_mgmt holder never finds it.
  const canReachConsole = can(me, "user_mgmt") || can(me, "client_mgmt");

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
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Manage clients and portfolios"
        title="Manage clients and portfolios"
        className={clsx(
          "h-7 w-7 inline-flex items-center justify-center rounded-md border border-surface-border bg-surface-card text-brand-gray hover:border-brand-red hover:text-brand-red transition",
          open && "border-brand-red text-brand-red"
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
        <div className="absolute left-0 mt-2 w-56 bg-surface-card border border-surface-border rounded-[10px] shadow-lg z-50 py-1.5">
          <GearItem onClick={() => fire(onNewPortfolio)} icon="+">
            New portfolio
          </GearItem>
          <GearItem
            onClick={() => fire(onNewProject)}
            disabled={!hasProject}
            icon="+"
            title={
              hasProject
                ? "Add a project to the selected portfolio"
                : "Pick a portfolio first"
            }
          >
            New project
          </GearItem>
          <div className="my-1 border-t border-surface-hairline" />
          <GearItem
            onClick={() => fire(onRenamePortfolio)}
            disabled={!hasProject}
            icon="✏️"
            title={
              hasProject
                ? "Edit the portfolio name, scope + project details (location, state, size)"
                : "Pick a portfolio first"
            }
          >
            Edit portfolio details
          </GearItem>
          <GearItem
            onClick={() => fire(onRenameProject)}
            disabled={!hasSubProject}
            icon="✏️"
            title={
              hasSubProject
                ? "Rename the selected project"
                : "Pick a project first"
            }
          >
            Rename project
          </GearItem>
          <div className="my-1 border-t border-surface-hairline" />
          {/* Open to everyone, but the dialog is read-only unless you're an
              admin — assignment is user management and lives behind
              require_admin. The roster itself is not privileged. */}
          <GearItem
            onClick={() => fire(onManageTeam)}
            disabled={!hasProject}
            icon="👥"
            title={
              !hasProject
                ? "Pick a portfolio first to see its team"
                : me?.is_admin
                  ? "Add or remove PMs on this portfolio"
                  : "See who is assigned to this portfolio"
            }
          >
            {me?.is_admin ? "Manage team" : "View team"}
          </GearItem>
          <div className="my-1 border-t border-surface-hairline" />
          <GearItem
            onClick={() => fire(onDeletePortfolio)}
            disabled={!hasProject || !canDeleteStructure}
            icon="🗑️"
            danger
            title={
              structureBlocked ??
              (hasProject ? undefined : "Pick a portfolio first to delete it")
            }
          >
            Delete portfolio
          </GearItem>
          <GearItem
            onClick={() => fire(onDeleteProject)}
            disabled={!hasSubProject || !canDeleteStructure}
            icon="🗑️"
            danger
            title={
              structureBlocked ??
              (hasSubProject
                ? "Remove the selected project from this portfolio"
                : "Pick a project first to delete it")
            }
          >
            Delete project
          </GearItem>
          {canReachConsole && (
            <>
              <div className="my-1 border-t border-surface-hairline" />
              {/* Creating a client used to live in this menu, and a PM
                  reaching for "New portfolio" for a brand-new client still
                  needs somewhere to go. This only navigates — the console's
                  own cards decide what it shows you when you get there. */}
              <GearItem onClick={() => fire(() => nav("/settings"))} icon="⚙">
                Manage clients &amp; users
              </GearItem>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GearItem({
  onClick,
  disabled,
  danger,
  icon,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  icon: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      title={title}
      className={clsx(
        "w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition",
        disabled
          ? "text-brand-lightgray cursor-not-allowed"
          : danger
            ? "text-brand-brightred hover:bg-status-open-bg"
            : "text-brand-black hover:bg-surface-rowhover"
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(!disabled && !danger && "text-brand-lightgray")}
      >
        {icon}
      </span>{" "}
      {children}
    </button>
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
    selectedSubProject,
    setSelectedSubProject,
  } = useApp();

  const project = projects.find((p) => p.id === selectedProjectId);
  const subProjectList = project?.sub_projects_json || [];

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
    <div className="flex items-center gap-1.5 flex-wrap">
      <HeaderSelect
        ariaLabel="Client"
        value={selectedClientId ? String(selectedClientId) : ""}
        onChange={(v) => setSelectedClientId(v ? Number(v) : null)}
        placeholder="All clients"
        options={clients.map((c) => ({ value: c.id, label: c.name }))}
      />
      <Chevron />
      <HeaderSelect
        ariaLabel="Portfolio"
        value={selectedProjectId ? String(selectedProjectId) : ""}
        onChange={(v) => setSelectedProjectId(v ? Number(v) : null)}
        placeholder={projects.length ? "All portfolios" : "No portfolios"}
        disabled={!projects.length}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
      />
      <Chevron />
      <HeaderSelect
        ariaLabel="Project"
        value={selectedSubProject || ""}
        onChange={(v) => setSelectedSubProject(v || null)}
        placeholder={subProjectList.length ? "All projects" : "No projects"}
        disabled={!selectedProjectId || !subProjectList.length}
        options={subProjectList.map((s) => ({ value: s, label: s }))}
      />
      {project && shownNames.length > 0 && (
        <span
          className="hidden xl:inline-flex items-center text-[11px] text-brand-gray ml-1 max-w-[16rem] truncate"
          title={memberFirstNames.join(", ")}
        >
          <span aria-hidden="true" className="mr-1">
            👤
          </span>
          {shownNames.join(", ")}
          {moreCount > 0 && (
            <span className="text-brand-lightgray">&nbsp;· +{moreCount} more</span>
          )}
        </span>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <span className="text-brand-lightgray select-none" aria-hidden="true">
      ›
    </span>
  );
}

/** One inline header picker (Client / Portfolio / Project). Native <select>
 *  so it's keyboard-accessible and each opens its own menu — three of these
 *  side by side give the Client › Portfolio › Project breadcrumb. */
function HeaderSelect({
  ariaLabel,
  value,
  onChange,
  placeholder,
  options,
  disabled,
}: {
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: { value: string | number; label: string }[];
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={ariaLabel}
      title={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[12rem] truncate rounded-md border border-surface-border bg-surface-card px-2.5 py-[5px] text-[13px] text-brand-black hover:border-brand-lightgray focus:outline-none focus:border-brand-red disabled:bg-surface-mute disabled:text-brand-lightgray transition"
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Starred portfolios — a quick-jump row in the context header.
 *
 * The pin list is persisted per user in `UserPreferences.pinned_project_ids`
 * (already on the backend schema). Chips resolve their names from the
 * portfolios already loaded for the active client; anything pinned under a
 * *different* client needs the cross-client list, which we only fetch when
 * such a pin actually exists.
 */
function PinnedPortfolios() {
  const { isAuthenticated } = useAuth();
  const {
    projects,
    selectedClientId,
    selectedProjectId,
    setSelectedClientId,
    setSelectedProjectId,
  } = useApp();

  const [prefs, setPrefs] = useState<PrefsWithPins | null>(null);
  const [allPortfolios, setAllPortfolios] = useState<Project[]>([]);

  useEffect(() => {
    if (!isAuthenticated) {
      setPrefs(null);
      return;
    }
    let cancelled = false;
    fetchMyPreferences()
      .then((p) => {
        if (!cancelled) setPrefs(p as PrefsWithPins);
      })
      .catch(() => {
        if (!cancelled) setPrefs(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const pinnedIds = prefs?.pinned_project_ids ?? [];
  const needsCrossClientNames = pinnedIds.some(
    (id) => !projects.some((p) => p.id === id),
  );

  useEffect(() => {
    if (!needsCrossClientNames || allPortfolios.length) return;
    let cancelled = false;
    listAllPortfolios()
      .then((ps) => {
        if (!cancelled) setAllPortfolios(ps);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [needsCrossClientNames, allPortfolios.length]);

  const resolve = (id: number): Project | undefined =>
    projects.find((p) => p.id === id) || allPortfolios.find((p) => p.id === id);
  const chips = pinnedIds
    .map(resolve)
    .filter((p): p is Project => p !== undefined);

  async function savePins(next: number[]) {
    if (!prefs) return;
    const optimistic: PrefsWithPins = { ...prefs, pinned_project_ids: next };
    const previous = prefs;
    setPrefs(optimistic);
    try {
      setPrefs((await updateMyPreferences(optimistic)) as PrefsWithPins);
    } catch {
      setPrefs(previous);
    }
  }

  // Jumping to a pin uses the same two setters the Cmd+K palette does, so the
  // AppProvider URL/localStorage sync resolves the portfolio once the new
  // client's list lands.
  function jumpTo(p: Project) {
    if (p.client_id !== selectedClientId) setSelectedClientId(p.client_id);
    setSelectedProjectId(p.id);
  }

  if (!isAuthenticated || !prefs) return null;

  const currentIsPinned =
    selectedProjectId !== null && pinnedIds.includes(selectedProjectId);
  const currentName = projects.find((p) => p.id === selectedProjectId)?.name;
  const nextPins =
    selectedProjectId === null
      ? pinnedIds
      : currentIsPinned
        ? pinnedIds.filter((id) => id !== selectedProjectId)
        : [...pinnedIds, selectedProjectId];

  return (
    <>
      {selectedProjectId !== null && (
        <button
          type="button"
          aria-pressed={currentIsPinned}
          title={
            currentIsPinned
              ? `Unpin ${currentName ?? "this portfolio"}`
              : `Pin ${currentName ?? "this portfolio"} to the header`
          }
          onClick={() => void savePins(nextPins)}
          className={clsx(
            "h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-md border border-surface-border bg-surface-card text-sm leading-none transition hover:border-brand-red",
            currentIsPinned ? "text-brand-gold" : "text-brand-lightgray",
          )}
        >
          {currentIsPinned ? "★" : "☆"}
        </button>
      )}

      {chips.length > 0 && (
        <>
          <RowDivider />
          <span className="micro-label shrink-0">Pinned</span>
          {chips.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => jumpTo(p)}
              title={`Switch to ${p.name}`}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-[11px] py-1 rounded-full border border-surface-border bg-surface-card text-xs text-brand-black hover:border-brand-red hover:text-brand-red transition"
            >
              <span className="text-brand-gold" aria-hidden="true">
                ★
              </span>
              {p.name}
            </button>
          ))}
        </>
      )}
    </>
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
      className="hidden md:flex items-center gap-2.5 text-xs text-brand-gray px-3.5 py-[7px] rounded-md border border-surface-border bg-surface-page hover:border-brand-red hover:text-brand-red transition"
    >
      <span>Search</span>
      <kbd className="px-1.5 py-px bg-surface-card border border-surface-border rounded text-[10px]">
        ⌘K
      </kbd>
    </button>
  );
}

/** Shared shape for the two 34px icon buttons in the header cluster. */
const ICON_BUTTON =
  "h-[34px] w-[34px] shrink-0 inline-flex items-center justify-center rounded-lg border border-surface-border bg-surface-card text-brand-gray hover:border-brand-red hover:text-brand-red transition";

/**
 * Notifications bell.
 *
 * There's no notifications endpoint, so the count is rolled up client-side
 * from the two things a PM actually needs chasing: overdue open actions and
 * open risks. Both honour the Mine/All scope toggle the same way the Home
 * cards do.
 */
function NotificationsBell() {
  const { isAuthenticated } = useAuth();
  const { scope, me } = useApp();
  const nav = useNavigate();
  const [overdue, setOverdue] = useState(0);
  const [risks, setRisks] = useState(0);

  const effectiveScope: "mine" | "all" =
    scope === "mine" && me !== null && !me.is_admin ? "mine" : "all";

  useEffect(() => {
    if (!isAuthenticated) {
      setOverdue(0);
      setRisks(0);
      return;
    }
    let cancelled = false;
    // due_date is a plain ISO date string, so a lexicographic compare against
    // today's is exact and avoids pulling date-fns into the shell chunk.
    const today = new Date().toISOString().slice(0, 10);
    const fetcher = effectiveScope === "mine" ? fetchMyDashboard : fetchDashboard;
    fetcher()
      .then((d) => {
        if (cancelled) return;
        setOverdue(
          (d.open_actions || []).filter((a) => a.due_date && a.due_date < today)
            .length,
        );
      })
      .catch(() => undefined);
    fetchOpenRisks(effectiveScope)
      .then((r) => {
        if (!cancelled) setRisks(r.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, effectiveScope]);

  const count = overdue + risks;

  return (
    <button
      type="button"
      onClick={() => nav("/actions")}
      aria-label={`Notifications — ${count} item${count === 1 ? "" : "s"} need attention`}
      title={
        count
          ? `${overdue} overdue action${overdue === 1 ? "" : "s"} · ${risks} open risk${risks === 1 ? "" : "s"}`
          : "Nothing needs your attention"
      }
      className={clsx(ICON_BUTTON, "relative text-[15px]")}
    >
      <span aria-hidden="true">🔔</span>
      {count > 0 && (
        // The ring is a cut-out of the header behind it, not a white ring —
        // it has to follow the header surface in both themes.
        <span className="absolute top-[5px] right-[6px] h-2 w-2 rounded-full bg-brand-brightred border-[1.5px] border-surface-card" />
      )}
    </button>
  );
}

/**
 * Live read of the active theme, for the handful of places that have to branch
 * on it in JS rather than in CSS (the logo swaps — a PNG can't re-colour
 * itself).
 *
 * The `dark` class on <html> is the single source of truth: the inline script
 * in index.html applies it before first paint and ThemeToggle flips it
 * afterwards. Observing the class rather than reading localStorage means this
 * stays correct no matter who wrote it, and needs no context plumbing.
 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.classList.contains("dark"));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  return dark;
}

/**
 * Light/dark toggle.
 *
 * Flips the `dark` class on <html> and remembers the choice. That one class is
 * the whole mechanism: every colour in tailwind.config.js resolves through a
 * CSS variable, and `.dark` in styles/index.css redefines the palette, so the
 * app re-themes without a `dark:` variant on every element.
 *
 * The storage key and the class name are shared with the inline script in
 * index.html, which applies the saved theme before first paint so dark-mode
 * users don't get a white flash on load. Change one, change both.
 */
function ThemeToggle() {
  const [dark, setDark] = useState(
    () => localStorage.getItem(THEME_LS_KEY) === "dark",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem(THEME_LS_KEY, dark ? "dark" : "light");
  }, [dark]);

  return (
    <button
      type="button"
      onClick={() => setDark((d) => !d)}
      aria-pressed={dark}
      aria-label="Dark mode"
      title={
        dark ? "Dark mode on — switch to light" : "Dark mode off — switch to dark"
      }
      className={clsx(ICON_BUTTON, "text-sm")}
    >
      {/* The glyph reports the theme you are in, not the one you'd switch to —
          `aria-pressed` says the same thing to a screen reader. */}
      <span aria-hidden="true">{dark ? "☾" : "☀"}</span>
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
        {settings?.app.local_dev_mode && <LocalDevBadge />}
        <button
          type="button"
          onClick={() => void signIn()}
          className="btn-ghost h-[34px] py-0 text-sm"
        >
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-2" ref={wrapRef}>
      {settings?.app.local_dev_mode && <LocalDevBadge />}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-[34px] w-[34px] shrink-0 rounded-full bg-brand-red text-white flex items-center justify-center font-semibold text-[13px] hover:bg-brand-darkred transition"
        title={user?.name || user?.email || "Signed in"}
        aria-label="Open user menu"
      >
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-64 card p-3 shadow-lg">
          <div className="text-sm font-semibold text-brand-black truncate">
            {user?.name || "Signed in"}
          </div>
          {user?.email && (
            <div className="text-xs text-brand-gray truncate mb-2">
              {user.email}
            </div>
          )}
          <button
            type="button"
            className="w-full text-left px-2 py-1.5 text-sm text-brand-black hover:bg-surface-rowhover rounded-md flex items-center gap-2 transition"
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

/** Gold "heads up, this isn't prod" chip. Borrows the pending status tint
 *  rather than its own pair of gold washes — same warning hue, and it inverts
 *  to dark-fill/light-text in dark mode for free. */
function LocalDevBadge() {
  return (
    <span className="hidden xl:inline rounded-full bg-status-pending-bg border border-status-pending-border text-status-pending-text text-[11px] font-semibold px-2 py-0.5">
      Local dev
    </span>
  );
}

/**
 * The minutes stepper, rendered inline in the context row while the PM is
 * inside the meeting flow.
 *
 * When the PM is on /next-agenda we treat the four minutes steps as
 * neutral (not green-done) — they may have jumped straight here from the
 * top nav without doing minutes, so claiming those are "done" would lie.
 * Only show green ticks for genuinely-completed earlier steps within the
 * minutes flow itself.
 */
function MeetingStepper({ currentPath }: { currentPath: string }) {
  const nav = useNavigate();

  // Index across all 5 stepper paths (0-3 minutes, 4 = next agenda).
  const idx = STEPPER_PATHS.indexOf(currentPath);
  const onNextCycle = idx === 4;

  return (
    <>
      <RowDivider />
      <span className="micro-label shrink-0">This meeting</span>
      {MEETING_FLOW.map((s, i) => {
        const isDone = !onNextCycle && i < idx;
        const isActive = !onNextCycle && i === idx;
        return (
          <div key={s.to} className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => nav(s.to)}
              className={clsx(
                "inline-flex items-center gap-[7px] px-[11px] py-1 rounded-full text-xs font-semibold whitespace-nowrap transition",
                isActive && "bg-brand-red text-white",
                isDone && "text-brand-green",
                !isActive && !isDone && "text-brand-gray hover:text-brand-red",
              )}
            >
              <span
                className={clsx(
                  "h-4 w-4 rounded-full flex items-center justify-center text-[10px]",
                  isActive && "bg-white/25",
                  isDone && "bg-status-completed-bg text-status-completed-text",
                  !isActive && !isDone && "bg-surface-mute",
                )}
              >
                {isDone ? "✓" : i + 1}
              </span>
              {s.label}
            </button>
            {i < MEETING_FLOW.length - 1 && (
              <span className="mx-0.5 w-[14px] h-px bg-surface-ghost" />
            )}
          </div>
        );
      })}

      {/* Cycle divider → the next weekly cycle starts here. */}
      <span className="text-brand-lightgray text-xs mx-0.5 shrink-0" aria-hidden="true">
        →
      </span>
      <button
        type="button"
        onClick={() => nav(NEXT_CYCLE_STEP.to)}
        className={clsx(
          "inline-flex shrink-0 items-center gap-1.5 px-[11px] py-1 rounded-full text-xs font-semibold whitespace-nowrap border transition",
          onNextCycle
            ? "bg-brand-red border-brand-red text-white"
            : // There's no status-* token in blue, so the tint is mixed from
              // brand-blue with an opacity modifier rather than baked as two
              // pale hexes. That's what makes it flip: the same recipe lands a
              // near-white chip in light and a deep teal wash in dark, under
              // deepblue text that has itself lightened to suit.
              "text-brand-deepblue bg-brand-blue/10 border-brand-blue/25",
        )}
        title="Plan the next coordination meeting's agenda"
      >
        <span aria-hidden="true">📅</span>
        {NEXT_CYCLE_STEP.label}
      </button>
    </>
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
    <footer className="border-t border-surface-border bg-surface-card px-9 py-3.5 mt-auto flex justify-between text-xs text-brand-gray">
      <span>Castillo Engineering · Project Management Office</span>
      <span className="hidden md:inline">© {new Date().getFullYear()}</span>
    </footer>
  );
}
