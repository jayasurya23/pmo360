/**
 * Settings → Client links: issue and revoke client portal links.
 *
 * The raw link is shown ONCE, in the confirmation after issuing, and is not
 * retrievable afterwards — the list shows metadata only. That is the backend's
 * rule (the token is hashed at rest) and this card does not soften it: there is
 * no "show link again" button, only "revoke and issue a new one".
 *
 * The link is assembled here from window.location.origin because the server
 * does not reliably know the public hostname behind the container ingress.
 */
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { useApp } from "@/lib/state";
import {
  issuePortalToken,
  listPortalTokens,
  revokePortalToken,
  type IssuedPortalToken,
  type PortalTokenOut,
} from "@/lib/api";

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function ClientPortalLinksCard() {
  const { clients } = useApp();
  const [clientId, setClientId] = useState<number | null>(null);
  const [rows, setRows] = useState<PortalTokenOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [days, setDays] = useState(90);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<IssuedPortalToken | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (clientId === null && clients.length) setClientId(clients[0].id);
  }, [clients, clientId]);

  const load = useCallback(() => {
    if (clientId === null) return;
    setLoading(true);
    setErr(null);
    listPortalTokens(clientId)
      .then(setRows)
      .catch((e) => setErr(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, [clientId]);

  useEffect(() => {
    setIssued(null);
    load();
  }, [load]);

  const issue = () => {
    if (clientId === null || !label.trim()) return;
    setIssuing(true);
    setErr(null);
    issuePortalToken(clientId, { label: label.trim(), expires_in_days: days })
      .then((t) => {
        setIssued(t);
        setLabel("");
        setCopied(false);
        load();
      })
      .catch((e) => setErr(e?.response?.data?.detail || e.message))
      .finally(() => setIssuing(false));
  };

  const revoke = (id: number) => {
    revokePortalToken(id)
      .then(load)
      .catch((e) => setErr(e?.response?.data?.detail || e.message));
  };

  const link = issued ? `${window.location.origin}/portal?token=${issued.raw_token}` : null;

  const copy = () => {
    if (!link) return;
    navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => setCopied(false));
  };

  return (
    <section className="card p-5 sm:p-6">
      <div className="flex items-baseline gap-3 mb-1 flex-wrap">
        <h2 className="text-base font-semibold flex-1">Client portal links</h2>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-brand-gray">
          needs Client Mgmt
        </span>
      </div>
      <p className="text-sm text-brand-gray mb-4 max-w-2xl">
        A link lets a client see their own projects, RFIs, what we are waiting on from them, and approved
        change orders — nothing else. The link is shown once when issued.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem_auto] items-end mb-5">
        <div>
          <label className="label" htmlFor="cpl-client">Client</label>
          <select
            id="cpl-client"
            className="select select-sm"
            value={clientId ?? ""}
            onChange={(e) => setClientId(Number(e.target.value))}
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="cpl-label">Label</label>
          <input
            id="cpl-label"
            className="select select-sm"
            placeholder="e.g. Utopian — Jane Smith"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
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
        <button className="btn btn-primary" onClick={issue} disabled={issuing || !label.trim() || clientId === null}>
          {issuing ? "Issuing…" : "Issue link"}
        </button>
      </div>

      {err && <p className="text-sm text-brand-red mb-3">{err}</p>}

      {issued && link && (
        <div className="border border-brand-green rounded p-4 mb-5 bg-brand-green/5">
          <div className="text-sm font-semibold mb-1">Link issued for {issued.label}</div>
          <p className="text-xs text-brand-gray mb-2">
            Copy it now — it will not be shown again. Valid until {fmt(issued.expires_at)}.
          </p>
          <div className="flex gap-2 items-center">
            <code className="text-xs bg-surface-mute border border-surface-line rounded px-2 py-1 flex-1 truncate">{link}</code>
            <button className="btn text-xs" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
        </div>
      )}

      <div className="label mb-2">Issued links</div>
      {loading ? (
        <p className="text-sm text-brand-gray">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-brand-gray">No links have been issued for this client.</p>
      ) : (
        <div className="border border-surface-line rounded overflow-hidden">
          {rows.map((r) => (
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
                <span
                  className={clsx(
                    "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded",
                    r.is_live ? "bg-brand-green/15 text-brand-green" : "bg-surface-mute text-brand-gray",
                  )}
                >
                  {r.revoked_at ? "Revoked" : r.is_live ? "Live" : "Expired"}
                </span>
                {r.is_live && (
                  <button className="btn btn-ghost text-xs" onClick={() => revoke(r.id)}>Revoke</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
