/**
 * Modal that surfaces every task in the most recently uploaded project
 * Schedule and lets the PM bulk-add them to the meeting's Deliverable
 * Timelines section.
 *
 * Rows are grouped by discipline → phase (matching the visual hierarchy
 * of the source Excel/PDF). Items already present on the meeting's
 * deliverable list (matched by task + project_segment) are dimmed and
 * non-clickable, mirroring the DirectoryBrowser pattern.
 *
 * Each picked schedule item becomes a deliverable row:
 *   project_segment = schedule item discipline
 *   task            = schedule item task
 *   start_status    = "Not Started"
 *   delivery_date   = schedule item finish_date
 */
import { useEffect, useMemo, useState } from "react";
import { listSchedules } from "@/lib/api";
import type { Schedule, ScheduleItem } from "@/lib/types";
import { format, parseISO } from "date-fns";

export interface SelectedDeliverableRow {
  project_segment: string;
  task: string;
  start_status: string;
  delivery_date: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Active portfolio id — required to load schedules. */
  projectId: number | null;
  /** Current deliverables — used to dim already-added rows. */
  existing: SelectedDeliverableRow[];
  /** Fires with the new rows to append to selectedDeliverables. */
  onAdd: (rows: SelectedDeliverableRow[]) => void;
}

function formatFinish(iso?: string | null): string {
  if (!iso) return "";
  try {
    return format(parseISO(iso), "M/d/yyyy");
  } catch {
    return iso;
  }
}

/** Stable identity for a schedule item across renders. */
function itemKey(item: ScheduleItem): string {
  // id is the canonical identifier once saved; fall back to order_index +
  // task for the (very unlikely) parsed-but-not-yet-saved case.
  return item.id != null ? `id:${item.id}` : `idx:${item.order_index}:${item.task}`;
}

/** Match against existing deliverable rows on (task, project_segment). */
function matchesExisting(
  item: ScheduleItem,
  existing: SelectedDeliverableRow[],
): boolean {
  const taskKey = (item.task || "").trim().toLowerCase();
  const segKey = (item.discipline || "").trim().toLowerCase();
  return existing.some(
    (d) =>
      (d.task || "").trim().toLowerCase() === taskKey &&
      (d.project_segment || "").trim().toLowerCase() === segKey,
  );
}

export default function ScheduleItemPicker({
  open,
  onClose,
  projectId,
  existing,
  onAdd,
}: Props) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onlyFuture, setOnlyFuture] = useState(true);

  // Fetch the most recent schedule on every open. Schedules are small;
  // re-fetching keeps the picker honest if the PM uploaded a new version
  // in another tab.
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    listSchedules(projectId)
      .then((list) => {
        if (cancelled) return;
        setSchedule(list.length > 0 ? list[0] : null);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message || "Failed to load schedule");
        setSchedule(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // ---- Filter to leaf tasks only (indent_level === 2). Discipline +
  // phase header rows aren't meaningful as deliverables on their own. ----
  const todayIso = useMemo(() => format(new Date(), "yyyy-MM-dd"), []);
  const leafTasks = useMemo<ScheduleItem[]>(() => {
    if (!schedule) return [];
    return schedule.items.filter((i) => {
      // Accept indent 2 (leaf tasks) or any milestone-flagged item. Items
      // without explicit indent levels (legacy data) fall back to "has a
      // task name and not flagged as a heading"-style heuristic: anything
      // with a finish_date is treated as a real deliverable.
      const isLeaf =
        i.indent_level === 2 ||
        i.is_milestone ||
        (i.indent_level === 0 && !!i.finish_date);
      if (!isLeaf) return false;
      if (onlyFuture && i.finish_date) {
        return i.finish_date >= todayIso;
      }
      return true;
    });
  }, [schedule, onlyFuture, todayIso]);

  // Group by discipline → phase for display.
  const grouped = useMemo(() => {
    const out = new Map<string, Map<string, ScheduleItem[]>>();
    for (const item of leafTasks) {
      const disc = item.discipline || "Uncategorized";
      const phase = item.phase || "—";
      if (!out.has(disc)) out.set(disc, new Map());
      const phaseMap = out.get(disc)!;
      if (!phaseMap.has(phase)) phaseMap.set(phase, []);
      phaseMap.get(phase)!.push(item);
    }
    return out;
  }, [leafTasks]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleAdd() {
    if (selected.size === 0) return;
    const rows: SelectedDeliverableRow[] = [];
    for (const item of leafTasks) {
      if (!selected.has(itemKey(item))) continue;
      if (matchesExisting(item, existing)) continue; // belt + suspenders
      rows.push({
        project_segment: item.discipline || "",
        task: item.task,
        start_status: "Not Started",
        delivery_date: item.finish_date || null,
      });
    }
    onAdd(rows);
    onClose();
  }

  if (!open) return null;

  const totalPickable = leafTasks.filter(
    (i) => !matchesExisting(i, existing),
  ).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl card p-5 space-y-3 shadow-xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between">
          <h3 className="section-title">
            Pick from schedule
            {schedule && (
              <span className="text-xs font-normal text-brand-gray ml-2">
                · {schedule.version}
                {schedule.source_filename ? ` · ${schedule.source_filename}` : ""}
              </span>
            )}
          </h3>
          <button
            type="button"
            className="text-xs text-brand-lightgray hover:text-brand-gray"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {loading && (
          <div className="text-sm text-brand-gray p-4">Loading schedule…</div>
        )}

        {!loading && error && (
          <div className="text-sm text-status-open-text bg-status-open-bg border border-status-open-border rounded-[10px] px-3 py-2">
            {error}
          </div>
        )}

        {!loading && !error && !schedule && (
          <div className="card p-4 text-sm border-l-4 border-l-brand-gold">
            No schedule uploaded for this portfolio yet. Head to the Schedule
            page to upload a proposal PDF or duration workbook.
          </div>
        )}

        {!loading && !error && schedule && leafTasks.length === 0 && (
          <div className="card p-4 text-sm">
            {onlyFuture
              ? "No upcoming tasks. Untick the future-only filter to see every line item."
              : "This schedule has no leaf-task line items."}
          </div>
        )}

        {!loading && !error && schedule && (
          <>
            <label
              className="flex items-center gap-2 text-xs text-brand-gray select-none"
              title="Show only schedule items whose finish date is today or later"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand-red"
                checked={onlyFuture}
                onChange={(e) => setOnlyFuture(e.target.checked)}
              />
              Only items with finish date today or later
            </label>

            {leafTasks.length > 0 && (
              <div className="flex-1 overflow-y-auto -mx-1 px-1 border border-surface-border rounded-[10px]">
                {[...grouped.entries()].map(([discipline, phaseMap]) => (
                  <div key={discipline}>
                    <div className="px-3 py-1.5 bg-surface-rowhover border-b border-surface-border text-xs font-semibold text-brand-black uppercase tracking-wide sticky top-0">
                      {discipline}
                    </div>
                    {[...phaseMap.entries()].map(([phase, items]) => (
                      <div key={phase}>
                        {phase !== "—" && (
                          <div className="px-3 py-1 text-[11px] font-medium text-brand-gray bg-surface-card border-b border-surface-hairline">
                            {phase}
                          </div>
                        )}
                        <ul>
                          {items.map((item) => {
                            const key = itemKey(item);
                            const already = matchesExisting(item, existing);
                            const isSelected = selected.has(key);
                            return (
                              <li
                                key={key}
                                className={
                                  "flex items-center gap-3 px-3 py-2 border-b border-surface-hairline last:border-0 cursor-pointer transition " +
                                  (already
                                    ? "opacity-50 cursor-not-allowed"
                                    : isSelected
                                      ? "bg-brand-red/5"
                                      : "hover:bg-surface-rowhover")
                                }
                                onClick={() => !already && toggle(key)}
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  readOnly
                                  disabled={already}
                                  className="h-4 w-4 accent-brand-red"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-brand-black truncate">
                                    {item.task}
                                    {already && (
                                      <span className="ml-2 text-xs text-brand-lightgray">
                                        · already added
                                      </span>
                                    )}
                                  </div>
                                  {item.is_milestone && (
                                    <div className="text-[11px] text-brand-gold">
                                      milestone
                                    </div>
                                  )}
                                </div>
                                <div className="text-xs text-brand-gray whitespace-nowrap shrink-0">
                                  {formatFinish(item.finish_date)}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between pt-2 gap-2 flex-wrap">
              <div className="text-xs text-brand-gray">
                {selected.size > 0
                  ? `${selected.size} selected`
                  : `${totalPickable} item${totalPickable === 1 ? "" : "s"} available`}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleAdd}
                  disabled={selected.size === 0}
                >
                  Add {selected.size > 0 ? selected.size : ""} selected
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
