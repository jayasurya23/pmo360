import { ReactNode, useEffect, useState } from "react";
import { fetchMondayKpis } from "@/lib/api";
import type {
  MondayBoardKpis,
  MondayMeasure,
  MondayPortfolioKpis,
} from "@/lib/api";

/**
 * Schedule / QC / effort KPIs pulled from the linked monday.com board.
 *
 * The whole section is built around one rule: **a missing number is never
 * drawn as zero.** monday's formula columns return blanks for work that
 * hasn't happened, and rendering those as "0%" would tell a PM that every
 * task shipped late when the truth is that nothing has shipped at all.
 * `MondayMeasure.value === null` therefore renders as an em-dash with the
 * reason underneath, and each tile shows the denominator it was computed
 * from so a rate over 3 tasks can't be mistaken for a rate over 400.
 *
 * Read-only: nothing here writes back to monday.
 */
export default function MondayKpiSection({
  projectId,
}: {
  projectId: number;
}) {
  const [data, setData] = useState<MondayPortfolioKpis | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    fetchMondayKpis(projectId, refresh)
      .then(setData)
      .catch((e) =>
        setError(
          e?.response?.data?.detail || e?.message || "Could not reach monday.com",
        ),
      )
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  };

  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Integration switched off entirely — stay silent rather than nagging on
  // every portfolio dashboard.
  if (!loading && data && !data.configured) return null;

  if (loading && !data) {
    return (
      <section className="card px-5 py-4">
        <SectionHead title="monday.com" />
        <p className="text-sm text-brand-gray mt-3">Loading board KPIs…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="card px-5 py-4 border-l-[3px] border-l-brand-red">
        <SectionHead title="monday.com" />
        <p className="text-sm text-brand-red mt-3">{error}</p>
        <button type="button" className="btn-ghost mt-3" onClick={() => load(true)}>
          Retry
        </button>
      </section>
    );
  }

  if (!data) return null;

  if (!data.linked || data.boards.length === 0) {
    return (
      <section className="card px-5 py-4">
        <SectionHead title="monday.com" />
        <p className="text-sm text-brand-gray mt-3">
          {data.message ??
            "No monday.com board is linked to this portfolio yet."}
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-[22px]">
      {data.boards.map((board) => (
        <BoardKpiCard
          key={board.board_id}
          board={board}
          lastSyncedAt={data.last_synced_at}
          refreshing={refreshing}
          onRefresh={() => load(true)}
        />
      ))}
    </div>
  );
}

function SectionHead({
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

function BoardKpiCard({
  board,
  lastSyncedAt,
  refreshing,
  onRefresh,
}: {
  board: MondayBoardKpis;
  lastSyncedAt: string | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { schedule, qc, effort } = board;

  return (
    <section className="card px-5 py-4">
      <SectionHead
        title={board.board_name || `Board ${board.board_id}`}
        hint={
          lastSyncedAt
            ? `monday.com · synced ${new Date(lastSyncedAt).toLocaleString()}`
            : "monday.com"
        }
        action={
          <button
            type="button"
            className="text-xs font-semibold text-brand-red hover:text-brand-darkred hover:underline disabled:opacity-50"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Syncing…" : "Sync now"}
          </button>
        }
      />

      {/* The board can be fully built out yet completely unworked. Saying so
          plainly beats showing a grid of zeros that reads as failure. */}
      {!board.has_execution_data && (
        <div className="mt-3 rounded-md bg-brand-nearwhite border border-brand-lightgray px-3.5 py-3">
          <p className="text-sm text-brand-black font-semibold">
            Tracking hasn&apos;t started on this board yet.
          </p>
          <p className="text-xs text-brand-gray mt-1">
            All {schedule.total_tasks} tasks are still unstarted, so schedule,
            QC and effort KPIs have nothing to measure. They&apos;ll populate as
            the team moves tasks through the board.
          </p>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <MeasureTile
          label="Tasks complete"
          measure={schedule.completion_rate}
          format="percent"
          sub={`${schedule.completed_tasks} of ${schedule.countable_tasks} in scope`}
        />
        <MeasureTile
          label="On-time delivery"
          measure={schedule.on_time_rate}
          format="percent"
          emptyHint="No tasks delivered yet"
        />
        <MeasureTile
          label="Schedule variance"
          measure={schedule.avg_schedule_variance_days}
          format="days"
          // Negative = took longer than planned, per monday's own formula
          // (planned duration − actual duration).
          tone={
            schedule.avg_schedule_variance_days.value === null
              ? "default"
              : schedule.avg_schedule_variance_days.value >= 0
                ? "green"
                : "red"
          }
          emptyHint="No completed tasks to compare"
        />
        <MeasureTile
          label="Overdue"
          rawValue={schedule.overdue_tasks}
          tone={schedule.overdue_tasks > 0 ? "red" : "default"}
          sub={`${schedule.blocked_tasks} blocked · ${schedule.in_progress_tasks} in progress`}
        />
      </div>

      <div className="mt-3.5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <MeasureTile
          label="QC cycle time"
          measure={qc.avg_cycle_days}
          format="days"
          sub={`${qc.tasks_qc_complete} reviewed · ${qc.awaiting_qc} waiting`}
          emptyHint="No QC rounds recorded"
        />
        <MeasureTile
          label="Targeted hours"
          measure={effort.planned_hours_total}
          format="hours"
        />
        <MeasureTile
          label="Actual hours"
          measure={effort.actual_hours_total}
          format="hours"
          emptyHint="No time tracked yet"
        />
        <MeasureTile
          label="Cost ratio"
          rawValue={effort.cost_ratio}
          format="ratio"
          tone={
            effort.cost_ratio === null
              ? "default"
              : effort.cost_ratio > 1
                ? "red"
                : "green"
          }
          sub="Actual ÷ billable"
          emptyHint="No cost data yet"
        />
      </div>

      {Object.keys(schedule.by_phase).length > 0 && (
        <PhaseTable byPhase={schedule.by_phase} />
      )}

      {board.data_quality.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-[0.1em] text-brand-gray font-semibold">
            Data quality
          </div>
          <ul className="mt-1.5 space-y-1">
            {board.data_quality.map((note, i) => (
              <li key={i} className="text-xs text-brand-gray leading-relaxed">
                • {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Phase breakdown — the design gates Castillo actually runs projects by. */
function PhaseTable({
  byPhase,
}: {
  byPhase: MondayBoardKpis["schedule"]["by_phase"];
}) {
  // Board group order, not alphabetical — a PM reads these as a sequence.
  const ORDER = [
    "Project Initiation",
    "Due Diligence",
    "10%",
    "30%",
    "60%",
    "90%",
    "IFC",
    "Record Drawings",
  ];
  const entries = Object.entries(byPhase).sort((a, b) => {
    const ai = ORDER.indexOf(a[0]);
    const bi = ORDER.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-brand-gray">
            <th className="pb-1.5 font-semibold">Phase</th>
            <th className="pb-1.5 font-semibold text-right">Complete</th>
            <th className="pb-1.5 font-semibold text-right">Tasks</th>
            <th className="pb-1.5 font-semibold text-right">Avg variance</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([phase, roll]) => (
            <tr key={phase} className="border-t border-brand-lightgray/50">
              <td className="py-1.5">{phase}</td>
              <td className="py-1.5 text-right tabular-nums">
                {roll.completed}
              </td>
              <td className="py-1.5 text-right tabular-nums text-brand-gray">
                {roll.total}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {roll.avg_schedule_variance_days.value === null ? (
                  <span className="text-brand-gray">—</span>
                ) : (
                  `${roll.avg_schedule_variance_days.value.toFixed(1)}d`
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatValue(
  value: number,
  format: "percent" | "days" | "hours" | "ratio" | "count",
): string {
  switch (format) {
    case "percent":
      return `${Math.round(value * 100)}%`;
    case "days":
      return `${value.toFixed(1)}d`;
    case "hours":
      return `${Math.round(value)}h`;
    case "ratio":
      return value.toFixed(2);
    default:
      return String(value);
  }
}

/**
 * A single KPI tile.
 *
 * Pass `measure` for a computed KPI (carries coverage), or `rawValue` for a
 * plain count. A null value renders as "—" plus `emptyHint`, never as 0.
 */
function MeasureTile({
  label,
  measure,
  rawValue,
  format = "count",
  tone = "default",
  sub,
  emptyHint,
}: {
  label: string;
  measure?: MondayMeasure;
  rawValue?: number | null;
  format?: "percent" | "days" | "hours" | "ratio" | "count";
  tone?: "default" | "green" | "red";
  sub?: ReactNode;
  emptyHint?: string;
}) {
  const value = measure ? measure.value : rawValue ?? null;
  const hasValue = value !== null && value !== undefined;

  const toneClass =
    !hasValue || tone === "default"
      ? "text-brand-black"
      : tone === "green"
        ? "text-brand-green"
        : "text-brand-red";

  // Coverage line: only meaningful when the measure didn't use everything it
  // could have. Silent when coverage is total, loud when it isn't.
  const coverageNote =
    measure && hasValue && measure.sample_size < measure.population
      ? `from ${measure.sample_size} of ${measure.population} tasks`
      : null;

  return (
    <div className="card px-[18px] py-4">
      <div className="text-[11px] uppercase tracking-[0.1em] text-brand-gray font-semibold">
        {label}
      </div>
      <div
        className={`text-[34px] font-bold mt-1.5 leading-tight tabular-nums ${
          hasValue ? toneClass : "text-brand-lightgray"
        }`}
      >
        {hasValue ? formatValue(value as number, format) : "—"}
      </div>
      {hasValue ? (
        <>
          {sub && <div className="text-xs text-brand-gray mt-0.5">{sub}</div>}
          {coverageNote && (
            <div className="text-[11px] text-brand-gray mt-0.5 italic">
              {coverageNote}
            </div>
          )}
          {measure?.low_confidence && (
            <div className="text-[11px] text-brand-gold mt-0.5 font-semibold">
              Low confidence — small sample
            </div>
          )}
        </>
      ) : (
        <div className="text-xs text-brand-gray mt-0.5">
          {emptyHint ?? "No data yet"}
        </div>
      )}
    </div>
  );
}
