import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  fetchTimelineBoard,
  listGlobalRoster,
  createTimelineProject,
  createTimelineAssignment,
  patchTimelineAssignment,
  deleteTimelineAssignment,
  listTimelineResources,
  createTimelineResource,
  patchTimelineResource,
  deleteTimelineResource,
} from "@/lib/api";
import type {
  TimelineBoard,
  TimelineResource,
  TimelineAssignment,
  GlobalAttendee,
} from "@/lib/types";
import { format, parseISO, startOfWeek, addDays } from "date-fns";
import clsx from "clsx";

// ---------------- constants ----------------
const LABEL_W = 230;
const ROW_H = 30;
const LANE_H = 26; // height of one stacked bar lane inside an engineer row
const ZOOMS: Record<string, number> = { Compact: 60, Comfortable: 88, Wide: 124 };

const STATUSES = [
  { value: "in_progress", label: "In Progress", bg: "#ad1f2b", fg: "#ffffff" },
  { value: "ahead", label: "Ahead of Schedule", bg: "#1aa6c9", fg: "#ffffff" },
  { value: "on_hold", label: "On Hold", bg: "#c7bb2e", fg: "#1a1a1a" },
  { value: "delayed", label: "Delayed", bg: "#e12a3f", fg: "#ffffff" },
  { value: "not_contracted", label: "Not Contracted", bg: "#bcbec0", fg: "#1a1a1a" },
  { value: "complete", label: "Complete", bg: "#278747", fg: "#ffffff" },
] as const;
const STATUS_MAP: Record<string, { label: string; bg: string; fg: string }> =
  Object.fromEntries(STATUSES.map((s) => [s.value, s]));

const DISCIPLINES = ["Electrical", "Civil", "Structural", "Water", "General", "Other"];
const DISC_TAG: Record<string, { short: string; color: string }> = {
  Electrical: { short: "E", color: "#ad1f2b" },
  Civil: { short: "C", color: "#185fa5" },
  Structural: { short: "S", color: "#5e4b40" },
  Water: { short: "W", color: "#1aa6c9" },
  General: { short: "G", color: "#4d4d4f" },
  Other: { short: "•", color: "#4d4d4f" },
};
const MILESTONES = ["", "30%", "Stage B", "60%", "90%", "IFP", "IFC", "Studies"];
const UTILS = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2];

// ---------------- date helpers ----------------
const mondayISO = (iso: string) =>
  format(startOfWeek(parseISO(iso), { weekStartsOn: 1 }), "yyyy-MM-dd");
const todayISO = () => format(new Date(), "yyyy-MM-dd");
const shiftISO = (iso: string, days: number) =>
  format(addDays(parseISO(iso), days), "yyyy-MM-dd");

function colOf(iso: string, weeks: string[]): number {
  if (!weeks.length) return 0;
  const base = parseISO(weeks[0]).getTime();
  const d = parseISO(mondayISO(iso)).getTime();
  return Math.round((d - base) / (7 * 86400000));
}
function workdaysOverlap(aStart: string, aEnd: string, weekMonday: string): number {
  const ws = parseISO(weekMonday);
  const we = addDays(ws, 4); // Friday
  let lo = parseISO(aStart) > ws ? parseISO(aStart) : ws;
  const hi = parseISO(aEnd) < we ? parseISO(aEnd) : we;
  if (lo > hi) return 0;
  let cnt = 0;
  while (lo <= hi) {
    const d = lo.getDay(); // 0 Sun .. 6 Sat
    if (d >= 1 && d <= 5) cnt++;
    lo = addDays(lo, 1);
  }
  return cnt;
}
/** Per-resource per-week utilization, computed client-side so drags update live. */
function computeLoad(assignments: TimelineAssignment[], weeks: string[]): Record<string, number[]> {
  const load: Record<string, number[]> = {};
  for (const a of assignments) {
    if (a.resource_id == null) continue;
    const arr = (load[String(a.resource_id)] ||= new Array(weeks.length).fill(0));
    const util = a.utilization ?? 1;
    weeks.forEach((wk, i) => {
      const wd = workdaysOverlap(a.start_date, a.end_date, wk);
      if (wd) arr[i] += (wd / 5) * util;
    });
  }
  return load;
}
/** Greedy interval-packing: lay an engineer's bars on as few stacked lanes as
 *  possible — non-overlapping bars share one lane, so a normal sequential
 *  schedule collapses to a single row. */
function packLanes(items: TimelineAssignment[], weeks: string[]) {
  const sorted = [...items].sort(
    (a, b) => colOf(a.start_date, weeks) - colOf(b.start_date, weeks),
  );
  const laneEnd: number[] = [];
  const placed = sorted.map((a) => {
    const s = Math.max(0, colOf(a.start_date, weeks));
    const e = Math.min(weeks.length - 1, colOf(a.end_date, weeks));
    let lane = laneEnd.findIndex((end) => end < s);
    if (lane === -1) {
      lane = laneEnd.length;
      laneEnd.push(e);
    } else laneEnd[lane] = e;
    return { a, lane };
  });
  return { placed, lanes: Math.max(1, laneEnd.length) };
}

// ---------------- types ----------------
type View = "engineer" | "project";
type BarMode = "move" | "l" | "r";
type DragRef =
  | {
      kind: "bar";
      a: TimelineAssignment;
      mode: BarMode;
      startX: number;
      rects: { id: number; top: number; bottom: number }[];
    }
  | {
      kind: "row";
      resource: TimelineResource;
      rects: { id: number; top: number; bottom: number }[];
    }
  | null;
type DragVis = { id?: number; mode?: BarMode; dx: number; hoverRes: number | null; row?: boolean };
interface Ctx {
  weeks: string[];
  weekW: number;
  drag: DragVis | null;
  view: View;
  todayCol: number;
  onBarDown: (e: React.PointerEvent, a: TimelineAssignment, mode: BarMode) => void;
  onEditBar: (a: TimelineAssignment) => void;
}

const LS = "pmo360_timeline_prefs";

// ---------------- main ----------------
export default function Timeline() {
  const confirm = useConfirm();
  const [board, setBoard] = useState<TimelineBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const prefs = (() => {
    try {
      return JSON.parse(localStorage.getItem(LS) || "{}");
    } catch {
      return {};
    }
  })();
  const [view, setView] = useState<View>(prefs.view === "project" ? "project" : "engineer");
  const [zoom, setZoom] = useState<string>(prefs.zoom in ZOOMS ? prefs.zoom : "Comfortable");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(prefs.collapsed || []));
  const [discFilter, setDiscFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [winStart, setWinStart] = useState("");
  const [winEnd, setWinEnd] = useState("");
  const weekW = ZOOMS[zoom];

  // dialogs
  const [showNewProject, setShowNewProject] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [editing, setEditing] = useState<TimelineAssignment | null>(null);
  const [addingToProject, setAddingToProject] = useState<number | null>(null);

  // drag
  const dragRef = useRef<DragRef>(null);
  const [drag, setDrag] = useState<DragVis | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(
      LS,
      JSON.stringify({ view, zoom, collapsed: [...collapsed] }),
    );
  }, [view, zoom, collapsed]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setBoard(await fetchTimelineBoard(winStart || undefined, winEnd || undefined));
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [winStart, winEnd]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const weeks = board?.weeks ?? [];
  const todayCol = colOf(todayISO(), weeks);

  // live load (recomputed client-side from current assignments)
  const load = useMemo(
    () => (board ? computeLoad(board.assignments, weeks) : {}),
    [board, weeks],
  );

  // ---- optimistic helpers ----
  function patchLocal(id: number, patch: Partial<TimelineAssignment>) {
    setBoard((b) =>
      b ? { ...b, assignments: b.assignments.map((a) => (a.id === id ? { ...a, ...patch } : a)) } : b,
    );
  }

  // ---- drag handlers ----
  const collectRects = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-res-row]")).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: Number(el.dataset.resRow), top: r.top, bottom: r.bottom };
    });

  const onBarDown = (e: React.PointerEvent, a: TimelineAssignment, mode: BarMode) => {
    e.preventDefault();
    dragRef.current = { kind: "bar", a, mode, startX: e.clientX, rects: collectRects() };
    setDrag({ id: a.id, mode, dx: 0, hoverRes: a.resource_id ?? null });
  };
  const onRowDown = (e: React.PointerEvent, resource: TimelineResource) => {
    e.preventDefault();
    dragRef.current = { kind: "row", resource, rects: collectRects() };
    setDrag({ row: true, dx: 0, hoverRes: resource.id });
  };

  useEffect(() => {
    function move(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const hover = d.rects.find((r) => e.clientY >= r.top && e.clientY <= r.bottom)?.id ?? null;
      if (d.kind === "bar") {
        const dx = Math.round((e.clientX - d.startX) / weekW);
        setDrag({ id: d.a.id, mode: d.mode, dx, hoverRes: hover });
      } else {
        setDrag({ row: true, dx: 0, hoverRes: hover });
      }
    }
    async function up(e: PointerEvent) {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      // Compute the delta + hovered row DIRECTLY from the pointer-up event so
      // this works even when a (synthetic/fast) drag fires down→up before
      // React commits the live-preview state.
      const hover = d.rects.find((r) => e.clientY >= r.top && e.clientY <= r.bottom)?.id ?? null;
      try {
        if (d.kind === "bar") {
          const a = d.a;
          const dx = Math.round((e.clientX - d.startX) / weekW);
          if (d.mode === "move") {
            const shift = dx * 7;
            const newResource =
              view === "engineer" && hover != null
                ? hover === 0
                  ? null
                  : hover
                : a.resource_id ?? null;
            if (shift === 0 && newResource === (a.resource_id ?? null)) return;
            const patch = {
              start_date: shiftISO(a.start_date, shift),
              end_date: shiftISO(a.end_date, shift),
              resource_id: newResource,
            };
            patchLocal(a.id, patch);
            await patchTimelineAssignment(a.id, patch);
          } else if (d.mode === "l") {
            let ns = shiftISO(a.start_date, dx * 7);
            if (parseISO(ns) > parseISO(a.end_date)) ns = a.end_date;
            if (ns === a.start_date) return;
            patchLocal(a.id, { start_date: ns });
            await patchTimelineAssignment(a.id, { start_date: ns });
          } else {
            let ne = shiftISO(a.end_date, dx * 7);
            if (parseISO(ne) < parseISO(a.start_date)) ne = a.start_date;
            if (ne === a.end_date) return;
            patchLocal(a.id, { end_date: ne });
            await patchTimelineAssignment(a.id, { end_date: ne });
          }
        } else {
          // row reorder within the same discipline
          const target = hover;
          if (target == null || target === d.resource.id || !board) return;
          const group = board.resources
            .filter((r) => r.discipline === d.resource.discipline)
            .sort((x, y) => x.order_index - y.order_index);
          const from = group.findIndex((r) => r.id === d.resource.id);
          const to = group.findIndex((r) => r.id === target);
          if (from < 0 || to < 0) return;
          const reordered = [...group];
          const [moved] = reordered.splice(from, 1);
          reordered.splice(to, 0, moved);
          await Promise.all(
            reordered.map((r, i) =>
              r.order_index === i ? null : patchTimelineResource(r.id, { order_index: i }),
            ),
          );
          await reload();
        }
      } catch {
        await reload();
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekW, view, board]);

  function jumpToToday() {
    if (scrollRef.current && todayCol >= 0)
      scrollRef.current.scrollLeft = Math.max(0, todayCol * weekW - 200);
  }

  // ---- filtered assignments for display (load uses ALL assignments) ----
  const visibleAssignments = useMemo(() => {
    if (!board) return [];
    return board.assignments.filter((a) => {
      if (statusFilter.size && !statusFilter.has(a.effective_status || "in_progress")) return false;
      if (discFilter.size && !discFilter.has(a.discipline)) return false;
      return true;
    });
  }, [board, statusFilter, discFilter]);

  const ctx: Ctx = {
    weeks,
    weekW,
    drag,
    view,
    todayCol,
    onBarDown,
    onEditBar: setEditing,
  };
  const gridWidth = LABEL_W + weeks.length * weekW;

  return (
    <div className="space-y-4 select-none">
      <PageHeader
        title="Timeline Estimator"
        subtitle="Drag bars to reschedule, drag onto another engineer to reassign, drag edges to resize. Cells over 100% are over-allocated."
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-ghost text-sm" onClick={() => setShowResources(true)}>
              👥 Resources
            </button>
            <button className="btn-primary text-sm" onClick={() => setShowNewProject(true)}>
              + New project
            </button>
          </div>
        }
      />

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Segmented
          options={[
            ["engineer", "By engineer"],
            ["project", "By project"],
          ]}
          value={view}
          onChange={(v) => setView(v as View)}
        />
        <Segmented options={Object.keys(ZOOMS).map((z) => [z, z] as [string, string])} value={zoom} onChange={setZoom} />
        <button className="btn-ghost py-1 px-2" onClick={jumpToToday}>
          Today
        </button>
        <FilterMenu
          label="Discipline"
          options={DISCIPLINES}
          selected={discFilter}
          onChange={setDiscFilter}
        />
        <FilterMenu
          label="Status"
          options={STATUSES.map((s) => s.value)}
          labels={Object.fromEntries(STATUSES.map((s) => [s.value, s.label]))}
          selected={statusFilter}
          onChange={setStatusFilter}
        />
        <label className="flex items-center gap-1 text-brand-gray">
          From
          <input type="date" className="rounded border border-slate-200 px-1 py-0.5" value={winStart} onChange={(e) => setWinStart(e.target.value)} />
        </label>
        <label className="flex items-center gap-1 text-brand-gray">
          To
          <input type="date" className="rounded border border-slate-200 px-1 py-0.5" value={winEnd} onChange={(e) => setWinEnd(e.target.value)} />
        </label>
        {(winStart || winEnd) && (
          <button
            className="text-brand-red hover:underline"
            onClick={() => {
              setWinStart("");
              setWinEnd("");
            }}
          >
            reset
          </button>
        )}
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span className="inline-flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-brand-gray">Status</span>
            {STATUSES.map((s) => (
              <span key={s.value} className="inline-flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded" style={{ background: s.bg }} />
                {s.label}
              </span>
            ))}
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-brand-gray">Utilization</span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded border border-brand-lightgray" style={{ background: "#eaf6ee" }} />
              ≤ 100%
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded border border-brand-lightgray" style={{ background: "#fce8ea" }} />
              &gt; 100% over-allocated
            </span>
          </span>
        </div>
      </div>

      {loading && <div className="text-sm text-brand-gray">Loading timeline…</div>}
      {error && <div className="text-sm text-brand-red">{error}</div>}

      {board && !loading &&
        (board.assignments.length === 0 && board.resources.length === 0 ? (
          <EmptyState
            title="No timeline data yet"
            hint="Add resources (engineers / placeholders) via Resources, then create a project and assign work."
          />
        ) : (
          <div className="card p-0 overflow-x-auto" ref={scrollRef}>
            <div style={{ width: gridWidth, minWidth: gridWidth, position: "relative" }}>
              {/* header */}
              <div className="flex sticky top-0 z-20 bg-white border-b border-brand-lightgray">
                <div
                  className="shrink-0 px-3 py-2 text-[11px] uppercase tracking-wider text-brand-gray sticky left-0 bg-white z-10 border-r border-brand-lightgray"
                  style={{ width: LABEL_W }}
                >
                  {view === "engineer" ? "Engineer" : "Project"}
                </div>
                {weeks.map((w, i) => (
                  <div
                    key={w}
                    className={clsx(
                      "shrink-0 px-1 py-2 text-[11px] text-center border-r border-brand-lightgray/50",
                      i === todayCol ? "text-brand-red font-semibold" : "text-brand-gray",
                    )}
                    style={{ width: weekW }}
                  >
                    {format(parseISO(w), "d-MMM")}
                  </div>
                ))}
              </div>

              {/* today line */}
              {todayCol >= 0 && todayCol < weeks.length && (
                <div
                  className="absolute top-0 bottom-0 w-px bg-brand-red/40 z-10 pointer-events-none"
                  style={{ left: LABEL_W + todayCol * weekW + weekW / 2 }}
                />
              )}

              {view === "engineer" ? (
                <EngineerView
                  board={board}
                  assignments={visibleAssignments}
                  load={load}
                  ctx={ctx}
                  collapsed={collapsed}
                  onToggle={(d) =>
                    setCollapsed((c) => {
                      const n = new Set(c);
                      n.has(d) ? n.delete(d) : n.add(d);
                      return n;
                    })
                  }
                  onRowDown={onRowDown}
                />
              ) : (
                <ProjectView
                  board={board}
                  assignments={visibleAssignments}
                  ctx={ctx}
                  onAddTo={setAddingToProject}
                />
              )}
            </div>
          </div>
        ))}

      {showNewProject && (
        <NewProjectDialog board={board} onClose={() => setShowNewProject(false)} onSaved={() => { setShowNewProject(false); void reload(); }} />
      )}
      {showResources && (
        <ResourceManagerDialog onClose={() => setShowResources(false)} onChanged={() => void reload()} />
      )}
      {(editing || addingToProject !== null) && board && (
        <AssignmentDialog
          board={board}
          assignment={editing}
          projectId={addingToProject ?? editing?.timeline_project_id ?? null}
          onClose={() => { setEditing(null); setAddingToProject(null); }}
          onSaved={() => { setEditing(null); setAddingToProject(null); void reload(); }}
          onDelete={async () => {
            if (!editing) return;
            const ok = await confirm({ title: "Delete this assignment?", body: editing.project_name || undefined, confirmLabel: "Delete", destructive: true });
            if (!ok) return;
            await deleteTimelineAssignment(editing.id);
            setEditing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

// ---------------- toolbar bits ----------------
function Segmented({ options, value, onChange }: { options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 p-0.5 font-semibold">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={clsx("px-3 py-1 rounded-full transition", value === v ? "bg-white text-brand-red shadow-sm" : "text-slate-500 hover:text-slate-900")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
function FilterMenu({ label, options, labels, selected, onChange }: { label: string; options: string[]; labels?: Record<string, string>; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button className={clsx("rounded-full border px-3 py-1 font-semibold", selected.size ? "border-brand-red text-brand-red" : "border-slate-200 text-slate-600")} onClick={() => setOpen((o) => !o)}>
        {label}{selected.size ? ` (${selected.size})` : ""}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-44 bg-white border border-slate-200 rounded-lg shadow-lg p-2 space-y-1">
          {options.map((o) => (
            <label key={o} className="flex items-center gap-2 text-xs px-1 py-0.5 hover:bg-slate-50 rounded">
              <input
                type="checkbox"
                checked={selected.has(o)}
                onChange={() => {
                  const n = new Set(selected);
                  n.has(o) ? n.delete(o) : n.add(o);
                  onChange(n);
                }}
              />
              {labels?.[o] || o}
            </label>
          ))}
          {selected.size > 0 && (
            <button className="text-[11px] text-brand-red hover:underline px-1" onClick={() => onChange(new Set())}>
              clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- bar ----------------
function Bar({ a, ctx, top = 4, height = ROW_H - 8 }: { a: TimelineAssignment; ctx: Ctx; top?: number; height?: number }) {
  const { weeks, weekW, drag } = ctx;
  let start = Math.max(0, colOf(a.start_date, weeks));
  let end = Math.min(weeks.length - 1, colOf(a.end_date, weeks));
  if (end < 0 || start > weeks.length - 1 || end < start) return null;
  const st = STATUS_MAP[a.effective_status || "in_progress"] || STATUS_MAP["in_progress"];

  let left = start * weekW + 2;
  let width = (end - start + 1) * weekW - 4;
  const active = drag && drag.id === a.id;
  if (active) {
    if (drag!.mode === "move") left += drag!.dx * weekW;
    else if (drag!.mode === "l") {
      left += drag!.dx * weekW;
      width -= drag!.dx * weekW;
    } else width += drag!.dx * weekW;
    width = Math.max(weekW - 4, width);
  }
  const util = a.utilization != null ? `${Math.round(a.utilization * 100)}%` : "";

  return (
    <div
      onPointerDown={(e) => ctx.onBarDown(e, a, "move")}
      onDoubleClick={() => ctx.onEditBar(a)}
      title={`${a.project_name || a.label || ""} · ${a.discipline}${a.milestone ? " · " + a.milestone : ""} · ${util}  (double-click to edit)`}
      className={clsx(
        "absolute rounded text-[11px] font-medium truncate px-1.5 cursor-grab active:cursor-grabbing group",
        active && "ring-2 ring-black/30 z-10 shadow",
      )}
      style={{ left, width, top, height, background: st.bg, color: st.fg, lineHeight: `${height}px` }}
    >
      {/* resize handles */}
      <span
        onPointerDown={(e) => { e.stopPropagation(); ctx.onBarDown(e, a, "l"); }}
        className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-black/20"
      />
      <span
        onPointerDown={(e) => { e.stopPropagation(); ctx.onBarDown(e, a, "r"); }}
        className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-black/20"
      />
      {a.label || a.project_name || "—"}
      {a.milestone ? ` ${a.milestone}` : ""} · {util}
    </div>
  );
}
function Track({ ctx, children }: { ctx: Ctx; children?: ReactNode }) {
  const { weeks, weekW } = ctx;
  return (
    <div className="relative shrink-0" style={{ width: weeks.length * weekW, height: ROW_H }}>
      <div className="absolute inset-0 flex">
        {weeks.map((w) => (
          <div key={w} className="border-r border-brand-lightgray/30" style={{ width: weekW }} />
        ))}
      </div>
      {children}
    </div>
  );
}
function LabelCell({ children, indent, highlight, height = ROW_H }: { children: ReactNode; indent?: number; highlight?: boolean; height?: number }) {
  return (
    <div
      className={clsx(
        "shrink-0 px-3 sticky left-0 z-[1] border-r border-brand-lightgray/60 flex items-center text-sm",
        highlight ? "bg-rose-50" : "bg-white",
      )}
      style={{ width: LABEL_W, height, paddingLeft: 12 + (indent || 0) * 14 }}
    >
      <span className="truncate w-full">{children}</span>
    </div>
  );
}
function DiscTag({ d }: { d: string }) {
  const t = DISC_TAG[d] || DISC_TAG["Other"];
  return (
    <span className="inline-block text-[9px] font-bold rounded px-1 mr-1 align-middle" style={{ background: t.color, color: "#fff" }} title={d}>
      {t.short}
    </span>
  );
}

// ---------------- engineer view ----------------
function EngineerView({
  board,
  assignments,
  load,
  ctx,
  collapsed,
  onToggle,
  onRowDown,
}: {
  board: TimelineBoard;
  assignments: TimelineAssignment[];
  load: Record<string, number[]>;
  ctx: Ctx;
  collapsed: Set<string>;
  onToggle: (d: string) => void;
  onRowDown: (e: React.PointerEvent, r: TimelineResource) => void;
}) {
  const { weeks, weekW, drag } = ctx;
  const byResource = useMemo(() => {
    const m = new Map<number, TimelineAssignment[]>();
    for (const a of assignments) {
      if (a.resource_id == null) continue;
      (m.get(a.resource_id) || m.set(a.resource_id, []).get(a.resource_id)!).push(a);
    }
    return m;
  }, [assignments]);

  const groups: { discipline: string; rows: TimelineResource[] }[] = [];
  for (const r of board.resources) {
    let g = groups.find((x) => x.discipline === r.discipline);
    if (!g) groups.push((g = { discipline: r.discipline, rows: [] }));
    g.rows.push(r);
  }
  const unassigned = assignments.filter((a) => a.resource_id == null);
  const hoverRes = drag?.hoverRes ?? null;

  return (
    <div>
      {groups.map((g) => (
        <div key={g.discipline}>
          <button
            className="flex w-full bg-slate-50/80 border-b border-brand-lightgray/60 sticky left-0"
            onClick={() => onToggle(g.discipline)}
          >
            <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-gray" style={{ width: LABEL_W }}>
              {collapsed.has(g.discipline) ? "▸" : "▾"} {g.discipline} · {g.rows.length}
            </div>
          </button>
          {!collapsed.has(g.discipline) &&
            g.rows.map((r) => {
              const rowAssignments = byResource.get(r.id) || [];
              const cells = load[String(r.id)] || [];
              const isHover = hoverRes === r.id && drag != null;
              const { placed, lanes } = packLanes(rowAssignments, weeks);
              const rowH = lanes * LANE_H;
              return (
                <div
                  key={r.id}
                  data-res-row={r.id}
                  className={clsx(
                    "flex items-stretch border-b border-brand-lightgray/40",
                    isHover && "bg-rose-50/40",
                  )}
                >
                  <LabelCell highlight={isHover} height={rowH}>
                    <span
                      className="cursor-grab active:cursor-grabbing text-brand-gray mr-1"
                      title="Drag to reorder"
                      onPointerDown={(e) => onRowDown(e, r)}
                    >
                      ⠿
                    </span>
                    <span className="font-medium">{r.name}</span>
                    {r.title && <span className="text-brand-gray text-xs"> · {r.title}</span>}
                  </LabelCell>
                  <div className="relative shrink-0" style={{ width: weeks.length * weekW, height: rowH }}>
                    {/* utilization heat behind the bars (hover a cell for the %) */}
                    {weeks.map((w, i) => {
                      const v = cells[i] || 0;
                      const over = v > 1.0001;
                      return (
                        <div
                          key={w}
                          className="absolute top-0 border-r border-brand-lightgray/30"
                          style={{
                            left: i * weekW,
                            width: weekW,
                            height: rowH,
                            background: over ? "#fce8ea" : v > 0 ? "#eaf6ee" : "transparent",
                          }}
                          title={v > 0 ? `${Math.round(v * 100)}% utilized` : ""}
                        />
                      );
                    })}
                    {placed.map(({ a, lane }) => (
                      <Bar key={a.id} a={a} ctx={ctx} top={lane * LANE_H + 2} height={LANE_H - 4} />
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      ))}

      {unassigned.length > 0 &&
        (() => {
          const { placed, lanes } = packLanes(unassigned, weeks);
          const rowH = lanes * LANE_H;
          return (
            <div data-res-row="0" className={clsx(hoverRes === 0 && "bg-rose-50/40")}>
              <div className="flex bg-slate-50/80 border-b border-brand-lightgray/60">
                <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-gray" style={{ width: LABEL_W }}>
                  Unassigned
                </div>
              </div>
              <div className="flex items-stretch border-b border-brand-lightgray/40">
                <LabelCell height={rowH}>
                  <span className="text-xs text-brand-gray">Drag a bar onto an engineer →</span>
                </LabelCell>
                <div className="relative shrink-0" style={{ width: weeks.length * weekW, height: rowH }}>
                  {weeks.map((w, i) => (
                    <div key={w} className="absolute top-0 border-r border-brand-lightgray/30" style={{ left: i * weekW, width: weekW, height: rowH }} />
                  ))}
                  {placed.map(({ a, lane }) => (
                    <Bar key={a.id} a={a} ctx={ctx} top={lane * LANE_H + 2} height={LANE_H - 4} />
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}

// ---------------- project view ----------------
function ProjectView({
  board,
  assignments,
  ctx,
  onAddTo,
}: {
  board: TimelineBoard;
  assignments: TimelineAssignment[];
  ctx: Ctx;
  onAddTo: (projectId: number) => void;
}) {
  const { weeks, weekW } = ctx;
  const resName = (id?: number | null) =>
    id == null ? "Unassigned" : board.resources.find((r) => r.id === id)?.name || "Unassigned";
  const byProject = new Map<number, TimelineAssignment[]>();
  for (const a of assignments) (byProject.get(a.timeline_project_id) || byProject.set(a.timeline_project_id, []).get(a.timeline_project_id)!).push(a);

  return (
    <div>
      {board.projects.map((p) => {
        const rows = byProject.get(p.id) || [];
        const st = STATUS_MAP[p.status] || STATUS_MAP["in_progress"];
        return (
          <div key={p.id} className="border-b border-brand-lightgray/40">
            <div className="flex items-stretch bg-slate-50/60">
              <LabelCell>
                <span className="font-medium">{p.name}</span>
                {p.client && <span className="text-brand-gray text-xs"> · {p.client}</span>}
              </LabelCell>
              <div className="relative shrink-0 flex items-center gap-2 px-2" style={{ width: weeks.length * weekW, height: ROW_H }}>
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: st.bg, color: st.fg }}>
                  {st.label}
                </span>
                <button className="text-[11px] text-brand-red hover:underline" onClick={() => onAddTo(p.id)}>
                  + add assignment
                </button>
              </div>
            </div>
            {rows.map((a) => (
              <div key={a.id} className="flex items-stretch">
                <LabelCell indent={1}>
                  <span className="text-xs text-brand-gray">
                    <DiscTag d={a.discipline} /> {resName(a.resource_id)}
                    {a.milestone ? ` · ${a.milestone}` : ""}
                  </span>
                </LabelCell>
                <Track ctx={ctx}>
                  <Bar a={a} ctx={ctx} />
                </Track>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---------------- modal + dialogs ----------------
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="card w-full max-w-lg mt-16 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="section-title">{title}</h3>
          <button className="text-brand-gray hover:text-brand-red text-xl leading-none" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
const inputCls = "w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-red/30";
const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block">
    <span className="block text-[11px] uppercase tracking-wider text-brand-gray mb-1">{label}</span>
    {children}
  </label>
);

function NewProjectDialog({ board, onClose, onSaved }: { board: TimelineBoard | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [status, setStatus] = useState("in_progress");
  const [resourceId, setResourceId] = useState("");
  const [discipline, setDiscipline] = useState("Electrical");
  const [milestone, setMilestone] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [util, setUtil] = useState(1.0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) { setErr("Project name is required."); return; }
    setSaving(true); setErr(null);
    try {
      const p = await createTimelineProject({ name, client: client || null, status });
      if (start && end)
        await createTimelineAssignment({ timeline_project_id: p.id, resource_id: resourceId ? Number(resourceId) : null, discipline, milestone: milestone || null, start_date: start, end_date: end, utilization: util });
      onSaved();
    } catch (e: any) { setErr(e?.response?.data?.detail || e?.message || "Save failed"); setSaving(false); }
  }
  return (
    <Modal title="New project" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Project name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client"><input className={inputCls} value={client} onChange={(e) => setClient(e.target.value)} /></Field>
          <Field label="Status"><select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
        </div>
        <div className="border-t border-brand-lightgray/60 pt-3 text-[11px] uppercase tracking-wider text-brand-gray">First assignment (optional)</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assigned to"><select className={inputCls} value={resourceId} onChange={(e) => setResourceId(e.target.value)}><option value="">Unassigned</option>{(board?.resources ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Discipline"><select className={inputCls} value={discipline} onChange={(e) => setDiscipline(e.target.value)}>{DISCIPLINES.map((d) => <option key={d}>{d}</option>)}</select></Field>
          <Field label="Start"><input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="End"><input type="date" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          <Field label="Milestone"><select className={inputCls} value={milestone} onChange={(e) => setMilestone(e.target.value)}>{MILESTONES.map((m) => <option key={m} value={m}>{m || "—"}</option>)}</select></Field>
          <Field label="% Utilization"><select className={inputCls} value={util} onChange={(e) => setUtil(Number(e.target.value))}>{UTILS.map((u) => <option key={u} value={u}>{Math.round(u * 100)}%</option>)}</select></Field>
        </div>
        {err && <div className="text-sm text-brand-red">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Create"}</button>
        </div>
      </div>
    </Modal>
  );
}

function AssignmentDialog({ board, assignment, projectId, onClose, onSaved, onDelete }: { board: TimelineBoard; assignment: TimelineAssignment | null; projectId: number | null; onClose: () => void; onSaved: () => void; onDelete: () => void }) {
  const [pid, setPid] = useState(String(projectId ?? assignment?.timeline_project_id ?? ""));
  const [resourceId, setResourceId] = useState(assignment?.resource_id != null ? String(assignment.resource_id) : "");
  const [discipline, setDiscipline] = useState(assignment?.discipline || "Electrical");
  const [milestone, setMilestone] = useState(assignment?.milestone || "");
  const [start, setStart] = useState(assignment?.start_date || "");
  const [end, setEnd] = useState(assignment?.end_date || "");
  const [util, setUtil] = useState(assignment?.utilization ?? 1.0);
  const [statusOverride, setStatusOverride] = useState(assignment?.status || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isEdit = !!assignment;

  async function save() {
    if (!pid || !start || !end) { setErr("Project, start, and end are required."); return; }
    setSaving(true); setErr(null);
    const body = { resource_id: resourceId ? Number(resourceId) : null, discipline, milestone: milestone || null, start_date: start, end_date: end, utilization: util, status: statusOverride || null };
    try {
      if (isEdit && assignment) await patchTimelineAssignment(assignment.id, body);
      else await createTimelineAssignment({ ...body, timeline_project_id: Number(pid) });
      onSaved();
    } catch (e: any) { setErr(e?.response?.data?.detail || e?.message || "Save failed"); setSaving(false); }
  }
  return (
    <Modal title={isEdit ? "Edit assignment" : "Add assignment"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Project"><select className={inputCls} value={pid} onChange={(e) => setPid(e.target.value)} disabled={isEdit}><option value="">— pick —</option>{board.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assigned to"><select className={inputCls} value={resourceId} onChange={(e) => setResourceId(e.target.value)}><option value="">Unassigned</option>{board.resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Discipline"><select className={inputCls} value={discipline} onChange={(e) => setDiscipline(e.target.value)}>{DISCIPLINES.map((d) => <option key={d}>{d}</option>)}</select></Field>
          <Field label="Start"><input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="End"><input type="date" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          <Field label="Milestone"><select className={inputCls} value={milestone} onChange={(e) => setMilestone(e.target.value)}>{MILESTONES.map((m) => <option key={m} value={m}>{m || "—"}</option>)}</select></Field>
          <Field label="% Utilization"><select className={inputCls} value={util} onChange={(e) => setUtil(Number(e.target.value))}>{UTILS.map((u) => <option key={u} value={u}>{Math.round(u * 100)}%</option>)}</select></Field>
        </div>
        <Field label="Status override (optional)"><select className={inputCls} value={statusOverride} onChange={(e) => setStatusOverride(e.target.value)}><option value="">Use project status</option>{STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
        {err && <div className="text-sm text-brand-red">{err}</div>}
        <div className="flex justify-between gap-2 pt-1">
          <div>{isEdit && <button className="btn-ghost text-brand-red" onClick={onDelete}>Delete</button>}</div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ResourceManagerDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const confirm = useConfirm();
  const [resources, setResources] = useState<TimelineResource[]>([]);
  const [roster, setRoster] = useState<GlobalAttendee[]>([]);
  const [name, setName] = useState("");
  const [discipline, setDiscipline] = useState("Electrical");
  const [title, setTitle] = useState("");
  const [placeholder, setPlaceholder] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() { setResources(await listTimelineResources(true)); }
  useEffect(() => { void load(); listGlobalRoster().then(setRoster).catch(() => setRoster([])); }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createTimelineResource({ name: name.trim(), discipline, title: title || null, is_placeholder: placeholder, order_index: resources.length });
      setName(""); setTitle(""); setPlaceholder(false);
      await load(); onChanged();
    } finally { setBusy(false); }
  }
  async function setDisc(r: TimelineResource, d: string) { await patchTimelineResource(r.id, { discipline: d }); await load(); onChanged(); }
  async function toggleActive(r: TimelineResource) { await patchTimelineResource(r.id, { active: !r.active }); await load(); onChanged(); }
  async function remove(r: TimelineResource) {
    const ok = await confirm({ title: `Remove ${r.name}?`, body: "Their assignments become Unassigned (not deleted).", confirmLabel: "Remove", destructive: true });
    if (!ok) return;
    await deleteTimelineResource(r.id); await load(); onChanged();
  }
  return (
    <Modal title="Manage resources" onClose={onClose}>
      <div className="space-y-3">
        <div className="rounded-lg border border-brand-lightgray/60 p-3 space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-brand-gray">Add engineer or placeholder</div>
          <input className={inputCls} list="timeline-roster" placeholder="Type a name (roster suggestions) or a placeholder like 'New Hire'" value={name} onChange={(e) => setName(e.target.value)} />
          <datalist id="timeline-roster">{roster.map((g) => <option key={g.id} value={g.full_name} />)}</datalist>
          <div className="grid grid-cols-2 gap-2">
            <select className={inputCls} value={discipline} onChange={(e) => setDiscipline(e.target.value)}>{DISCIPLINES.map((d) => <option key={d}>{d}</option>)}</select>
            <input className={inputCls} placeholder="Title (e.g. EE II)" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-xs text-brand-gray">
            <input type="checkbox" checked={placeholder} onChange={(e) => setPlaceholder(e.target.checked)} />
            Placeholder (new hire / vendor — not a real person yet)
          </label>
          <button className="btn-primary text-sm" onClick={add} disabled={busy || !name.trim()}>{busy ? "Adding…" : "Add resource"}</button>
        </div>
        <div className="max-h-72 overflow-y-auto divide-y divide-brand-lightgray/40">
          {resources.map((r) => (
            <div key={r.id} className="flex items-center gap-2 py-2 text-sm">
              <span className={clsx("flex-1 truncate", !r.active && "text-brand-gray line-through")}>
                {r.name}{r.title && <span className="text-brand-gray text-xs"> · {r.title}</span>}
                {r.is_placeholder && <span className="ml-1 text-[10px] px-1 rounded bg-slate-100 text-brand-gray">placeholder</span>}
              </span>
              <select className="rounded border border-slate-200 text-xs px-1 py-0.5" value={r.discipline} onChange={(e) => void setDisc(r, e.target.value)}>{DISCIPLINES.map((d) => <option key={d}>{d}</option>)}</select>
              <button className="text-xs text-brand-gray hover:text-brand-red" onClick={() => void toggleActive(r)}>{r.active ? "Hide" : "Show"}</button>
              <button className="text-xs text-brand-red hover:underline" onClick={() => void remove(r)}>Remove</button>
            </div>
          ))}
          {resources.length === 0 && <div className="py-3 text-sm text-brand-gray">No resources yet.</div>}
        </div>
      </div>
    </Modal>
  );
}
