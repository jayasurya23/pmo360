import { ReactNode, useEffect, useState } from "react";
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
    <div className="space-y-[22px]">
      <PageHeader
        kicker={
          currentClient?.name
            ? `${currentClient.name} · Portfolio health`
            : "Portfolio health"
        }
        title={currentProject.name}
        actions={
          <>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => nav("/history")}
            >
              Meeting history
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => nav("/capture")}
            >
              Capture minutes
            </button>
          </>
        }
      />

      {loading && !metrics && (
        <div className="card p-6 text-center text-sm text-brand-gray">
          Loading…
        </div>
      )}
      {error && (
        <div className="card p-4 text-sm text-brand-red border-l-[3px] border-l-brand-red">
          {error}
        </div>
      )}

      {metrics && (
        <>
          <TopStatRow metrics={metrics} />
          <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-[22px] items-start">
            <BurndownCard points={metrics.burndown} />
            <RiskBoardCard risks={metrics.risks_by_likelihood} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-[22px] items-start">
            <RecentMeetingsCard
              meetings={meetings.slice(0, 5)}
              onOpen={() => nav("/history")}
            />
            <ChangeOrdersCard
              changeOrders={changeOrders}
              onOpen={() => nav("/change-orders")}
            />
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================
   Shared card furniture
   ============================================================ */
/** Card title row: bold title, muted hint, optional right-aligned action. */
function CardHead({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2.5">
      <h2 className="section-title">{title}</h2>
      {hint && <span className="text-xs text-brand-gray">{hint}</span>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function CardLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-semibold text-brand-red hover:text-brand-darkred hover:underline"
    >
      {children}
    </button>
  );
}

/* ============================================================
   Top stat row
   ============================================================ */
function TopStatRow({ metrics }: { metrics: PortfolioMetrics }) {
  const closePct = Math.round(metrics.action_close_rate * 100);
  const onTimePct = Math.round(metrics.on_time_rate * 100);
  const lastMeetingSub = metrics.last_meeting_date
    ? `Last: ${metrics.days_since_last_meeting} day${
        metrics.days_since_last_meeting === 1 ? "" : "s"
      } ago · ${format(parseISO(metrics.last_meeting_date), "MMM d")}`
    : "No meetings yet";

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
      <StatTile
        label="Total meetings"
        value={metrics.total_meetings}
        sub={lastMeetingSub}
      />
      <StatTile
        label="Open actions"
        value={metrics.open_actions}
        sub={
          metrics.overdue_actions > 0 ? (
            <b className="text-brand-red font-semibold">
              {metrics.overdue_actions} overdue
            </b>
          ) : (
            "None overdue"
          )
        }
      />
      <StatTile
        label="Action close rate"
        value={`${closePct}%`}
        valueTone="green"
        sub={`${metrics.completed_actions} done · ${metrics.total_actions} total`}
      />
      <StatTile
        label="Deliverables on-time"
        value={`${onTimePct}%`}
        valueTone="green"
        sub={`${metrics.deliverables_on_time} / ${metrics.deliverables_total}`}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  valueTone = "default",
}: {
  label: string;
  value: number | string;
  sub?: ReactNode;
  valueTone?: "default" | "green";
}) {
  return (
    <div className="card px-[18px] py-4">
      <div className="text-[11px] uppercase tracking-[0.1em] text-brand-gray font-semibold">
        {label}
      </div>
      <div
        className={`text-[34px] font-bold mt-1.5 leading-tight tabular-nums ${
          valueTone === "green" ? "text-brand-green" : "text-brand-black"
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-brand-gray mt-0.5">{sub}</div>}
    </div>
  );
}

/* ============================================================
   Burndown chart — hand-rolled SVG (8 weekly bars, stacked)
   ============================================================ */
function BurndownCard({ points }: { points: BurndownPoint[] }) {
  const hasAnyData = points.some(
    (p) => p.open_at_end_of_week > 0 || p.completed_this_week > 0,
  );

  return (
    <section className="card px-5 py-4">
      <CardHead title="Action burndown" hint="last 8 weeks" />
      {!hasAnyData ? (
        <p className="text-sm text-brand-gray mt-3">
          No action history yet — once meetings start raising actions, weekly
          open vs. completed counts show up here.
        </p>
      ) : (
        <>
          <div className="mt-2">
            <BurndownChart points={points} />
          </div>
          <Legend />
        </>
      )}
    </section>
  );
}

function BurndownChart({ points }: { points: BurndownPoint[] }) {
  // Chart geometry — generous left padding for y-axis labels, bottom padding
  // for week-of strings, top padding so the tallest bar's number doesn't
  // clip.
  const W = 720;
  const H = 240;
  const padLeft = 36;
  const padRight = 12;
  const padTop = 16;
  const padBottom = 40;
  const innerW = W - padLeft - padRight;
  const innerH = H - padTop - padBottom;
  const bandW = innerW / points.length;
  const barW = Math.min(44, bandW * 0.55);

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
      {/* Y-axis gridlines + labels. The zero line is a gridline like any
          other — the redesign drops the heavier baseline rule. */}
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={padLeft}
            x2={padLeft + innerW}
            y1={padTop + yScale(t)}
            y2={padTop + yScale(t)}
            stroke="#f0efee"
            strokeWidth={1}
          />
          <text
            x={padLeft - 6}
            y={padTop + yScale(t) + 4}
            textAnchor="end"
            fontSize={10}
            fill="#bcbec0"
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
                rx={3}
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
                rx={3}
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
                y={yDone - 6}
                textAnchor="middle"
                fontSize={10}
                fill="#333132"
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
              fill="#4d4d4f"
            >
              {wkLabel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-5 mt-2 text-xs text-brand-gray">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-brand-red" />
        Open at end of week
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-brand-green" />
        Closed this week
      </span>
    </div>
  );
}

/* ============================================================
   Risk board — stacked severity bar + counts
   ============================================================ */
const RISK_ORDER: Array<{
  key: string;
  label: string;
  bar: string;
  countClass: string;
}> = [
  { key: "Critical", label: "critical", bar: "#ad1f2b", countClass: "text-brand-red" },
  { key: "High", label: "high", bar: "#e12a3f", countClass: "text-brand-brightred" },
  { key: "Medium", label: "medium", bar: "#c7bb2e", countClass: "text-brand-deepgold" },
  // Low keeps the inherited muted text — it should not compete for attention.
  { key: "Low", label: "low", bar: "#bcbec0", countClass: "" },
];

function RiskBoardCard({ risks }: { risks: Record<string, number> }) {
  const segments = RISK_ORDER.map((b) => ({
    ...b,
    count: risks[b.key] ?? 0,
  }));
  const total = segments.reduce((s, b) => s + b.count, 0);

  return (
    <section className="card px-5 py-4">
      <CardHead title="Risk board" hint="most recent agenda" />
      {total === 0 ? (
        <p className="text-sm text-brand-gray mt-3">
          No risks captured on the latest pre-meeting agenda yet.
        </p>
      ) : (
        <>
          <div className="flex h-2.5 rounded-[5px] overflow-hidden mt-3">
            {segments.map((seg) =>
              seg.count === 0 ? null : (
                <span
                  key={seg.key}
                  style={{
                    background: seg.bar,
                    width: `${(seg.count / total) * 100}%`,
                  }}
                  title={`${seg.label}: ${seg.count}`}
                />
              ),
            )}
          </div>
          <div className="flex flex-wrap gap-x-3.5 gap-y-1 mt-2 text-[11px] text-brand-gray">
            {segments.map((seg) => (
              <span key={seg.key}>
                <b className={seg.countClass}>{seg.count}</b> {seg.label}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ============================================================
   Recent meetings list
   ============================================================ */
const STAGE_BADGE: Record<string, { label: string; className: string }> = {
  sent: {
    label: "Sent",
    className: "bg-status-completed-bg text-status-completed-text",
  },
  final: { label: "Final", className: "bg-[#d9f0f7] text-brand-deepblue" },
  draft: { label: "Draft", className: "bg-surface-border text-brand-gray" },
};

function StageBadge({ stage }: { stage: string }) {
  const cfg = STAGE_BADGE[stage] || {
    label: stage || "Draft",
    className: "bg-surface-border text-brand-gray",
  };
  return (
    <span
      className={`text-[11px] font-semibold px-2.5 py-[3px] rounded-full ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}

function RecentMeetingsCard({
  meetings,
  onOpen,
}: {
  meetings: Meeting[];
  onOpen: () => void;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="px-5 py-3.5 border-b border-surface-hairline">
        <CardHead
          title="Recent meetings"
          action={
            meetings.length > 0 ? (
              <CardLink onClick={onOpen}>All in History →</CardLink>
            ) : undefined
          }
        />
      </div>
      {meetings.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-brand-gray">
          No meetings yet — capture one to start populating this portfolio.
        </p>
      ) : (
        meetings.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={onOpen}
            className="w-full text-left px-5 py-3 grid grid-cols-[1fr_auto_auto] gap-3.5 items-center
              border-b border-surface-page last:border-b-0 hover:bg-surface-rowhover transition"
          >
            <span>
              <span className="block text-sm font-medium text-brand-black">
                {m.title || "(no title)"}
              </span>
              <span className="block text-xs text-brand-gray mt-px">
                {format(parseISO(m.meeting_date), "EEE, MMM d, yyyy")}
              </span>
            </span>
            <StageBadge stage={m.stage} />
            <span className="text-brand-lightgray">›</span>
          </button>
        ))
      )}
    </section>
  );
}

/* ============================================================
   Change orders rollup — pending / approved value + counts
   ============================================================ */
const dashMoney = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function ChangeOrdersCard({
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

  const coCount = (n: number) => `${n} CO${n === 1 ? "" : "s"}`;

  return (
    <section className="card px-5 py-4">
      <CardHead
        title="Change orders"
        action={<CardLink onClick={onOpen}>Open →</CardLink>}
      />
      {changeOrders.length === 0 ? (
        <p className="text-sm text-brand-gray mt-3">
          No change orders yet — raise one from the Change Orders tab, or start
          one from a meeting on the Review page.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5 mt-3">
          <CoStatBox
            label="Approved value"
            value={dashMoney(sumOf("approved"))}
            valueClass="text-brand-green"
            note={coCount(countOf("approved"))}
          />
          <CoStatBox
            label="Pending approval"
            value={dashMoney(sumOf("pending"))}
            valueClass="text-brand-deepgold"
            note={coCount(countOf("pending"))}
          />
          <CoStatBox
            label="Drafts"
            value={countOf("draft")}
            note="not yet submitted"
          />
        </div>
      )}
    </section>
  );
}

function CoStatBox({
  label,
  value,
  note,
  valueClass = "text-brand-black",
}: {
  label: string;
  value: number | string;
  note: string;
  valueClass?: string;
}) {
  return (
    <div className="border border-surface-border rounded-lg px-3.5 py-3 flex items-baseline justify-between gap-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.08em] text-brand-gray font-semibold">
          {label}
        </div>
        <div
          className={`text-[22px] font-bold leading-tight tabular-nums ${valueClass}`}
        >
          {value}
        </div>
      </div>
      <span className="text-[11px] text-brand-gray whitespace-nowrap">
        {note}
      </span>
    </div>
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
