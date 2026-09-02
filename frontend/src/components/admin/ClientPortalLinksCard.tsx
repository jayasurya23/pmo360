/**
 * Settings → Client links: everything a Castillo user does to let a client in.
 *
 * Two doors, managed side by side:
 *   Links     — a signed invite link, no account. Shown ONCE when issued.
 *   Accounts  — email + password. The temporary password is shown ONCE, on
 *               create and on reset, and is never retrievable afterwards.
 *
 * Both rules come from the backend (tokens and passwords are hashed at rest)
 * and this card does not soften them: there is no "show it again", only
 * "revoke and reissue" / "reset".
 *
 * The one-time secret is shown until the admin dismisses it, revokes it, or
 * acts on another row — never silently across an unrelated reload, and never
 * for a link that has just been revoked.
 *
 * The invite link is assembled here from window.location.origin because the
 * server does not reliably know the public hostname behind the ingress. The
 * token goes in the URL FRAGMENT: a fragment never reaches the server, so it
 * cannot land in an access log or a Referer header.
 */
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { useApp } from "@/lib/state";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  createPortalAccount,
  issuePortalToken,
  listPortalAccounts,
  listPortalTokens,
  resetPortalAccountPassword,
  revokePortalToken,
  setPortalAccountActive,
  type CreatedPortalAccount,
  type IssuedPortalToken,
  type PortalAccountOut,
  type PortalTokenOut,
} from "@/lib/api";

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function errText(e: unknown): string {
  const d = (e as { response?: { data?: { detail?: unknown } }; message?: string })?.response?.data?.detail;
  return typeof d === "string" ? d : (e as { message?: string })?.message || "Something went wrong.";
}

function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2 items-center">
      <code className="text-xs bg-surface-mute border border-surface-line rounded px-2 py-1 flex-1 truncate">{value}</code>
      <button
        className="btn text-xs"
        onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => setCopied(false))}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** The one-time secret box. Same chrome for a password and for a link. */
function SecretBox({ title, hint, value, onDismiss }: { title: string; hint: string; value: string; onDismiss: () => void }) {
  return (
    <div className="border border-brand-green rounded p-4 mb-5 bg-brand-green/5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-semibold mb-1">{title}</div>
        <button className="btn btn-ghost text-xs" onClick={onDismiss}>Dismiss</button>
      </div>
      <p className="text-xs text-brand-gray mb-2">{hint}</p>
      <CopyBox value={value} />
    </div>
  );
}

export default function ClientPortalLinksCard() {
  const { clients } = useApp();
  const [clientId, setClientId] = useState<number | null>(null);
  const portalOrigin = window.location.origin;

  useEffect(() => {
    if (clientId === null && clients.length) setClientId(clients[0].id);
  }, [clients, clientId]);

  return (
    <div className="grid gap-6">
      <section className="card p-5 sm:p-6">
        <div className="flex items-baseline gap-3 mb-1 flex-wrap">
          <h2 className="text-base font-semibold flex-1">Client portal access</h2>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-brand-gray">needs Client Mgmt</span>
        </div>
        <p className="text-sm text-brand-gray mb-4 max-w-2xl">
          A client sees their own projects, RFIs, what we are waiting on from them, and approved change orders —
          nothing else. Give access either as a sign-in account or as a one-off link.
        </p>
        <div className="max-w-sm">
          <label className="label" htmlFor="cpl-client">Client</label>
          <select id="cpl-client" className="select select-sm" value={clientId ?? ""} onChange={(e) => setClientId(Number(e.target.value))}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </section>

      {clientId !== null && <AccountsPanel clientId={clientId} portalOrigin={portalOrigin} />}
      {clientId !== null && <LinksPanel clientId={clientId} portalOrigin={portalOrigin} />}
    </div>
  );
}

// ----------------------------------------------------------------- accounts

function AccountsPanel({ clientId, portalOrigin }: { clientId: number; portalOrigin: string }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<PortalAccountOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedPortalAccount | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    listPortalAccounts(clientId).then(setRows).catch((e) => setErr(errText(e))).finally(() => setLoading(false));
  }, [clientId]);

  useEffect(() => {
    setCreated(null);
    load();
  }, [load]);

  const create = () => {
    if (!email.trim()) return;
    setBusy(true);
    setErr(null);
    createPortalAccount(clientId, { email: email.trim(), display_name: name.trim() || null })
      .then((a) => {
        setCreated(a);
        setEmail("");
        setName("");
        load();
      })
      .catch((e) => setErr(errText(e)))
      .finally(() => setBusy(false));
  };

  // Reset and Disable both sign the client out everywhere; neither is a thing
  // to do on a misclick.
  const reset = async (a: PortalAccountOut) => {
    const ok = await confirm({
      title: `Reset the password for ${a.email}?`,
      body: "This signs them out everywhere and invalidates their current password. You will get a new temporary password to hand over.",
      confirmLabel: "Reset password",
    });
    if (!ok) return;
    setErr(null);
    setCreated(null);
    resetPortalAccountPassword(a.id).then((r) => { setCreated(r); load(); }).catch((e) => setErr(errText(e)));
  };

  const toggle = async (a: PortalAccountOut) => {
    if (a.is_active) {
      const ok = await confirm({
        title: `Disable ${a.email}?`,
        body: "They are signed out everywhere immediately and cannot sign in until the account is enabled again.",
        confirmLabel: "Disable",
      });
      if (!ok) return;
    }
    setErr(null);
    setCreated(null);
    setPortalAccountActive(a.id, !a.is_active).then(load).catch((e) => setErr(errText(e)));
  };

  return (
    <section className="card p-5 sm:p-6">
      <h3 className="text-sm font-semibold mb-1">Sign-in accounts</h3>
      <p className="text-sm text-brand-gray mb-4 max-w-2xl">
        The client signs in at <code className="text-xs">{portalOrigin}/portal</code> with their email. They must choose their own
        password on first sign-in; until they do, the portal shows them nothing.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] items-end mb-5">
        <div>
          <label className="label" htmlFor="cpa-email">Email</label>
          <input id="cpa-email" className="select select-sm" type="email" placeholder="jane@client.example"
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cpa-name">Name (optional)</label>
          <input id="cpa-name" className="select select-sm" type="text" placeholder="Jane Smith"
            value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="btn btn-primary" onClick={create} disabled={busy || !email.trim()}>
          {busy ? "Creating…" : "Create account"}
        </button>
      </div>

      {err && <p className="text-sm text-brand-red mb-3">{err}</p>}

      {created && (
        <SecretBox
          title={`Temporary password for ${created.email}`}
          hint="Give this to the client now — it will not be shown again. They will be asked to replace it on first sign-in."
          value={created.temporary_password}
          onDismiss={() => setCreated(null)}
        />
      )}

      {loading ? (
        <p className="text-sm text-brand-gray">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-brand-gray">No accounts yet for this client.</p>
      ) : (
        <div className="border border-surface-line rounded overflow-hidden">
          {rows.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-surface-line last:border-b-0">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {a.email}
                  {a.display_name && <span className="text-brand-gray font-normal"> · {a.display_name}</span>}
                </div>
                <div className="text-xs text-brand-gray">
                  created {fmt(a.created_at)}{a.created_by ? ` by ${a.created_by}` : ""}
                  {a.last_login_at ? ` · last sign-in ${fmt(a.last_login_at)}` : " · never signed in"}
                  {a.must_change_password ? " · temporary password" : ""}
                  {a.locked_until && new Date(a.locked_until) > new Date() ? " · locked" : ""}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={clsx(
                  "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded",
                  a.is_active ? "bg-brand-green/15 text-brand-green" : "bg-surface-mute text-brand-gray",
                )}>
                  {a.is_active ? "Active" : "Disabled"}
                </span>
                {/* A disabled account cannot use a new password; the server refuses the reset too. */}
                {a.is_active && (
                  <button className="btn btn-ghost text-xs" onClick={() => void reset(a)}>Reset password</button>
                )}
                <button className="btn btn-ghost text-xs" onClick={() => void toggle(a)}>{a.is_active ? "Disable" : "Enable"}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ----------------------------------------------------------------- links

function LinksPanel({ clientId, portalOrigin }: { clientId: number; portalOrigin: string }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<PortalTokenOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(90);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedPortalToken | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    listPortalTokens(clientId).then(setRows).catch((e) => setErr(errText(e))).finally(() => setLoading(false));
  }, [clientId]);

  useEffect(() => {
    setIssued(null);
    load();
  }, [load]);

  const issue = () => {
    if (!label.trim()) return;
    setIssuing(true);
    setErr(null);
    issuePortalToken(clientId, { label: label.trim(), expires_in_days: days })
      .then((t) => { setIssued(t); setLabel(""); load(); })
      .catch((e) => setErr(errText(e)))
      .finally(() => setIssuing(false));
  };

  const revoke = async (r: PortalTokenOut) => {
    const ok = await confirm({
      title: `Revoke "${r.label}"?`,
      body: "Anyone holding this link loses access immediately. A new link can be issued at any time.",
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    setErr(null);
    // Never keep showing a link that has just been killed.
    if (issued?.id === r.id) setIssued(null);
    revokePortalToken(r.id).then(load).catch((e) => setErr(errText(e)));
  };

  const link = issued ? `${portalOrigin}/portal#token=${issued.raw_token}` : null;
  const invites = rows.filter((r) => r.kind !== "session");

  return (
    <section className="card p-5 sm:p-6">
      <h3 className="text-sm font-semibold mb-1">One-off links</h3>
      <p className="text-sm text-brand-gray mb-4 max-w-2xl">
        A link signs the holder in without a password. Useful for a single share; use an account for ongoing access.
        The link is shown once when issued.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] items-end mb-5">
        <div>
          <label className="label" htmlFor="cpl-label">Label</label>
          <input id="cpl-label" className="select select-sm" placeholder="e.g. Utopian — Jane Smith"
            value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cpl-days">Valid for</label>
          <select id="cpl-days" className="select select-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>1 year</option>
          </select>
        </div>
        <button className="btn" onClick={issue} disabled={issuing || !label.trim()}>
          {issuing ? "Issuing…" : "Issue link"}
        </button>
      </div>

      {err && <p className="text-sm text-brand-red mb-3">{err}</p>}

      {issued && link && (
        <SecretBox
          title={`Link issued for ${issued.label}`}
          hint={`Copy it now — it will not be shown again. Valid until ${fmt(issued.expires_at)}.`}
          value={link}
          onDismiss={() => setIssued(null)}
        />
      )}

      {loading ? (
        <p className="text-sm text-brand-gray">Loading…</p>
      ) : invites.length === 0 ? (
        <p className="text-sm text-brand-gray">No links have been issued for this client.</p>
      ) : (
        <div className="border border-surface-line rounded overflow-hidden">
          {invites.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-surface-line last:border-b-0">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {r.label}
                  {r.contact_name && <span className="text-brand-gray font-normal"> · {r.contact_name}</span>}
                </div>
                <div className="text-xs text-brand-gray">
                  issued {fmt(r.created_at)}{r.created_by ? ` by ${r.created_by}` : ""} · expires {fmt(r.expires_at)}
                  {r.last_used_at ? ` · last opened ${fmt(r.last_used_at)}` : " · never opened"}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={clsx(
                  "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded",
                  r.is_live ? "bg-brand-green/15 text-brand-green" : "bg-surface-mute text-brand-gray",
                )}>
                  {r.revoked_at ? "Revoked" : r.is_live ? "Live" : "Expired"}
                </span>
                {r.is_live && <button className="btn btn-ghost text-xs" onClick={() => void revoke(r)}>Revoke</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
