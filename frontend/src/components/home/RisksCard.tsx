/**
 * RisksCard — "🚨 Open risks across portfolios" rollup on Home.
 *
 * Pulls every portfolio's most-recent agenda, flattens their risks_json,
 * and surfaces them in a single sortable list. The motivation: PMs report
 * to leadership weekly on risks but there's no aggregated view today —
 * they have to open each portfolio's agenda one at a time.
 *
 * Scope follows the Mine/All toggle:
 *   - "Mine"  → risks from portfolios where the signed-in non-admin user is
 *               a member.
 *   - "All"   → every portfolio. Default for admins.
 *
 * Likelihood drives the badge color (Critical=red, High=amber, Medium=blue,
 * Low=grey, blank=grey). Sorted server-side so the most-urgent items lead.
 *
 * Hidden entirely when:
 *   - user isn't signed in (the endpoint requires auth)
 *   - the fetch returns zero risks (no need to take up vertical space on
 *     calm portfolios)
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";

import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";
import { fetchOpenRisks, type DashboardRisk } from "@/lib/api";
import { nameToSlug } from "@/lib/slugs";

const VISIBLE_LIMIT_DEFAULT = 5;

export default function RisksCard() {
  const { isAuthenticated } = useAuth();
  const { scope, me, clients } = useApp();
  const nav = useNavigate();

  const [risks, setRisks] = useState<DashboardRisk[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // We honour the Mine/All scope toggle when the user is signed in and not
  // an admin. Admins + anonymous fall through to "all" regardless — same
  // pattern the dashboard endpoints use.
  const effectiveScope: "mine" | "all" =
    scope === "mine" && me !== null && !me.is_admin ? "mine" : "all";

  const load = useCallback(() => {
    if (!isAuthenticated) {
      setRisks([]);
      return;
    }
    setLoading(true);
    fetchOpenRisks(effectiveScope)
      .then(setRisks)
      .catch(() => setRisks([]))
      .finally(() => setLoading(false));
  }, [isAuthenticated, effectiveScope]);

  useEffect(() => {
    load();
  }, [load]);

  // Hide entirely when there's nothing to show — keeps Home uncluttered
  // for portfolios where the PM has actually addressed everything.
  if (!isAuthenticated) return null;
  if (!loading && risks.length === 0) return null;

  const visible = showAll ? risks : risks.slice(0, VISIBLE_LIMIT_DEFAULT);
  const overflow = risks.length - visible.length;

  return (
    <section className="card p-5 border-l-4 border-l-rose-500">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
            🚨 Open risks
          </div>
          <div className="text-base font-semibold text-brand-black mt-1">
            Across {effectiveScope === "mine" ? "your" : "all"} portfolios
          </div>
        </div>
        <div className="text-xs text-brand-gray tabular-nums">
          {risks.length} total
        </div>
      </div>

      {loading && risks.length === 0 ? (
        <div className="text-sm text-brand-gray italic">Loading…</div>
      ) : (
        <div className="space-y-2">
          {visible.map((r, i) => (
            <RiskRow
              key={`${r.agenda_id}-${i}-${r.description.slice(0, 20)}`}
              risk={r}
              onOpen={() => {
                // Navigate to the source agenda — same deep-link pattern
                // the Home agendas rollup uses.
                const clientObj = r.client_name
                  ? clients.find((c) => c.name === r.client_name)
                  : null;
                const params = new URLSearchParams();
                if (clientObj) params.set("client", nameToSlug(clientObj.name));
                params.set("portfolio", nameToSlug(r.project_name));
                params.set("agenda", String(r.agenda_id));
                nav(`/next-agenda?${params.toString()}`);
              }}
            />
          ))}
        </div>
      )}

      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-3 text-xs text-brand-gray hover:text-brand-black underline"
        >
          Show {overflow} more
        </button>
      )}
      {showAll && risks.length > VISIBLE_LIMIT_DEFAULT && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="mt-3 text-xs text-brand-gray hover:text-brand-black underline ml-3"
        >
          Show less
        </button>
      )}
    </section>
  );
}


function RiskRow({
  risk,
  onOpen,
}: {
  risk: DashboardRisk;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left card px-4 py-2.5 hover:border-brand-red transition flex items-start gap-3"
    >
      <LikelihoodPill value={risk.likelihood} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-brand-black">
          {risk.description}
        </div>
        <div className="text-xs text-brand-gray mt-0.5 truncate">
          {risk.client_name && (
            <>
              {risk.client_name}
              <span className="px-1">/</span>
            </>
          )}
          <span className="font-medium">{risk.project_name}</span>
          {risk.owner && (
            <>
              <span className="px-1.5 text-brand-lightgray">·</span>
              <span>{risk.owner}</span>
            </>
          )}
          {risk.impact && (
            <>
              <span className="px-1.5 text-brand-lightgray">·</span>
              <span>Impact: {risk.impact}</span>
            </>
          )}
          <span className="px-1.5 text-brand-lightgray">·</span>
          <span>Agenda {format(parseISO(risk.upcoming_date), "MMM d")}</span>
        </div>
        {risk.mitigation && (
          <div className="text-[11px] text-brand-gray mt-1 italic truncate">
            Mitigation: {risk.mitigation}
          </div>
        )}
      </div>
    </button>
  );
}


function LikelihoodPill({ value }: { value: string | null }) {
  const key = (value || "").toLowerCase();
  const map: Record<string, { bg: string; text: string; label: string }> = {
    critical: { bg: "#fce4e6", text: "#9b1c2a", label: "Critical" },
    high: { bg: "#fde7c8", text: "#8a4a13", label: "High" },
    medium: { bg: "#dbeaf7", text: "#1f4d7a", label: "Medium" },
    low: { bg: "#e6e7e8", text: "#4d4d4f", label: "Low" },
  };
  const cfg = map[key] || { bg: "#e6e7e8", text: "#4d4d4f", label: value || "—" };
  return (
    <span
      className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded shrink-0"
      style={{ background: cfg.bg, color: cfg.text }}
      title={value ? `Likelihood: ${cfg.label}` : "Likelihood not set"}
    >
      {cfg.label}
    </span>
  );
}
