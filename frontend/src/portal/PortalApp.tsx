/**
 * The client portal — a small, separate app that reads the same database.
 *
 * Mounted from main.tsx OUTSIDE <AuthProvider> and <AuthGate>, so nothing here
 * can trigger MSAL, and no internal page component is ever imported. It is not
 * the employee site with cards hidden; it is four screens over four allowlisted
 * endpoints, and the shape of each screen is exactly the shape of its endpoint.
 *
 * TWO DOORS, ONE PRINCIPAL. A client arrives either through an invite link
 * (?token=… in the URL) or by signing in with email and password. A login does
 * not create a different kind of credential — it returns a portal token that
 * is stored exactly as an invite token is. Everything after that is identical.
 *
 * Every 401 renders the same "sign in" state. The backend deliberately does
 * not say WHY (absent / revoked / expired / wrong password), and neither do we.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  captureTokenFromUrl,
  clearPortalToken,
  getPortalToken,
  portalChangeOrders,
  portalChangePassword,
  portalDashboard,
  portalLogin,
  portalLogout,
  portalMe,
  portalProjects,
  portalRfis,
  portalWaiting,
  setPortalToken,
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

function statusOf(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}
function detailOf(e: unknown): string | undefined {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof d === "string" ? d : undefined;
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
      .catch((e) => live && setErr(statusOf(e) === 401 ? "unauthorized" : "failed"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, err, loading };
}

// ----------------------------------------------------------------- chrome

function Shell({ me, onLogout, children }: { me: PortalMe | null; onLogout?: () => void; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface text-brand-black">
      <header className="border-b border-surface-line bg-surface-card">
        <div className="mx-auto max-w-5xl px-5 py-4 flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-brand-gray">
              Castillo Engineering · Client portal
            </div>
            <div className="text-lg font-semibold">{me?.client_name ?? " "}</div>
          </div>
          <div className="flex items-center gap-4 text-xs text-brand-gray">
            {me?.kind === "session" && me.email && <span>{me.email}</span>}
            {me?.kind === "session" && (
              <Link to="/portal/account" className="hover:text-brand-red">Change password</Link>
            )}
            {me?.kind === "invite" && me.expires_at && <span>Link valid until {fmtDate(me.expires_at)}</span>}
            {me && onLogout && (
              <button className="btn btn-ghost text-xs" onClick={onLogout}>
                {me.kind === "session" ? "Sign out" : "Close link"}
              </button>
            )}
          </div>
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

// ----------------------------------------------------------------- auth screens

function LoginScreen({ notice, onSignedIn }: { notice?: string; onSignedIn: (me: PortalMe) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    portalLogin(email.trim(), password)
      .then((r) => {
        setPortalToken(r.token);
        return portalMe();
      })
      .then(onSignedIn)
      .catch((e) => setErr(detailOf(e) || "Could not sign in. Please try again."))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-auto max-w-sm mt-14 card p-7">
      <div className="text-lg font-semibold mb-1">Sign in</div>
      <p className="text-sm text-brand-gray mb-5">
        {notice || "Use the email and password your Castillo project manager gave you."}
      </p>
      <form onSubmit={submit} className="grid gap-3">
        <div>
          <label className="label" htmlFor="pl-email">Email</label>
          <input id="pl-email" className="select" type="email" autoComplete="username" required
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="pl-pw">Password</label>
          <input id="pl-pw" className="select" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {err && <p className="text-sm text-brand-red">{err}</p>}
        <button className="btn btn-primary mt-1" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="text-xs text-brand-gray mt-5">
        Were you sent a link instead? Open it from the email — it signs you in on its own.
      </p>
    </div>
  );
}

function ChangePasswordScreen({ forced, onDone }: { forced: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) {
      setErr("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setErr(null);
    portalChangePassword(current, next)
      .then(onDone)
      .catch((e) => setErr(detailOf(e) || "Could not change the password."))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-auto max-w-sm mt-10 card p-7">
      <div className="text-lg font-semibold mb-1">{forced ? "Choose a new password" : "Change password"}</div>
      <p className="text-sm text-brand-gray mb-5">
        {forced
          ? "You are signed in with a temporary password. Choose your own before continuing."
          : "At least 12 characters. Longer is better; symbols are optional."}
      </p>
      <form onSubmit={submit} className="grid gap-3">
        <div>
          <label className="label" htmlFor="cp-cur">{forced ? "Temporary password" : "Current password"}</label>
          <input id="cp-cur" className="select" type="password" autoComplete="current-password" required
            value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cp-new">New password</label>
          <input id="cp-new" className="select" type="password" autoComplete="new-password" required minLength={12}
            value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cp-again">New password again</label>
          <input id="cp-again" className="select" type="password" autoComplete="new-password" required minLength={12}
            value={again} onChange={(e) => setAgain(e.target.value)} />
        </div>
        {err && <p className="text-sm text-brand-red">{err}</p>}
        <button className="btn btn-primary mt-1" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save password"}
        </button>
      </form>
    </div>
  );
}

// ----------------------------------------------------------------- screens

function PortfolioList() {
  const { data, err, loading } = useLoad(portalProjects, []);
  if (loading) return <p className="text-sm text-brand-gray">Loading your projects…</p>;
  if (err === "unauthorized") return <Navigate to="/portal/expired" replace />;
  if (err) return <Notice title="Could not load" body="Please try again in a moment." />;
  if (!data?.length) return <Notice title="No projects yet" body="Nothing has been shared with this account." />;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {data.map((p: PortalPortfolio) => (
        <Link key={p.id} to={`/portal/p/${p.id}`} className="card p-5 hover:border-brand-red transition-colors">
          <div className="text-base font-semibold">{p.name}</div>
          <div className="text-sm text-brand-gray mt-0.5">
            {[p.location, p.state, p.size_mw ? `${p.size_mw} MW` : null].filter(Boolean).join(" · ")}
          </div>
          {p.projects.length > 0 && (
            <div className="text-xs text-brand-gray mt-3">{p.projects.map((s) => s.name).join(" · ")}</div>
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
              (tab === key ? "border-brand-red font-semibold" : "border-transparent text-brand-gray hover:text-brand-black")
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
  if (err === "unauthorized") return <Navigate to="/portal/expired" replace />;
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
  if (err === "unauthorized") return <Navigate to="/portal/expired" replace />;
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
  if (err === "unauthorized") return <Navigate to="/portal/expired" replace />;
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
  if (err === "unauthorized") return <Navigate to="/portal/expired" replace />;
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

type State = "boot" | "login" | "mustchange" | "ok";

export default function PortalApp() {
  const [me, setMe] = useState<PortalMe | null>(null);
  const [state, setState] = useState<State>("boot");
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const navigate = useNavigate();

  const settle = (m: PortalMe) => {
    setMe(m);
    setState(m.must_change_password ? "mustchange" : "ok");
  };

  useEffect(() => {
    captureTokenFromUrl();
    if (!getPortalToken()) {
      setState("login");
      return;
    }
    portalMe()
      .then(settle)
      .catch(() => {
        clearPortalToken();
        setNotice("That link is no longer valid. Sign in, or ask your project manager for a new link.");
        setState("login");
      });
  }, []);

  const signOut = () => {
    portalLogout().catch(() => undefined).finally(() => {
      clearPortalToken();
      setMe(null);
      setNotice(undefined);
      setState("login");
      navigate("/portal", { replace: true });
    });
  };

  if (state === "boot") {
    return <Shell me={null}><p className="text-sm text-brand-gray">Opening…</p></Shell>;
  }
  if (state === "login") {
    return (
      <Shell me={null}>
        <LoginScreen notice={notice} onSignedIn={settle} />
      </Shell>
    );
  }
  if (state === "mustchange") {
    return (
      <Shell me={me} onLogout={signOut}>
        <ChangePasswordScreen forced onDone={() => portalMe().then(settle)} />
      </Shell>
    );
  }

  return (
    <Shell me={me} onLogout={signOut}>
      <Routes>
        <Route path="/portal" element={<PortfolioList />} />
        <Route path="/portal/p/:id" element={<PortfolioScreen />} />
        <Route path="/portal/p/:id/:tab" element={<PortfolioScreen />} />
        <Route
          path="/portal/account"
          element={
            me?.kind === "session" ? (
              <ChangePasswordScreen forced={false} onDone={() => navigate("/portal", { replace: true })} />
            ) : (
              <Navigate to="/portal" replace />
            )
          }
        />
        <Route
          path="/portal/expired"
          element={<ExpiredRedirect onExpired={() => { clearPortalToken(); setMe(null); setNotice("Your session ended. Please sign in again."); setState("login"); }} />}
        />
        <Route path="*" element={<Navigate to="/portal" replace />} />
      </Routes>
    </Shell>
  );
}

/** A 401 mid-session lands here; it hands control back to the login screen. */
function ExpiredRedirect({ onExpired }: { onExpired: () => void }) {
  useEffect(() => {
    onExpired();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
