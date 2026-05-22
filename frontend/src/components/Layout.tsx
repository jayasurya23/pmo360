import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "@/lib/state";
import { useEffect, useState, useRef } from "react";
import clsx from "clsx";

interface NavItem {
  to: string;
  label: string;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/", label: "Home" },
  { to: "/capture", label: "Capture" },
  { to: "/next-agenda", label: "Next Agenda" },
  { to: "/actions", label: "Actions" },
  { to: "/notes", label: "Notes" },
  { to: "/history", label: "History" },
  { to: "/schedule", label: "Schedule" },
];

const MEETING_FLOW: NavItem[] = [
  { to: "/capture", label: "Capture" },
  { to: "/review", label: "Review" },
  { to: "/preview", label: "Preview" },
  { to: "/send", label: "Send" },
];

export default function Layout() {
  const { settings } = useApp();
  const location = useLocation();

  useEffect(() => {
    if (settings)
      document.title = `${settings.app.title} — ${settings.app.tool_name}`;
  }, [settings]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <TopNav />
      <ContextBar />
      <MeetingStepper currentPath={location.pathname} />
      <main className="flex-1 px-6 md:px-10 py-8 max-w-screen-2xl w-full mx-auto">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

function TopNav() {
  const location = useLocation();
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
        <UserMenu />
      </div>

      <MobileNav />
    </header>
  );
}

function MobileNav() {
  const location = useLocation();
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

function ContextBar() {
  const { clients, projects, selectedClientId, selectedProjectId } = useApp();
  const client = clients.find((c) => c.id === selectedClientId);
  const project = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="bg-white border-b border-slate-200">
      <div className="max-w-screen-2xl mx-auto px-6 md:px-10 py-3 flex items-center gap-4">
        <ContextSwitcher />
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

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:border-slate-300 transition text-sm"
      >
        <span className="h-2 w-2 rounded-full bg-brand-red" />
        <span className="font-medium text-slate-900">
          {project?.name || "No portfolio"}
        </span>
        <span className="text-slate-400">/</span>
        <span className="text-slate-600">{client?.name || "No client"}</span>
        <svg
          className={clsx(
            "h-4 w-4 text-slate-400 transition",
            open && "rotate-180"
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
  return (
    <div className="hidden md:flex items-center gap-2 text-xs text-slate-400 px-3 py-1.5 rounded-md border border-slate-200 bg-slate-50">
      <span>Search</span>
      <kbd className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[10px] font-mono">
        ⌘K
      </kbd>
    </div>
  );
}

function UserMenu() {
  const { settings } = useApp();
  return (
    <div className="flex items-center gap-2">
      <span className="hidden lg:inline text-xs text-slate-500">
        {settings?.app.local_dev_mode ? "Local dev" : "Production"}
      </span>
      <div className="h-9 w-9 rounded-full bg-brand-red text-white flex items-center justify-center font-semibold text-sm">
        CE
      </div>
    </div>
  );
}

function MeetingStepper({ currentPath }: { currentPath: string }) {
  const idx = MEETING_FLOW.findIndex((s) => s.to === currentPath);
  const nav = useNavigate();
  if (idx === -1) return null;
  return (
    <div className="bg-gradient-to-b from-white to-slate-50 border-b border-slate-200">
      <div className="max-w-screen-2xl mx-auto px-6 md:px-10 py-3">
        <div className="flex items-center gap-3 overflow-x-auto">
          {MEETING_FLOW.map((s, i) => {
            const isDone = i < idx;
            const isActive = i === idx;
            return (
              <div key={s.to} className="flex items-center">
                <button
                  onClick={() => nav(s.to)}
                  className={clsx(
                    "flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold transition whitespace-nowrap",
                    isActive && "bg-brand-red text-white shadow-sm",
                    isDone && "bg-emerald-50 text-emerald-700 border border-emerald-200",
                    !isActive && !isDone && "text-slate-500 hover:text-slate-700"
                  )}
                >
                  <span
                    className={clsx(
                      "h-5 w-5 rounded-full flex items-center justify-center text-[10px]",
                      isActive && "bg-white/20",
                      isDone && "bg-emerald-100 text-emerald-700",
                      !isActive && !isDone && "bg-slate-100 text-slate-500"
                    )}
                  >
                    {isDone ? "✓" : i + 1}
                  </span>
                  {s.label}
                </button>
                {i < MEETING_FLOW.length - 1 && (
                  <div className="mx-2 h-px w-6 bg-slate-200" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
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
