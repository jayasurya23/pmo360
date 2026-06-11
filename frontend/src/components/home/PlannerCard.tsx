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
    <div className="card p-5 border-l-4 border-l-[#7c3aed] bg-gradient-to-r from-violet-50/40 to-white">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
            My Planner tasks
          </div>
          <div className="text-base font-semibold text-brand-black mt-1">
            📋 Open tasks from Microsoft Planner
          </div>
        </div>
        <div className="flex items-center gap-1">
          <a
            href={PLANNER_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-brand-gray hover:text-brand-black px-2 py-1 rounded hover:bg-brand-nearwhite/60"
            title="Open Microsoft Planner"
          >
            Open Planner ↗
          </a>
          {phase !== "signed-out" && (
            <button
              type="button"
              onClick={() => load()}
              disabled={phase === "loading"}
              className="text-xs text-brand-gray hover:text-brand-black px-2 py-1 rounded hover:bg-brand-nearwhite/60 disabled:opacity-40"
              title="Refresh from Planner"
            >
              {phase === "loading" ? "Loading…" : "↻ Refresh"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {phase === "signed-out" && (
          <div className="text-sm text-violet-900 bg-violet-50 border border-violet-200 rounded px-3 py-2">
            Sign in with your Castillo account to see the Microsoft Planner
            tasks assigned to you.
          </div>
        )}

        {phase === "needs-consent" && (
          <div className="flex items-center justify-between gap-3 bg-violet-50 border border-violet-200 rounded px-3 py-2">
            <div className="text-sm text-violet-900">
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
          <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
            <div className="font-semibold">{errorDetail.message}</div>
            {errorDetail.hint && (
              <div className="mt-1 text-xs text-rose-800 leading-relaxed">
                {errorDetail.hint}
              </div>
            )}
            <button
              type="button"
              onClick={() => load()}
              className="mt-2 text-xs underline text-rose-900 hover:text-rose-700"
            >
              Try again
            </button>
          </div>
        )}

        {phase === "loading" && tasks.length === 0 && (
          <div className="card divide-y divide-brand-lightgray/60">
            {[0, 1].map((i) => (
              <div key={i} className="px-5 py-3 space-y-2">
                <div className="h-4 w-3/4 bg-slate-200/70 rounded animate-pulse" />
                <div className="h-3 w-1/2 bg-slate-100 rounded animate-pulse" />
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
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="text-[11px] uppercase tracking-wider text-brand-gray font-semibold mb-1">
                  {g.label} ({g.tasks.length})
                </div>
                <div className="card divide-y divide-brand-lightgray/60">
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
    <div className="px-5 py-3 flex items-start gap-3">
      <button
        type="button"
        onClick={onComplete}
        disabled={busy}
        title="Mark complete"
        aria-label={`Mark "${task.title}" complete`}
        className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-slate-300 text-emerald-600 text-[10px] leading-none flex items-center justify-center hover:border-emerald-500 hover:bg-emerald-50 disabled:opacity-50 transition"
      >
        {busy ? "…" : ""}
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-brand-black truncate">
          {task.title}
        </div>
        <div className="text-xs text-brand-gray mt-0.5 flex items-center gap-2 flex-wrap">
          {task.planTitle && (
            <span className="truncate max-w-[12rem]" title={task.planTitle}>
              {task.planTitle}
            </span>
          )}
          {due && (
            <span className={overdue ? "text-rose-600 font-semibold" : ""}>
              {format(due, "EEE, MMM d")}
            </span>
          )}
          <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
            {progress}
          </span>
        </div>
      </div>
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
