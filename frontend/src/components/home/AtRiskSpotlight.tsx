/**
 * AtRiskSpotlight — "⚑ At risk this week" band at the top of Home.
 *
 * One tile per severity (Critical / High / Medium) showing the single most
 * pressing item in that bucket, so a PM opening the app sees what is going
 * wrong before they see any counts.
 *
 * Nothing new is fetched: candidates come from the open risks the risk board
 * already loads plus the overdue/soon-due actions the dashboard rollup already
 * has. Risks outrank actions inside a bucket — a PM flagged them deliberately.
 * Low-likelihood risks stay out of the spotlight (they're still counted on the
 * risk board bar); the card hides entirely when nothing qualifies.
 */
import type { DashboardAction } from "@/lib/types";
import type { DashboardRisk } from "@/lib/api";
import {
  daysOverdue,
  dueLabel,
  riskSeverity,
  type Severity,
} from "./useHomeData";

/** Severities that earn a tile, in the order they're rendered. */
const TILE_SEVERITIES = ["critical", "high", "medium"] as const;
type TileSeverity = (typeof TILE_SEVERITIES)[number];

/** An action is only "at risk this week" once it's late or due inside a week. */
const SOON_DUE_DAYS = 7;
/** A week past due is a different kind of problem than a day past due. */
const CRITICAL_OVERDUE_DAYS = 7;

/* Tints come from the status-* tokens rather than literal washes: those tokens
 * invert with the theme (light tint + dark ink on light, dark tint + light ink
 * on dark), which a near-white wash like #fdf6f6 cannot do. Medium has no
 * status equivalent, so it rides brand-blue at low alpha — same effect, still
 * driven by the themed token. Badges stay solid brand fills: they read as
 * badges on either surface. */
const TILE_STYLES: Record<
  TileSeverity,
  { label: string; box: string; badge: string }
> = {
  critical: {
    label: "Critical",
    box: "border-status-open-border/30 bg-status-open-bg",
    badge: "bg-brand-red text-white",
  },
  high: {
    label: "High",
    box: "border-status-pending-border/30 bg-status-pending-bg",
    // Gold is a light hue in BOTH themes, so its ink stays dark in both.
    badge: "bg-brand-gold text-[#3d3800]",
  },
  medium: {
    label: "Medium",
    box: "border-brand-blue/30 bg-brand-blue/10",
    badge: "bg-brand-blue text-white",
  },
};

interface Candidate {
  severity: TileSeverity;
  /** Portfolio + why it's here, e.g. "Snapdragon · 2d overdue". */
  meta: string;
  text: string;
}

function isTileSeverity(s: Severity): s is TileSeverity {
  return s !== "low";
}

function actionSeverity(dueDate: string): TileSeverity | null {
  const late = daysOverdue(dueDate);
  if (late >= CRITICAL_OVERDUE_DAYS) return "critical";
  if (late >= 1) return "high";
  if (late >= -SOON_DUE_DAYS) return "medium";
  return null;
}

export default function AtRiskSpotlight({
  risks,
  actions,
  onReviewAll,
}: {
  risks: DashboardRisk[];
  actions: DashboardAction[];
  onReviewAll: () => void;
}) {
  const candidates: Candidate[] = [];

  for (const r of risks) {
    const severity = riskSeverity(r.likelihood);
    if (!isTileSeverity(severity)) continue;
    candidates.push({
      severity,
      meta: [r.project_name, r.owner].filter(Boolean).join(" · "),
      text: r.description,
    });
  }
  // Oldest due date first, so the tile for a bucket shows its worst offender.
  const byDueDate = actions
    .filter((a) => a.due_date)
    .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""));
  for (const a of byDueDate) {
    if (!a.due_date) continue;
    const severity = actionSeverity(a.due_date);
    if (!severity) continue;
    candidates.push({
      severity,
      meta: [a.project_name, dueLabel(a.due_date)].filter(Boolean).join(" · "),
      text: a.text,
    });
  }

  const tiles = TILE_SEVERITIES.map((s) =>
    candidates.find((c) => c.severity === s),
  ).filter((c): c is Candidate => Boolean(c));

  if (tiles.length === 0) return null;

  return (
    <section className="card border-t-[3px] border-t-brand-red px-5 py-4">
      <div className="flex flex-wrap items-center gap-2.5 mb-3">
        <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-brand-red">
          ⚑ At risk this week
        </span>
        <span className="text-xs text-brand-gray">
          {candidates.length} item{candidates.length === 1 ? "" : "s"} across
          your portfolios
        </span>
        <button
          type="button"
          onClick={onReviewAll}
          className="ml-auto text-xs font-semibold text-brand-red hover:underline"
        >
          Review all →
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {tiles.map((tile) => {
          const style = TILE_STYLES[tile.severity];
          return (
            <div
              key={tile.severity}
              className={`rounded-lg border px-3.5 py-3 ${style.box}`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span
                  className={`text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${style.badge}`}
                >
                  {style.label}
                </span>
                <span className="text-[11px] text-brand-gray truncate">
                  {tile.meta}
                </span>
              </div>
              <div className="text-[13px] leading-[1.45] text-brand-black">
                {tile.text}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
