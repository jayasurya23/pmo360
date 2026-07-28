/**
 * PlannerCard — "📋 My Planner tasks" on Home.
 *
 * Lists the signed-in user's INCOMPLETE Microsoft Planner tasks across all
 * plans (Graph /me/planner/tasks), grouped by due date, with a checkbox to
 * tick a task complete (PATCH percentComplete=100, optimistic). Same resilient
 * phase machine + consent/error CTAs as CalendarCard, so the card always shows
 * a state-appropriate message instead of a confusing blank.
 *
 * Read-only + complete only (v1). Editing/creating happens in Planner — the
 * header has an "Open Planner ↗" link.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  format,
  parseISO,
  startOfDay,
  differenceInCalendarDays,
  isSameWeek,
} from "date-fns";

import { useAuth } from "@/auth/useAuth";
import {
  listMyPlannerTasks,
  completePlannerTask,
  type PlannerTask,
} from "@/lib/graph";

type Phase =
  | "signed-out"
  | "idle"
  | "loading"
  | "needs-consent"
  | "loaded"
  | "empty"
  | "error";

interface ErrorDetail {
  message: string;
  hint?: string;
}

/** Microsoft Planner web app — generic landing (we don't deep-link per plan
 *  because that needs the owning group id + tenant in the URL, which is
 *  fragile; the user lands in Planner and picks the plan). */
const PLANNER_URL = "https://tasks.office.com/";

export default function PlannerCard() {
  const { isAuthenticated, getPlannerToken } = useAuth();

  const [phase, setPhase] = useState<Phase>(
    isAuthenticated ? "idle" : "signed-out",
  );
  const [tasks, setTasks] = useState<PlannerTask[]>([]);
  const [errorDetail, setErrorDetail] = useState<ErrorDetail | null>(null);
  // Ids currently being marked complete (disables the row + shows a spinner).
  const [completing, setCompleting] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isAuthenticated) {
      setPhase("signed-out");
      setTasks([]);
      setErrorDetail(null);
    } else if (phase === "signed-out") {
      setPhase("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  const load = useCallback(async () => {
    if (!isAuthenticated) return;
    setPhase("loading");
    setErrorDetail(null);
    try {
      const token = await getPlannerToken();
      const t = await listMyPlannerTasks(token);
      setTasks(t);
      setPhase(t.length === 0 ? "empty" : "loaded");
    } catch (err: any) {
      const message: string = err?.message || String(err);
      if (/interaction_required|user_cancelled|consent/i.test(message)) {
        setPhase("needs-consent");
      } else {
        setErrorDetail(diagnosePlannerError(message));
        setPhase("error");
      }
    }
  }, [isAuthenticated, getPlannerToken]);

  // Auto-load once when signed in.
  useEffect(() => {
    if (phase === "idle") void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const onComplete = useCallback(
    async (task: PlannerTask) => {
      setCompleting((s) => new Set(s).add(task.id));
      try {
        const token = await getPlannerToken();
        await completePlannerTask(task.id, task.etag, token);
        // Optimistically drop it — it's no longer "on my plate".
        setTasks((ts) => ts.filter((t) => t.id !== task.id));
      } catch (err: any) {
        // Stale etag (412) or other failure — resync from Planner.
        // eslint-disable-next-line no-alert
        alert(
          `Couldn't complete "${task.title}": ${
            err?.message || err
          }. Refreshing your tasks.`,
        );
        void load();
      } finally {
        setCompleting((s) => {
          const n = new Set(s);
          n.delete(task.id);
          return n;
        });
      }
    },
    [getPlannerToken, load],
  );

  const groups = useMemo(() => groupByDue(tasks), [tasks]);

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-surface-hairline">
        <h2 className="section-title">Your Planner tasks</h2>
        <span className="text-xs text-brand-gray truncate">
          from Microsoft Planner
        </span>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <a
            href={PLANNER_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-brand-gray hover:text-brand-red"
            title="Open Microsoft Planner"
          >
            Open Planner ↗
          </a>
          {phase !== "signed-out" && (
            <button
              type="button"
              onClick={() => load()}
              disabled={phase === "loading"}
              className="text-xs font-semibold text-brand-gray hover:text-brand-red disabled:opacity-40"
              title="Refresh from Planner"
            >
              {phase === "loading" ? "Loading…" : "↻ Refresh"}
            </button>
          )}
        </div>
      </div>

      <div className="px-5 py-3 space-y-3">
        {phase === "signed-out" && (
          <div className="text-sm text-brand-deepblue bg-[#f4fafc] border border-[#cfe6ee] rounded-lg px-3 py-2">
            Sign in with your Castillo account to see the Microsoft Planner
            tasks assigned to you.
          </div>
        )}

        {phase === "needs-consent" && (
          <div className="flex items-center justify-between gap-3 bg-[#f4fafc] border border-[#cfe6ee] rounded-lg px-3 py-2">
            <div className="text-sm text-brand-deepblue">
              Connect Microsoft Planner so we can list the tasks assigned to you
              and let you tick them off here.
            </div>
            <button
              type="button"
              onClick={() => load()}
              className="btn-primary text-xs px-3 py-1.5 whitespace-nowrap"
            >
              Connect Planner
            </button>
          </div>
        )}

        {phase === "error" && errorDetail && (
          <div className="rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
            <div className="font-semibold">{errorDetail.message}</div>
            {errorDetail.hint && (
              <div className="mt-1 text-xs leading-relaxed">
                {errorDetail.hint}
              </div>
            )}
            <button
              type="button"
              onClick={() => load()}
              className="mt-2 text-xs font-semibold underline hover:no-underline"
            >
              Try again
            </button>
          </div>
        )}

        {phase === "loading" && tasks.length === 0 && (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="py-2 space-y-2">
                <div className="h-4 w-3/4 bg-surface-mute rounded animate-pulse" />
                <div className="h-3 w-1/2 bg-surface-hairline rounded animate-pulse" />
              </div>
            ))}
          </div>
        )}

        {phase === "empty" && (
          <div className="text-sm text-brand-gray italic">
            No open Planner tasks assigned to you — you're all caught up. 🎉
          </div>
        )}

        {(phase === "loaded" || (phase === "loading" && tasks.length > 0)) && (
          // Negative inset so the rows run edge-to-edge inside the card while
          // the surrounding states keep the body padding.
          <div className="-mx-5 space-y-3">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="micro-label px-5 mb-1">
                  {g.label} ({g.tasks.length})
                </div>
                <div>
                  {g.tasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      busy={completing.has(t.id)}
                      overdue={g.key === "overdue"}
                      onComplete={() => onComplete(t)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
 * Single task row
 * ============================================================ */
function TaskRow({
  task,
  busy,
  overdue,
  onComplete,
}: {
  task: PlannerTask;
  busy: boolean;
  overdue: boolean;
  onComplete: () => void;
}) {
  const due = dueLocalDate(task.dueDateTime);
  const progress = task.percentComplete >= 50 ? "In progress" : "Not started";

  return (
    <div className="px-5 py-3 flex items-center gap-4 border-b border-b-surface-page last:border-b-0 hover:bg-surface-rowhover transition">
      <div className="w-[70px] shrink-0 text-right">
        {due ? (
          <>
            <div
              className={clsx(
                "text-sm font-semibold tabular-nums",
                overdue ? "text-brand-red" : "text-brand-black"
              )}
            >
              {format(due, "MMM d")}
            </div>
            <div className="text-[11px] text-brand-gray">
              {overdue ? "overdue" : "due"}
            </div>
          </>
        ) : (
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-lightgray">
            No date
          </div>
        )}
      </div>

      <div
        className={clsx(
          "w-[3px] self-stretch rounded-sm",
          overdue ? "bg-brand-red" : "bg-brand-green"
        )}
      />

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-brand-black truncate">
          {task.title}
        </div>
        <div className="text-xs text-brand-gray mt-px truncate">
          {task.planTitle ? `${task.planTitle} · ` : ""}
          {progress}
        </div>
      </div>

      <button
        type="button"
        onClick={onComplete}
        disabled={busy}
        title="Mark complete"
        aria-label={`Mark "${task.title}" complete`}
        className="h-[22px] w-[22px] shrink-0 rounded-full border-2 border-brand-lightgray text-[10px] leading-none text-brand-green flex items-center justify-center hover:border-brand-green hover:bg-[#f0f9f2] disabled:opacity-50 transition"
      >
        {busy ? "…" : ""}
      </button>
    </div>
  );
}

/* ============================================================
 * Helpers
 * ============================================================ */
interface DueGroup {
  key: "overdue" | "today" | "week" | "later" | "none";
  label: string;
  tasks: PlannerTask[];
}

/** Parse a Planner dueDateTime as a LOCAL calendar date. Planner stores due
 *  dates at UTC midnight, so parsing the full instant and reading it in a
 *  west-of-UTC timezone rolls back a day — we slice the date portion and
 *  parse that as local midnight to avoid the off-by-one. */
function dueLocalDate(due: string | null): Date | null {
  if (!due) return null;
  return parseISO(due.slice(0, 10));
}

function groupByDue(tasks: PlannerTask[]): DueGroup[] {
  const buckets: Record<DueGroup["key"], PlannerTask[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
    none: [],
  };
  const today = startOfDay(new Date());

  for (const t of tasks) {
    const d = dueLocalDate(t.dueDateTime);
    if (!d) {
      buckets.none.push(t);
      continue;
    }
    const diff = differenceInCalendarDays(d, today);
    if (diff < 0) buckets.overdue.push(t);
    else if (diff === 0) buckets.today.push(t);
    else if (isSameWeek(d, today, { weekStartsOn: 1 })) buckets.week.push(t);
    else buckets.later.push(t);
  }

  const sortByDue = (a: PlannerTask, b: PlannerTask) =>
    (a.dueDateTime || "9999").localeCompare(b.dueDateTime || "9999");
  (Object.keys(buckets) as DueGroup["key"][]).forEach((k) =>
    buckets[k].sort(sortByDue),
  );

  const order: { key: DueGroup["key"]; label: string }[] = [
    { key: "overdue", label: "Overdue" },
    { key: "today", label: "Due today" },
    { key: "week", label: "This week" },
    { key: "later", label: "Later" },
    { key: "none", label: "No due date" },
  ];
  return order
    .filter((o) => buckets[o.key].length > 0)
    .map((o) => ({ key: o.key, label: o.label, tasks: buckets[o.key] }));
}

function diagnosePlannerError(message: string): ErrorDetail {
  if (/AADSTS65001|consent|invalid_grant/i.test(message)) {
    return {
      message: "Planner access needs your consent.",
      hint:
        "Click Connect Planner and approve the Microsoft prompt. If it's blocked, an admin may need to grant the Tasks.ReadWrite permission for PMO 360.",
    };
  }
  if (/\b403\b|Forbidden/i.test(message)) {
    return {
      message: "Microsoft blocked the Planner request.",
      hint:
        "Your account may not have a Microsoft Planner license, or an admin needs to grant the app's Tasks.ReadWrite permission.",
    };
  }
  return {
    message: "Couldn't load your Planner tasks.",
    hint: message,
  };
}
