/**
 * RisksCard — the "Risk board" panel on Home.
 *
 * Flattens every portfolio's most-recent agenda risks into one list: a stacked
 * severity bar for the shape of the week, then the most urgent rows. The
 * motivation: PMs report to leadership weekly on risks but there's no
 * aggregated view otherwise — they'd have to open each portfolio's agenda one
 * at a time. Clicking a row deep-links to the agenda it came from.
 *
 * The data is fetched once by Home (see useHomeData) and shared with the
 * at-risk spotlight, which leads with the same risks.
 *
 * Hidden entirely when the fetch returns zero risks — no need to take up
 * vertical space on calm portfolios.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";

import { useApp } from "@/lib/state";
import type { DashboardRisk } from "@/lib/api";
import { nameToSlug } from "@/lib/slugs";
import { riskSeverity, SEVERITY_ORDER, type Severity } from "./useHomeData";

/** The board leads with the two most urgent risks; the rest are one click away. */
const VISIBLE_LIMIT_DEFAULT = 2;

const SEVERITY_META: Record<
  Severity,
  { label: string; bar: string; text: string }
> = {
  critical: { label: "Critical", bar: "bg-brand-red", text: "text-brand-red" },
  high: {
    label: "High",
    bar: "bg-brand-brightred",
    text: "text-brand-brightred",
  },
  medium: {
    label: "Medium",
    bar: "bg-brand-gold",
    text: "text-brand-deepgold",
  },
  low: { label: "Low", bar: "bg-brand-lightgray", text: "text-brand-black" },
};

export default function RisksCard({
  risks,
  loading,
}: {
  risks: DashboardRisk[];
  loading: boolean;
}) {
  const { clients } = useApp();
  const nav = useNavigate();
  const [showAll, setShowAll] = useState(false);

  if (!loading && risks.length === 0) return null;

  const visible = showAll ? risks : risks.slice(0, VISIBLE_LIMIT_DEFAULT);
  const overflow = risks.length - visible.length;
  const counts = SEVERITY_ORDER.map((s) => ({
    severity: s,
    count: risks.filter((r) => riskSeverity(r.likelihood) === s).length,
  }));

  const openAgenda = (r: DashboardRisk) => {
    // Same deep-link pattern the Home agendas rollup uses.
    const clientObj = r.client_name
      ? clients.find((c) => c.name === r.client_name)
      : null;
    const params = new URLSearchParams();
    if (clientObj) params.set("client", nameToSlug(clientObj.name));
    params.set("portfolio", nameToSlug(r.project_name));
    params.set("agenda", String(r.agenda_id));
    nav(`/next-agenda?${params.toString()}`);
  };

  return (
    <section className="card px-5 py-4">
      <div className="flex items-center gap-2">
        <h2 className="section-title">Risk board</h2>
        <span className="text-xs text-brand-gray">latest agendas</span>
        <button
          type="button"
          onClick={() => nav("/next-agenda")}
          className="ml-auto text-xs font-semibold text-brand-red hover:underline"
        >
          Agendas →
        </button>
      </div>

      {loading && risks.length === 0 ? (
        <div className="mt-3 text-sm text-brand-gray italic">Loading…</div>
      ) : (
        <>
          <SeverityBar counts={counts} total={risks.length} />

          <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[11px] text-brand-gray">
            {counts.map(({ severity, count }) => (
              <span key={severity}>
                <b className={SEVERITY_META[severity].text}>{count}</b>{" "}
                {SEVERITY_META[severity].label.toLowerCase()}
              </span>
            ))}
          </div>

          <div className="mt-3">
            {visible.map((r, i) => (
              <RiskRow
                key={`${r.agenda_id}-${i}-${r.description.slice(0, 20)}`}
                risk={r}
                onOpen={() => openAgenda(r)}
              />
            ))}
          </div>

          {overflow > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-2.5 text-xs font-semibold text-brand-gray hover:text-brand-red"
            >
              Show {overflow} more
            </button>
          )}
          {showAll && risks.length > VISIBLE_LIMIT_DEFAULT && (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="mt-2.5 text-xs font-semibold text-brand-gray hover:text-brand-red"
            >
              Show less
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** Stacked proportional bar — one segment per severity that has risks. */
function SeverityBar({
  counts,
  total,
}: {
  counts: { severity: Severity; count: number }[];
  total: number;
}) {
  if (total === 0) return null;
  return (
    <div className="mt-3 flex h-2.5 rounded-[5px] overflow-hidden bg-surface-mute">
      {counts
        .filter((c) => c.count > 0)
        .map((c) => (
          <span
            key={c.severity}
            className={SEVERITY_META[c.severity].bar}
            style={{ width: `${(c.count / total) * 100}%` }}
            title={`${c.count} ${SEVERITY_META[c.severity].label.toLowerCase()}`}
          />
        ))}
    </div>
  );
}

function RiskRow({
  risk,
  onOpen,
}: {
  risk: DashboardRisk;
  onOpen: () => void;
}) {
  const severity = riskSeverity(risk.likelihood);
  const meta = [
    risk.project_name,
    risk.owner,
    risk.impact ? `impact: ${risk.impact}` : null,
    risk.mitigation ? `mitigation: ${risk.mitigation}` : null,
    `agenda ${format(parseISO(risk.upcoming_date), "MMM d")}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      onClick={onOpen}
      // The negative inset lets the hover tint bleed to the card's padding edge
      // while the hairline still lines up with the text column.
      className="block w-full text-left -mx-2 px-2 pt-2.5 pb-2 mt-2 first:mt-0 border-t border-surface-hairline hover:bg-surface-rowhover transition"
    >
      <div className="text-[13px] leading-[1.5] text-brand-black">
        <b className={SEVERITY_META[severity].text}>
          {SEVERITY_META[severity].label}:
        </b>{" "}
        {risk.description}
      </div>
      <div className="text-[11px] text-brand-gray mt-0.5 truncate">{meta}</div>
    </button>
  );
}
