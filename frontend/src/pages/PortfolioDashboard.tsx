import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { listMeetings, fetchPortfolioMetrics, listChangeOrders } from "@/lib/api";
import type { PortfolioMetrics, BurndownPoint } from "@/lib/api";
import type { Meeting, ChangeOrder } from "@/lib/types";
import { useApp } from "@/lib/state";

/**
 * Per-portfolio health snapshot. Backed by GET /api/projects/:id/metrics — a
 * single fat endpoint that rolls up the top-row stats, 8-week action
 * burndown, and the latest agenda's risk heatmap. Five most recent meetings
 * live in their own list and use `listMeetings` (already cached by
 * History).
 */
export default function PortfolioDashboard() {
  const { currentProject, currentClient } = useApp();
  const nav = useNavigate();
  const [metrics, setMetrics] = useState<PortfolioMetrics | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentProject) {
      setMetrics(null);
      setMeetings([]);
      setChangeOrders([]);
      return;
    }
    setLoading(true);
    setError(null);
    Promise.all([
      fetchPortfolioMetrics(currentProject.id),
      listMeetings(currentProject.id),
      // COs are a soft add-on — never fail the whole dashboard if they error.
      listChangeOrders(currentProject.id).catch(() => [] as ChangeOrder[]),
    ])
      .then(([m, mts, cos]) => {
        setMetrics(m);
        setMeetings(mts);
        setChangeOrders(cos);
      })
      .catch((e) => setError(e?.message || "Failed to load metrics"))
      .finally(() => setLoading(false));
  }, [currentProject?.id]);

  if (!currentProject) {
    return (
      <EmptyState
        title="Pick a client and portfolio first"
        hint="Use the context switcher under the nav bar to choose where this dashboard belongs."
      />
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Portfolio dashboard · ${currentProject.name}`}
        subtitle={currentClient?.name || undefined}
      />

      {loading && !metrics && (
        <div className="card p-6 text-center text-sm text-brand-gray">
          Loading…
        </div>
      )}
      {error && (
        <div className="card p-4 text-sm text-brand-red border-l-4 border-l-brand-red">
          {error}
        </div>
      )}

      {metrics && (
        <>
          <TopStatRow metrics={metrics} />
          <BurndownSection points={metrics.burndown} />
          <RisksSection risks={metrics.risks_by_likelihood} />
          <RecentMeetingsSection
            meetings={meetings.slice(0, 5)}
            onOpen={() => nav("/history")}
          />
          <ChangeOrdersSection
            changeOrders={changeOrders}
            onOpen={() => nav("/change-orders")}
          />
        </>
      )}
    </div>
  );
}

/* ============================================================
   Top stat row
   ============================================================ */
function TopStatRow({ metrics }: { metrics: PortfolioMetrics }) {
  const closePct = Math.round(metrics.action_close_rate * 100);
  const onTimePct = Math.round(metrics.on_time_rate * 100);
  const lastMeetingSub = metrics.last_meeting_date
    ? `${metrics.days_since_last_meeting} day${
        metrics.days_since_last_meeting === 1 ? "" : "s"
      } ago · ${format(parseISO(metrics.last_meeting_date), "MMM d")}`
    : "No meetings yet";

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      <StatCard
        label="Total meetings"
        value={metrics.total_meetings}
        subtitle={lastMeetingSub}
        accent="red"
      />
      <StatCard
        label="Open actions"
        value={metrics.open_actions}
        subtitle={
          metrics.overdue_actions > 0
            ? `${metrics.overdue_actions} overdue`
            : "None overdue"
        }
        subtitleAccent={metrics.overdue_actions > 0 ? "red" : "muted"}
        accent="gold"
      />
      <StatCard
        label="Action close rate"
        value={`${closePct}%`}
        subtitle={`${metrics.completed_actions} done · ${metrics.total_actions} total`}
        accent="green"
      />
      <StatCard
        label="Deliverables on-time"
        value={`${onTimePct}%`}
        subtitle={`${metrics.deliverables_on_time} / ${metrics.deliverables_total}`}
        accent="green"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  subtitle,
  accent,
  subtitleAccent = "muted",
}: {
  label: string;
  value: number | string;
  subtitle?: string;
  accent: "red" | "gold" | "green";
  subtitleAccent?: "muted" | "red";
}) {
  const accentClass = {
    red: "border-l-brand-red",
    gold: "border-l-brand-gold",
    green: "border-l-brand-green",
  }[accent];
  const subColor =
    subtitleAccent === "red" ? "text-brand-red" : "text-brand-gray";
  return (
    <div className={`card p-5 border-l-4 ${accentClass}`}>
      <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
        {label}
      </div>
      <div className="text-4xl font-bold text-brand-black mt-2 tabular-nums">
        {value}
      </div>
      {subtitle && (
        <div className={`text-xs mt-1 ${subColor}`}>{subtitle}</div>
      )}
    </div>
  );
}

/* ============================================================
   Change orders rollup — pending / approved value + counts
   ============================================================ */
const dashMoney = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function ChangeOrdersSection({
  changeOrders,
  onOpen,
}: {
  changeOrders: ChangeOrder[];
  onOpen: () => void;
}) {
  const countOf = (s: ChangeOrder["status"]) =>
    changeOrders.filter((c) => c.status === s).length;
  const sumOf = (s: ChangeOrder["status"]) =>
    changeOrders
      .filter((c) => c.status === s)
      .reduce((acc, c) => acc + (Number(c.total_amount) || 0), 0);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="section-title">Change orders</h2>
        <button
          type="button"
          onClick={onOpen}
          className="text-xs font-semibold text-brand-red hover:underline"
        >
          Open change orders →
        </button>
      </div>
      {changeOrders.length === 0 ? (
        <div className="card p-8 text-center text-sm text-brand-gray">
          No change orders yet — raise one from the Change Orders tab, or start
          one from a meeting on the Review page.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <CoStat
            label="Approved value"
            count={countOf("approved")}
            amount={sumOf("approved")}
            accent="green"
          />
          <CoStat
            label="Pending approval"
            count={countOf("pending")}
            amount={sumOf("pending")}
            accent="gold"
          />
          <CoStat
            label="Drafts"
            count={countOf("draft")}
            amount={null}
            accent="red"
          />
        </div>
      )}
    </section>
  );
}

function CoStat({
  label,
  count,
  amount,
  accent,
}: {
  label: string;
  count: number;
  amount: number | null;
  accent: "red" | "gold" | "green";
}) {
  const accentClass = {
    red: "border-l-brand-red",
    gold: "border-l-brand-gold",
    green: "border-l-brand-green",
  }[accent];
  return (
    <div className={`card p-5 border-l-4 ${accentClass}`}>
      <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
        {label}
      </div>
      <div className="text-4xl font-bold text-brand-black mt-2 tabular-nums">
        {amount != null ? dashMoney(amount) : count}
      </div>
      <div className="text-xs mt-1 text-brand-gray">
        {amount != null
          ? `${count} change order${count === 1 ? "" : "s"}`
          : `${count} not yet submitted`}
      </div>
    </div>
  );
}

/* ============================================================
   Burndown chart — hand-rolled SVG (8 weekly bars, stacked)
   ============================================================ */
function BurndownSection({ points }: { points: BurndownPoint[] }) {
  const hasAnyData = points.some(
    (p) => p.open_at_end_of_week > 0 || p.completed_this_week > 0,
  );

  return (
    <section>
      <h2 className="section-title mb-3">Action burndown · last 8 weeks</h2>
      {!hasAnyData ? (
        <div className="card p-8 text-center text-sm text-brand-gray">
          No action history yet — once meetings start raising actions, weekly
          open vs. completed counts show up here.
        </div>
      ) : (
        <div className="card p-5">
          <BurndownChart points={points} />
          <Legend />
        </div>
      )}
    </section>
  );
}

function BurndownChart({ points }: { points: BurndownPoint[] }) {
  // Chart geometry — generous left padding for y-axis labels, bottom padding
  // for week-of strings, top padding so the tallest bar's number doesn't
  // clip.
  const W = 720;
  const H = 260;
  const padLeft = 36;
  const padRight = 12;
  const padTop = 16;
  const padBottom = 40;
  const innerW = W - padLeft - padRight;
  const innerH = H - padTop - padBottom;
  const bandW = innerW / points.length;
  const barW = Math.min(48, bandW * 0.6);

  const maxStack = Math.max(
    1,
    ...points.map((p) => p.open_at_end_of_week + p.completed_this_week),
  );
  // Round up to a nice tick boundary.
  const yMax = niceCeil(maxStack);
  const yTicks = ticks(yMax, 4);

  const yScale = (v: number) => innerH - (v / yMax) * innerH;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Action burndown for the last 8 weeks"
    >
      {/* Y-axis gridlines + labels */}
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={padLeft}
            x2={padLeft + innerW}
            y1={padTop + yScale(t)}
            y2={padTop + yScale(t)}
            stroke="#e5e7eb"
            strokeWidth={1}
          />
          <text
            x={padLeft - 6}
            y={padTop + yScale(t) + 4}
            textAnchor="end"
            fontSize={10}
            fill="#6b7280"
          >
            {t}
          </text>
        </g>
      ))}

      {/* Bars + x-axis labels */}
      {points.map((p, i) => {
        const cx = padLeft + bandW * i + bandW / 2;
        const xBar = cx - barW / 2;
        const openH = (p.open_at_end_of_week / yMax) * innerH;
        const doneH = (p.completed_this_week / yMax) * innerH;
        const yOpen = padTop + innerH - openH;
        const yDone = yOpen - doneH;
        const wkLabel = format(parseISO(p.week_start), "M/d");
        const total = p.open_at_end_of_week + p.completed_this_week;
        return (
          <g key={p.week_start}>
            {/* Open (brand red) bottom segment */}
            {openH > 0 && (
              <rect
                x={xBar}
                y={yOpen}
                width={barW}
                height={openH}
                fill="#ad1f2b"
                rx={2}
              >
                <title>
                  Week of {wkLabel} — {p.open_at_end_of_week} open
                </title>
              </rect>
            )}
            {/* Completed-this-week (green) stacked on top */}
            {doneH > 0 && (
              <rect
                x={xBar}
                y={yDone}
                width={barW}
                height={doneH}
                fill="#278747"
                rx={2}
              >
                <title>
                  Week of {wkLabel} — {p.completed_this_week} closed
                </title>
              </rect>
            )}
            {/* Total label above bar */}
            {total > 0 && (
              <text
                x={cx}
                y={yDone - 4}
                textAnchor="middle"
                fontSize={10}
                fill="#1a1a1a"
                fontWeight={600}
              >
                {total}
              </text>
            )}
            {/* X-axis label */}
            <text
              x={cx}
              y={padTop + innerH + 16}
              textAnchor="middle"
              fontSize={10}
              fill="#6b7280"
            >
              {wkLabel}
            </text>
          </g>
        );
      })}

      {/* Axis lines */}
      <line
        x1={padLeft}
        x2={padLeft + innerW}
        y1={padTop + innerH}
        y2={padTop + innerH}
        stroke="#bcbec0"
        strokeWidth={1}
      />
    </svg>
  );
}

function Legend() {
  return (
    <div className="flex items-center justify-center gap-6 mt-3 text-xs text-brand-gray">
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-sm"
          style={{ background: "#ad1f2b" }}
        />
        Open at end of week
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="inline-block h-3 w-3 rounded-sm"
          style={{ background: "#278747" }}
        />
        Closed this week
      </span>
    </div>
  );
}

/* ============================================================
   Risks heatmap — stacked horizontal bar with numeric labels
   ============================================================ */
const RISK_ORDER: Array<{
  key: string;
  label: string;
  color: string;
}> = [
  { key: "Critical", label: "Critical", color: "#ad1f2b" }, // brand red
  { key: "High", label: "High", color: "#e07a1f" },          // orange
  { key: "Medium", label: "Medium", color: "#c7bb2e" },      // brand gold
  { key: "Low", label: "Low", color: "#9ca3af" },            // gray
];

function RisksSection({ risks }: { risks: Record<string, number> }) {
  const segments = RISK_ORDER.map((b) => ({
    ...b,
    count: risks[b.key] ?? 0,
  }));
  const total = segments.reduce((s, b) => s + b.count, 0);

  return (
    <section>
      <h2 className="section-title mb-3">
        Risks · most recent agenda
      </h2>
      {total === 0 ? (
        <div className="card p-8 text-center text-sm text-brand-gray">
          No risks captured on the latest pre-meeting agenda yet.
        </div>
      ) : (
        <div className="card p-5">
          <div className="flex w-full h-9 rounded-md overflow-hidden border border-brand-lightgray/60">
            {segments.map((seg) => {
              if (seg.count === 0) return null;
              const pct = (seg.count / total) * 100;
              return (
                <div
                  key={seg.key}
                  className="flex items-center justify-center text-xs font-semibold text-white"
                  style={{ background: seg.color, width: `${pct}%` }}
                  title={`${seg.label}: ${seg.count}`}
                >
                  {seg.count}
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-center gap-5 mt-3 text-xs text-brand-gray flex-wrap">
            {segments.map((seg) => (
              <span key={seg.key} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ background: seg.color }}
                />
                {seg.label} · {seg.count}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/* ============================================================
   Recent meetings list
   ============================================================ */
function RecentMeetingsSection({
  meetings,
  onOpen,
}: {
  meetings: Meeting[];
  onOpen: () => void;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="section-title">Recent meetings</h2>
        {meetings.length > 0 && (
          <button
            type="button"
            onClick={onOpen}
            className="text-xs font-semibold text-brand-red hover:underline"
          >
            View all in History →
          </button>
        )}
      </div>
      {meetings.length === 0 ? (
        <div className="card p-8 text-center text-sm text-brand-gray">
          No meetings yet — capture one to start populating this portfolio.
        </div>
      ) : (
        <div className="card divide-y divide-brand-lightgray/60">
          {meetings.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={onOpen}
              className="w-full text-left px-5 py-3 hover:bg-brand-nearwhite/40 grid grid-cols-[1fr_auto] gap-4 items-center"
            >
              <div>
                <div className="text-sm font-medium text-brand-black">
                  {m.title || "(no title)"}
                </div>
                <div className="text-xs text-brand-gray mt-1">
                  Stage: <span className="font-semibold">{m.stage}</span>
                </div>
              </div>
              <div className="text-sm text-brand-red font-semibold">
                {format(parseISO(m.meeting_date), "EEE, MMM d, yyyy")}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/* ============================================================
   Tiny chart math helpers
   ============================================================ */
function niceCeil(v: number): number {
  if (v <= 1) return 1;
  if (v <= 5) return 5;
  if (v <= 10) return 10;
  // Round up to nearest 5
  return Math.ceil(v / 5) * 5;
}

function ticks(max: number, count: number): number[] {
  // count + 1 evenly spaced ticks (including 0 and max), integers only.
  const step = max / count;
  const out: number[] = [];
  for (let i = 0; i <= count; i++) {
    out.push(Math.round(step * i));
  }
  // Dedupe in case of small max producing repeats.
  return Array.from(new Set(out));
}
