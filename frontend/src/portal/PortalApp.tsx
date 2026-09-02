/**
 * The client portal — a small, separate app that reads the same database.
 *
 * Mounted from main.tsx OUTSIDE <AuthProvider> and <AuthGate>, so nothing here
 * can trigger MSAL, and no internal page component is ever imported. It is not
 * the employee site with cards hidden; it is four screens over four allowlisted
 * endpoints, and the shape of each screen is exactly the shape of its endpoint.
 *
 * Every 401 renders the same "this link is no longer valid" state. The backend
 * deliberately does not say WHY (absent / revoked / expired), and neither do we.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";
import {
  captureTokenFromUrl,
  clearPortalToken,
  getPortalToken,
  portalChangeOrders,
  portalDashboard,
  portalMe,
  portalProjects,
  portalRfis,
  portalWaiting,
  type PortalChangeOrders,
  type PortalDashboard,
  type PortalMe,
  type PortalPortfolio,
  type PortalRfi,
  type PortalWaiting,
} from "./portalClient";

// ----------------------------------------------------------------- helpers

function money(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function isUnauthorized(e: unknown): boolean {
  return (e as { response?: { status?: number } })?.response?.status === 401;
}

/** One request, three states. Keeps every screen honest about failure. */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<"unauthorized" | "failed" | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    fn()
      .then((d) => live && setData(d))
      .catch((e) => live && setErr(isUnauthorized(e) ? "unauthorized" : "failed"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, err, loading };
}

// ----------------------------------------------------------------- chrome

function Shell({ me, children }: { me: PortalMe | null; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface text-brand-black">
      <header className="border-b border-surface-line bg-surface-card">
        <div className="mx-auto max-w-5xl px-5 py-4 flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-gray">
              Castillo Engineering · Client portal
            </div>
            <div className="text-lg font-semibold">{me?.client_name ?? " "}</div>
          </div>
          {me?.expires_at && (
            <div className="text-xs text-brand-gray">Link valid until {fmtDate(me.expires_at)}</div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-6">{children}</main>
      <footer className="mx-auto max-w-5xl px-5 py-8 text-xs text-brand-gray">
        Figures shown here are taken from the minutes and change orders you have been sent. Invoices and
        balances are not held in this system.
      </footer>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-lg mt-16 card p-8 text-center">
      <div className="text-lg font-semibold mb-2">{title}</div>
      <p className="text-sm text-brand-gray">{body}</p>
    </div>
  );
}

function Tile({ v, l }: { v: ReactNode; l: string }) {
  return (
    <div className="bg-surface-card p-4">
      <div className="text-2xl font-semibold leading-none">{v}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-brand-gray mt-2">{l}</div>
    </div>
  );
}

function Pill({ open }: { open: boolean }) {
  return (
    <span
      className={
        "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded whitespace-nowrap " +
        (open ? "bg-brand-gold/20 text-brand-deepgold" : "bg-brand-green/15 text-brand-green")
      }
    >
      {open ? "Open" : "Closed"}
    </span>
  );
}

// ----------------------------------------------------------------- screens

function PortfolioList() {
  const { data, err, loading } = useLoad(portalProjects, []);
  if (loading) return <p className="text-sm text-brand-gray">Loading your projects…</p>;
  if (err === "unauthorized") return <Navigate to="/portal/invalid" replace />;
  if (err) return <Notice title="Could not load" body="Please try again in a moment." />;
  if (!data?.length) return <Notice title="No projects yet" body="Nothing has been shared with this link." />;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {data.map((p: PortalPortfolio) => (
        <Link key={p.id} to={`/portal/p/${p.id}`} className="card p-5 hover:border-brand-red transition-colors">
          <div className="text-base font-semibold">{p.name}</div>
          <div className="text-sm text-brand-gray mt-0.5">
            {[p.location, p.state, p.size_mw ? `${p.size_mw} MW` : null].filter(Boolean).join(" · ")}
          </div>
          {p.projects.length > 0 && (
            <div className="text-xs text-brand-gray mt-3">
              {p.projects.map((s) => s.name).join(" · ")}
            </div>
          )}
        </Link>
      ))}
    </div>
  );
}

type Tab = "overview" | "rfis" | "waiting" | "change-orders";

function PortfolioScreen() {
  const { id, tab = "overview" } = useParams<{ id: string; tab?: Tab }>();
  const pid = Number(id);
  const tabs: [Tab, string][] = [
    ["overview", "Overview"],
    ["waiting", "Waiting on you"],
    ["rfis", "RFIs"],
    ["change-orders", "Change orders"],
  ];
  return (
    <div>
      <Link to="/portal" className="text-xs text-brand-gray hover:text-brand-red">← All projects</Link>
      <nav className="flex gap-1 mt-3 mb-5 border-b border-surface-line">
        {tabs.map(([key, label]) => (
          <Link
            key={key}
            to={`/portal/p/${pid}/${key}`}
            className={
              "px-3 py-2 text-sm -mb-px border-b-2 " +
              (tab === key
                ? "border-brand-red font-semibold"
                : "border-transparent text-brand-gray hover:text-brand-black")
            }
          >
            {label}
          </Link>
        ))}
      </nav>
      {tab === "overview" && <Overview pid={pid} />}
      {tab === "waiting" && <Waiting pid={pid} />}
      {tab === "rfis" && <Rfis pid={pid} />}
      {tab === "change-orders" && <ChangeOrders pid={pid} />}
    </div>
  );
}

function Overview({ pid }: { pid: number }) {
  const { data, err, loading } = useLoad(() => portalDashboard(pid), [pid]);
  if (loading) return <p className="text-sm text-brand-gray">Loading…</p>;
  if (err === "unauthorized") return <Navigate to="/portal/invalid" replace />;
  if (err || !data) return <Notice title="Not available" body="This project could not be loaded." />;
  const d: PortalDashboard = data;
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">{d.portfolio_name}</h1>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-surface-line rounded overflow-hidden mb-6">
        <Tile v={d.waiting_on_you} l="Waiting on you" />
        <Tile v={d.open_actions} l="Open actions" />
        <Tile v={d.approved_change_orders.count} l="Change orders" />
        <Tile v={money(d.approved_change_orders.approved_total)} l="Approved value" />
      </div>
      <div className="text-sm text-brand-gray">
        {d.last_issued_meeting ? (
          <>
            Latest minutes: <span className="text-brand-black">{d.last_issued_meeting.title}</span>,{" "}
            {fmtDate(d.last_issued_meeting.meeting_date)}
          </>
        ) : (
          "No minutes have been issued for this project yet."
        )}
        {d.approved_change_orders.hourly_count > 0 && (
          <> · {d.approved_change_orders.hourly_count} hourly change order{d.approved_change_orders.hourly_count > 1 ? "s" : ""} not included in the approved value.</>
        )}
      </div>
    </div>
  );
}

function RfiRows({ rows }: { rows: PortalRfi[] }) {
  if (!rows.length) return <p className="text-sm text-brand-gray">Nothing here.</p>;
  return (
    <div className="border border-surface-line rounded overflow-hidden">
      {rows.map((r, i) => (
        <div key={i} className="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-surface-line last:border-b-0 bg-surface-card">
          <div className="min-w-0">
            <div className="text-sm font-medium">{r.item}</div>
            {r.description && <div className="text-sm text-brand-gray mt-0.5">{r.description}</div>}
            <div className="text-xs text-brand-gray mt-1">
              {[r.project_name, r.needed_by ? `needed by ${fmtDate(r.needed_by)}` : null].filter(Boolean).join(" · ")}
            </div>
          </div>
          <Pill open={r.is_open} />
        </div>
      ))}
    </div>
  );
}

function Rfis({ pid }: { pid: number }) {
  const { data, err, loading } = useLoad(() => portalRfis(pid), [pid]);
  if (loading) return <p className="text-sm text-brand-gray">Loading…</p>;
  if (err === "unauthorized") return <Navigate to="/portal/invalid" replace />;
  if (err || !data) return <Notice title="Not available" body="RFIs could not be loaded." />;
  return (
    <div>
      <h2 className="text-lg font-semibold mb-3">Requests for information</h2>
      <RfiRows rows={data} />
    </div>
  );
}

function Waiting({ pid }: { pid: number }) {
  const { data, err, loading } = useLoad(() => portalWaiting(pid), [pid]);
  if (loading) return <p className="text-sm text-brand-gray">Loading…</p>;
  if (err === "unauthorized") return <Navigate to="/portal/invalid" replace />;
  if (err || !data) return <Notice title="Not available" body="This list could not be loaded." />;
  const w: PortalWaiting = data;
  return (
    <div className="grid gap-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Information we need from you</h2>
        <p className="text-sm text-brand-gray mb-3">Open requests where the next step is yours.</p>
        <RfiRows rows={w.rfis} />
      </div>
      <div>
        <h2 className="text-lg font-semibold mb-1">Actions assigned to you</h2>
        {w.note && <p className="text-sm text-brand-gray mb-3">{w.note}</p>}
        {w.actions.length > 0 && (
          <div className="border border-surface-line rounded overflow-hidden">
            {w.actions.map((a, i) => (
              <div key={i} className="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-surface-line last:border-b-0 bg-surface-card">
                <div className="text-sm">{a.text}</div>
                <div className="text-xs text-brand-gray whitespace-nowrap">{a.due_date ? `due ${fmtDate(a.due_date)}` : ""}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChangeOrders({ pid }: { pid: number }) {
  const { data, err, loading } = useLoad(() => portalChangeOrders(pid), [pid]);
  if (loading) return <p className="text-sm text-brand-gray">Loading…</p>;
  if (err === "unauthorized") return <Navigate to="/portal/invalid" replace />;
  if (err || !data) return <Notice title="Not available" body="Change orders could not be loaded." />;
  const c: PortalChangeOrders = data;
  return (
    <div>
      <h2 className="text-lg font-semibold mb-3">Approved change orders</h2>
      <div className="grid grid-cols-3 gap-px bg-surface-line rounded overflow-hidden mb-4">
        <Tile v={c.summary.count} l="Approved" />
        <Tile v={money(c.summary.approved_total)} l="Approved value" />
        <Tile v={c.summary.hourly_count} l="Hourly" />
      </div>
      {c.items.length === 0 ? (
        <p className="text-sm text-brand-gray">No approved change orders have been issued.</p>
      ) : (
        <div className="border border-surface-line rounded overflow-hidden mb-4">
          {c.items.map((co, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 px-3 py-2.5 border-b border-surface-line last:border-b-0 bg-surface-card">
              <div className="text-sm">
                {co.title || "Change order"}
                <span className="text-xs text-brand-gray"> · {fmtDate(co.request_date)}</span>
              </div>
              <div className="text-sm tabular-nums whitespace-nowrap">
                {co.is_hourly ? <span className="text-brand-gray">hourly</span> : money(co.total)}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-brand-gray max-w-2xl">{c.note}</p>
    </div>
  );
}

// ----------------------------------------------------------------- app

export default function PortalApp() {
  const [me, setMe] = useState<PortalMe | null>(null);
  const [state, setState] = useState<"boot" | "ok" | "nolink" | "invalid">("boot");

  useEffect(() => {
    captureTokenFromUrl();
    if (!getPortalToken()) {
      setState("nolink");
      return;
    }
    portalMe()
      .then((m) => {
        setMe(m);
        setState("ok");
      })
      .catch((e) => {
        if (isUnauthorized(e)) clearPortalToken();
        setState("invalid");
      });
  }, []);

  if (state === "boot") return <Shell me={null}><p className="text-sm text-brand-gray">Opening…</p></Shell>;
  if (state === "nolink")
    return (
      <Shell me={null}>
        <Notice title="Open the link you were sent" body="This page is reached from a private link provided by your Castillo project manager." />
      </Shell>
    );
  if (state === "invalid")
    return (
      <Shell me={null}>
        <Notice title="This link is no longer valid" body="It may have expired or been replaced. Please ask your Castillo project manager for a new one." />
      </Shell>
    );

  return (
    <Shell me={me}>
      <Routes>
        <Route path="/portal" element={<PortfolioList />} />
        <Route path="/portal/p/:id" element={<PortfolioScreen />} />
        <Route path="/portal/p/:id/:tab" element={<PortfolioScreen />} />
        <Route path="/portal/invalid" element={<Notice title="This link is no longer valid" body="Please ask your Castillo project manager for a new one." />} />
        <Route path="*" element={<Navigate to="/portal" replace />} />
      </Routes>
    </Shell>
  );
}
