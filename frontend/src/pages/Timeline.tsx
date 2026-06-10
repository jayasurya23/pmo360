import {
  Fragment,
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
import { useAuth } from "@/auth/useAuth";
import {
  fetchTimelineBoard,
  listGlobalRoster,
  createTimelineProject,
  patchTimelineProject,
  deleteTimelineProject,
  createTimelineAssignment,
  patchTimelineAssignment,
  deleteTimelineAssignment,
  listTimelineResources,
  createTimelineResource,
  patchTimelineResource,
  deleteTimelineResource,
  createTimelineTimeOff,
  deleteTimelineTimeOff,
} from "@/lib/api";
import type {
  TimelineBoard,
  TimelineResource,
  TimelineProject,
  TimelineAssignment,
  TimelineTimeOff,
  GlobalAttendee,
} from "@/lib/types";
import { format, parseISO, startOfWeek, addDays } from "date-fns";
import clsx from "clsx";

// ---------------- constants ----------------
const LABEL_W = 264;
const ROW_H = 48;
const LANE_H = 42; // height of one stacked bar lane inside an engineer row
const ZOOMS: Record<string, number> = { Compact: 84, Comfortable: 116, Wide: 156 };

const STATUSES = [
  { value: "in_progress", label: "In Progress", bg: "#2563eb", fg: "#ffffff" },
  { value: "ahead", label: "Ahead of Schedule", bg: "#1aa6c9", fg: "#ffffff" },
  { value: "on_hold", label: "On Hold", bg: "#c7bb2e", fg: "#1a1a1a" },
  { value: "delayed", label: "Delayed", bg: "#e12a3f", fg: "#ffffff" },
  { value: "not_contracted", label: "Not Contracted", bg: "#bcbec0", fg: "#1a1a1a" },
  { value: "complete", label: "Complete", bg: "#278747", fg: "#ffffff" },
] as const;
const STATUS_MAP: Record<string, { label: string; bg: string; fg: string }> =
  Object.fromEntries(STATUSES.map((s) => [s.value, s]));

const DISCIPLINES = ["Electrical", "Civil", "Structural", "Water", "Vendors", "General", "Other"];
const DISC_TAG: Record<string, { short: string; color: string }> = {
  Electrical: { short: "E", color: "#ad1f2b" },
  Civil: { short: "C", color: "#185fa5" },
  Structural: { short: "S", color: "#5e4b40" },
  Water: { short: "W", color: "#1aa6c9" },
  Vendors: { short: "V", color: "#6d28d9" },
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
/** Workday index from the board's first Monday: Mon–Fri of week 0 -> 0..4,
 *  next Mon -> 5, etc. Each week cell is 5 work-days wide, so 1 work-day =
 *  weekW/5 px. Weekend dates clamp to the end of their work-week. */
function workdayPos(iso: string, firstMonday: string): number {
  const base = parseISO(firstMonday).getTime();
  const delta = Math.round((parseISO(iso).getTime() - base) / 86400000);
  const wk = Math.floor(delta / 7);
  const dow = ((delta % 7) + 7) % 7; // 0 Mon .. 6 Sun
  return wk * 5 + Math.min(dow, 5);
}
/** Advance an ISO date by n work-days (skipping Sat/Sun); n may be negative. */
function addWorkdays(iso: string, n: number): string {
  let d = parseISO(iso);
  const step = n >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.round(n));
  while (remaining > 0) {
    d = addDays(d, step);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return format(d, "yyyy-MM-dd");
}
/** Faint vertical line every work-day (weekW/5 px) so the 5-day grid + the
 *  day-snapping of drags is legible. */
const dayGridBg = (weekW: number) =>
  `repeating-linear-gradient(to right, rgba(120,120,130,0.13) 0px, rgba(120,120,130,0.13) 1px, transparent 1px, transparent ${weekW / 5}px)`;
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
  const fm = weeks[0] || todayISO();
  const total = weeks.length * 5;
  const sorted = [...items].sort(
    (a, b) => workdayPos(a.start_date, fm) - workdayPos(b.start_date, fm),
  );
  const laneEnd: number[] = [];
  const placed = sorted.map((a) => {
    const s = Math.max(0, workdayPos(a.start_date, fm));
    const e = Math.min(total, workdayPos(a.end_date, fm) + 1); // exclusive end
    let lane = laneEnd.findIndex((end) => end <= s);
    if (lane === -1) {
      lane = laneEnd.length;
      laneEnd.push(e);
    } else laneEnd[lane] = e;
    return { a, lane };
  });
  return { placed, lanes: Math.max(1, laneEnd.length) };
}
function _assignmentBody(a: TimelineAssignment): Partial<TimelineAssignment> {
  return {
    timeline_project_id: a.timeline_project_id,
    resource_id: a.resource_id,
    discipline: a.discipline,
    milestone: a.milestone,
    start_date: a.start_date,
    end_date: a.end_date,
    utilization: a.utilization,
    status: a.status,
  };
}

// ---------------- types ----------------
type View = "engineer" | "project" | "workload";
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
  onBarMenu: (e: React.MouseEvent, a: TimelineAssignment) => void;
  onCellAdd: (resourceId: number | null, weekIso: string) => void;
  onCellMenu: (e: React.MouseEvent, resourceId: number | null, weekIso: string) => void;
  onTimeOffMenu: (e: React.MouseEvent, t: TimelineTimeOff) => void;
}

const LS = "pmo360_timeline_prefs";

// ---------------- main ----------------
export default function Timeline() {
  const confirm = useConfirm();
  const { isAuthenticated } = useAuth();
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
  const [showNewProject, setShowNewProject] = useState(prefs.newProjectOpen !== false);
  const [showResources, setShowResources] = useState(false);
  const [editing, setEditing] = useState<TimelineAssignment | null>(null);
  const [addingToProject, setAddingToProject] = useState<number | null>(null);
  const [addPreset, setAddPreset] = useState<{ resourceId: number | null; start: string } | null>(null);
  const [menu, setMenu] = useState<
    { x: number; y: number; a?: TimelineAssignment; resourceId?: number | null; weekIso?: string; timeoff?: TimelineTimeOff } | null
  >(null);
  const [timeOffPreset, setTimeOffPreset] = useState<{ resourceId: number; start: string } | null>(null);
  const [undoStack, setUndoStack] = useState<{ label: string; run: () => Promise<void> }[]>([]);

  // drag
  const dragRef = useRef<DragRef>(null);
  const [drag, setDrag] = useState<DragVis | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // live auto-refresh bookkeeping
  const loadedRef = useRef(false);   // suppress the loading spinner after first load
  const busyRef = useRef(false);     // gate polling while editing/dragging
  const [lastSync, setLastSync] = useState(0);
  const [conflict, setConflict] = useState<string | null>(null);  // 409 stale-write notice

  useEffect(() => {
    localStorage.setItem(
      LS,
      JSON.stringify({ view, zoom, collapsed: [...collapsed], newProjectOpen: showNewProject }),
    );
  }, [view, zoom, collapsed, showNewProject]);

  const reload = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);  // only block the UI on the first load
    try {
      setBoard(await fetchTimelineBoard(winStart || undefined, winEnd || undefined));
      loadedRef.current = true;
      setLastSync(Date.now());
      setError(null);
    } catch (e: any) {
      if (!loadedRef.current) setError(e?.response?.data?.detail || e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [winStart, winEnd]);
  // Refetch when auth becomes ready: the first load can fire before MSAL has
  // restored/created the account (token not attached yet -> 401). When
  // isAuthenticated flips true after sign-in, pull the board again so the
  // user doesn't have to manually refresh.
  useEffect(() => {
    void reload();
  }, [reload, isAuthenticated]);

  // ---- live updates: auto-refresh so PMs see each other's edits ----
  // Poll the board on an interval + on window focus. Gated so a refresh never
  // yanks an in-progress drag or an open editor out from under the user.
  busyRef.current = !!(
    dragRef.current || drag || editing || addingToProject !== null ||
    addPreset || timeOffPreset || showResources || menu
  );
  useEffect(() => {
    const POLL_MS = 12000;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (dragRef.current || busyRef.current) return;
      void reload();
    };
    const id = window.setInterval(tick, POLL_MS);
    const onFocus = () => { if (!dragRef.current && !busyRef.current) void reload(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
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
  const addLocal = (a: TimelineAssignment) =>
    setBoard((b) => (b ? { ...b, assignments: [...b.assignments, a] } : b));
  const removeLocal = (id: number) =>
    setBoard((b) => (b ? { ...b, assignments: b.assignments.filter((x) => x.id !== id) } : b));

  // ---- optimistic concurrency: send the version we last saw; a stale save
  // is rejected with 409 instead of clobbering another PM's change. ----
  async function saveAssign(
    a: TimelineAssignment,
    patch: Partial<TimelineAssignment>,
    opts?: { force?: boolean },
  ) {
    const body: any = opts?.force ? { ...patch } : { ...patch, expected_version: a.version };
    const res = await patchTimelineAssignment(a.id, body);
    if (res && typeof (res as any).version === "number") patchLocal(a.id, { version: (res as any).version });
    setConflict(null);
    return res;
  }
  async function onWriteError(e: any) {
    if (e?.response?.status === 409) {
      setConflict("Another PM changed this item while you were editing — your change was discarded and the latest is shown.");
    }
    await reload();
  }

  // ---- undo stack (direct-manipulation ops) ----
  const pushUndo = (label: string, run: () => Promise<void>) =>
    setUndoStack((s) => [...s.slice(-49), { label, run }]);
  const doUndo = useCallback(async () => {
    setUndoStack((s) => {
      const last = s[s.length - 1];
      if (last) void last.run().catch(() => void reload());
      return s.slice(0, -1);
    });
  }, [reload]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void doUndo();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [doUndo]);

  async function deleteAssignment(a: TimelineAssignment) {
    setMenu(null);
    removeLocal(a.id);
    try {
      await deleteTimelineAssignment(a.id);
      pushUndo("delete", async () => {
        const created = await createTimelineAssignment(_assignmentBody(a));
        addLocal({ ...a, id: created.id });
      });
    } catch {
      await reload();
    }
  }
  async function duplicateAssignment(a: TimelineAssignment) {
    setMenu(null);
    try {
      // offset a week so the copy is visible rather than hidden behind the original
      const body = { ..._assignmentBody(a), start_date: shiftISO(a.start_date, 7), end_date: shiftISO(a.end_date, 7) };
      const created = await createTimelineAssignment(body);
      addLocal(created);
      pushUndo("duplicate", async () => {
        removeLocal(created.id);
        await deleteTimelineAssignment(created.id);
      });
    } catch {
      await reload();
    }
  }
  async function quickPatch(a: TimelineAssignment, patch: Partial<TimelineAssignment>, label: string) {
    setMenu(null);
    const before: Partial<TimelineAssignment> = {};
    (Object.keys(patch) as (keyof TimelineAssignment)[]).forEach((k) => ((before as any)[k] = a[k] ?? null));
    patchLocal(a.id, { ...patch, effective_status: "status" in patch ? (patch.status as string) : a.effective_status });
    try {
      await saveAssign(a, patch);
      pushUndo(label, async () => {
        patchLocal(a.id, before);
        await saveAssign(a, before, { force: true });
        await reload();
      });
    } catch (e) {
      await onWriteError(e);
    }
  }

  async function removeTimeOff(t: TimelineTimeOff) {
    setMenu(null);
    const ok = await confirm({ title: "Remove this time-off block?", body: t.reason || "OOO", confirmLabel: "Remove", destructive: true });
    if (!ok) return;
    setBoard((b) => (b ? { ...b, timeoff: b.timeoff.filter((x) => x.id !== t.id) } : b));
    try {
      await deleteTimelineTimeOff(t.id);
    } catch {
      await reload();
    }
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
        const dx = Math.round((e.clientX - d.startX) / (weekW / 5)); // work-days
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
          const dx = Math.round((e.clientX - d.startX) / (weekW / 5)); // work-days
          if (d.mode === "move") {
            const newResource =
              view === "engineer" && hover != null
                ? hover === 0
                  ? null
                  : hover
                : a.resource_id ?? null;
            if (dx === 0 && newResource === (a.resource_id ?? null)) return;
            const patch = {
              start_date: addWorkdays(a.start_date, dx),
              end_date: addWorkdays(a.end_date, dx),
              resource_id: newResource,
            };
            patchLocal(a.id, patch);
            await saveAssign(a, patch);
            const inv = { start_date: a.start_date, end_date: a.end_date, resource_id: a.resource_id ?? null };
            pushUndo("move", async () => { patchLocal(a.id, inv); await saveAssign(a, inv, { force: true }); });
          } else if (d.mode === "l") {
            if (dx === 0) return;
            const os = a.start_date;
            let ns = addWorkdays(a.start_date, dx);
            if (parseISO(ns) > parseISO(a.end_date)) ns = a.end_date;
            if (ns === a.start_date) return;
            patchLocal(a.id, { start_date: ns });
            await saveAssign(a, { start_date: ns });
            pushUndo("resize", async () => { patchLocal(a.id, { start_date: os }); await saveAssign(a, { start_date: os }, { force: true }); });
          } else {
            if (dx === 0) return;
            const oe = a.end_date;
            let ne = addWorkdays(a.end_date, dx);
            if (parseISO(ne) < parseISO(a.start_date)) ne = a.start_date;
            if (ne === a.end_date) return;
            patchLocal(a.id, { end_date: ne });
            await saveAssign(a, { end_date: ne });
            pushUndo("resize", async () => { patchLocal(a.id, { end_date: oe }); await saveAssign(a, { end_date: oe }, { force: true }); });
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
      } catch (e) {
        await onWriteError(e);
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
    onBarMenu: (e, a) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, a }); },
    onCellAdd: (resourceId, weekIso) => setAddPreset({ resourceId, start: weekIso }),
    onCellMenu: (e, resourceId, weekIso) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, resourceId, weekIso }); },
    onTimeOffMenu: (e, t) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, timeoff: t }); },
  };
  const gridWidth = LABEL_W + weeks.length * weekW;

  async function patchProjectField(projectId: number, patch: Partial<TimelineProject>) {
    const ev = board?.projects.find((p) => p.id === projectId)?.version;
    setBoard((b) =>
      b ? { ...b, projects: b.projects.map((p) => (p.id === projectId ? { ...p, ...patch } : p)) } : b,
    );
    try {
      await patchTimelineProject(projectId, { ...patch, expected_version: ev });
      setConflict(null);
      await reload(); // refresh client pick-list / status / name
    } catch (e) {
      await onWriteError(e);
    }
  }
  async function deleteProject(projectId: number) {
    const p = board?.projects.find((x) => x.id === projectId);
    const ok = await confirm({
      title: `Delete project “${p?.name ?? ""}”?`,
      body: "This removes the project and all of its assignment bars. This can't be undone.",
      confirmLabel: "Delete project",
      destructive: true,
    });
    if (!ok) return;
    setBoard((b) =>
      b ? {
        ...b,
        projects: b.projects.filter((x) => x.id !== projectId),
        assignments: b.assignments.filter((a) => a.timeline_project_id !== projectId),
      } : b,
    );
    try {
      await deleteTimelineProject(projectId);
    } catch {
      await reload();
    }
  }

  return (
    <div className="space-y-4 select-none">
      {/* shared client pick-list (used by New Project panel + per-project editor) */}
      <datalist id="timeline-clients">{(board?.clients ?? []).map((c) => <option key={c} value={c} />)}</datalist>
      <PageHeader
        title="Timeline Estimator"
        subtitle="Capacity planner — each cell is a work-week. Drag bars to reschedule, drag edges to resize, right-click for options."
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-ghost text-sm" onClick={() => setShowResources(true)}>
              👥 Resources
            </button>
            <button className="btn-primary text-sm" onClick={() => setShowNewProject((v) => !v)}>
              {showNewProject ? "✕ Close form" : "+ New project"}
            </button>
          </div>
        }
      />

      {/* toolbar */}
      <div className="card flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs">
        <Segmented
          options={[
            ["engineer", "By engineer"],
            ["project", "By project"],
            ["workload", "Workload"],
          ]}
          value={view}
          onChange={(v) => setView(v as View)}
        />
        <Divider />
        <Segmented options={Object.keys(ZOOMS).map((z) => [z, z] as [string, string])} value={zoom} onChange={setZoom} />
        <button className="btn-ghost py-1 px-2.5" onClick={jumpToToday}>Today</button>
        <button
          className="btn-ghost py-1 px-2.5 disabled:opacity-40"
          onClick={() => void doUndo()}
          disabled={undoStack.length === 0}
          title={undoStack.length ? `Undo ${undoStack[undoStack.length - 1].label} (Ctrl+Z)` : "Nothing to undo"}
        >
          ↩ Undo{undoStack.length ? ` (${undoStack.length})` : ""}
        </button>
        <Divider />
        <FilterMenu label="Discipline" options={DISCIPLINES} selected={discFilter} onChange={setDiscFilter} />
        <FilterMenu
          label="Status"
          options={STATUSES.map((s) => s.value)}
          labels={Object.fromEntries(STATUSES.map((s) => [s.value, s.label]))}
          selected={statusFilter}
          onChange={setStatusFilter}
        />
        <Divider />
        <label className="flex items-center gap-1 text-brand-gray">
          <span className="text-[10px] uppercase tracking-wider">From</span>
          <input type="date" className="rounded-md border border-slate-300 px-2 py-1" value={winStart} onChange={(e) => setWinStart(e.target.value)} />
        </label>
        <label className="flex items-center gap-1 text-brand-gray">
          <span className="text-[10px] uppercase tracking-wider">To</span>
          <input type="date" className="rounded-md border border-slate-300 px-2 py-1" value={winEnd} onChange={(e) => setWinEnd(e.target.value)} />
        </label>
        {(winStart || winEnd) && (
          <button className="text-brand-red hover:underline" onClick={() => { setWinStart(""); setWinEnd(""); }}>reset</button>
        )}
        <div className="flex-1" />
        <LiveDot lastSync={lastSync} onRefresh={() => void reload()} />
        <Divider />
        <LegendMenu />
      </div>

      {loading && <div className="text-sm text-brand-gray">Loading timeline…</div>}
      {error && <div className="text-sm text-brand-red">{error}</div>}
      {conflict && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>⚠️ {conflict}</span>
          <button className="ml-auto text-amber-800/70 hover:text-amber-900" onClick={() => setConflict(null)}>dismiss</button>
        </div>
      )}

      {board && !loading && (
        <div className="flex gap-4 items-start">
          <div className="flex-1 min-w-0">
            {view === "workload" ? (
              <WorkloadView board={board} load={load} />
            ) : board.assignments.length === 0 && board.resources.length === 0 ? (
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
                      "shrink-0 px-1.5 py-2.5 text-xs text-center border-r border-brand-lightgray/80",
                      i === todayCol ? "text-brand-red font-semibold" : "text-brand-gray",
                    )}
                    style={{ width: weekW }}
                  >
                    {format(parseISO(w), "d-MMM")}
                  </div>
                ))}
              </div>

              {/* today line — positioned at today's work-day */}
              {weeks.length > 0 && (() => {
                const tp = workdayPos(todayISO(), weeks[0]);
                if (tp < 0 || tp >= weeks.length * 5) return null;
                return (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-brand-red/50 z-10 pointer-events-none"
                    style={{ left: LABEL_W + tp * (weekW / 5) }}
                  />
                );
              })()}

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
                  onPatchProject={patchProjectField}
                  onDeleteProject={deleteProject}
                />
              )}
            </div>
          </div>
            )}
          </div>
          {showNewProject ? (
            <NewProjectPanel board={board} onClose={() => setShowNewProject(false)} onSaved={() => void reload()} />
          ) : (
            <button
              onClick={() => setShowNewProject(true)}
              title="Open New project panel"
              className="shrink-0 self-start sticky top-4 card flex flex-col items-center gap-2 py-3 text-brand-red hover:bg-rose-50 transition"
              style={{ width: 38 }}
            >
              <span className="text-lg leading-none">＋</span>
              <span className="[writing-mode:vertical-rl] text-[11px] font-semibold uppercase tracking-wider">New project</span>
            </button>
          )}
        </div>
      )}
      {showResources && (
        <ResourceManagerDialog onClose={() => setShowResources(false)} onChanged={() => void reload()} />
      )}
      {(editing || addingToProject !== null || addPreset) && board && (
        <AssignmentDialog
          board={board}
          assignment={editing}
          projectId={addingToProject ?? editing?.timeline_project_id ?? null}
          presetResourceId={addPreset ? addPreset.resourceId : undefined}
          presetStart={addPreset ? addPreset.start : undefined}
          onClose={() => { setEditing(null); setAddingToProject(null); setAddPreset(null); }}
          onSaved={() => { setEditing(null); setAddingToProject(null); setAddPreset(null); void reload(); }}
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

      {menu && board && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onEdit={(a) => { setMenu(null); setEditing(a); }}
          onDuplicate={duplicateAssignment}
          onDelete={deleteAssignment}
          onUnassign={(a) => quickPatch(a, { resource_id: null }, "unassign")}
          onSetStatus={(a, s) => quickPatch(a, { status: s }, "status")}
          onSetUtil={(a, u) => quickPatch(a, { utilization: u }, "utilization")}
          onAddHere={(resId, wk) => { setMenu(null); setAddPreset({ resourceId: resId, start: wk }); }}
          onBlockTime={(resId, wk) => { setMenu(null); if (resId != null) setTimeOffPreset({ resourceId: resId, start: wk }); }}
          onRemoveTimeOff={removeTimeOff}
        />
      )}

      {timeOffPreset && board && (
        <TimeOffDialog
          board={board}
          preset={timeOffPreset}
          onClose={() => setTimeOffPreset(null)}
          onSaved={() => { setTimeOffPreset(null); void reload(); }}
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

function Divider() {
  return <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />;
}
function LiveDot({ lastSync, onRefresh }: { lastSync: number; onRefresh: () => void }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, []);
  const secs = lastSync ? Math.max(0, Math.round((Date.now() - lastSync) / 1000)) : null;
  const ago = secs == null ? "" : secs < 5 ? "just now" : secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  return (
    <button
      onClick={onRefresh}
      title="Live — the board auto-refreshes every ~12s and when you focus the tab, so other PMs' changes appear here. Click to refresh now."
      className="inline-flex items-center gap-1.5 font-semibold text-brand-gray hover:text-slate-900"
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
      </span>
      Live{ago ? ` · ${ago}` : ""}
    </button>
  );
}
function LegendMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button
        className="rounded-full border border-slate-200 px-3 py-1 font-semibold text-slate-500 hover:text-slate-900"
        onClick={() => setOpen((o) => !o)}
      >
        Legend
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-60 bg-white border border-slate-200 rounded-lg shadow-lg p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-brand-gray">Status</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {STATUSES.map((s) => (
              <span key={s.value} className="inline-flex items-center gap-1.5 text-[11px] text-slate-700">
                <span className="inline-block h-3 w-3 rounded" style={{ background: s.bg }} />
                {s.label}
              </span>
            ))}
          </div>
          <div className="border-t border-slate-100 pt-2 text-[10px] uppercase tracking-wider text-brand-gray">Cell utilization</div>
          <div className="flex flex-col gap-1.5 text-[11px] text-slate-700">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded border border-brand-lightgray" style={{ background: "#eaf6ee" }} /> ≤ 100% (has capacity)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded border border-brand-lightgray" style={{ background: "#fce8ea" }} /> &gt; 100% over-allocated
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded" style={{ background: "#eceef1" }} /> time off / not started
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- bar ----------------
function Bar({ a, ctx, top = 4, height = ROW_H - 8 }: { a: TimelineAssignment; ctx: Ctx; top?: number; height?: number }) {
  const { weeks, weekW, drag } = ctx;
  if (!weeks.length) return null;
  const fm = weeks[0];
  const total = weeks.length * 5;            // total work-days on the board
  const dw = weekW / 5;                       // px per work-day
  let sPos = workdayPos(a.start_date, fm);
  let ePos = workdayPos(a.end_date, fm) + 1;  // inclusive end -> exclusive boundary
  const active = drag && drag.id === a.id;
  if (active) {
    if (drag!.mode === "move") { sPos += drag!.dx; ePos += drag!.dx; }
    else if (drag!.mode === "l") sPos += drag!.dx;
    else ePos += drag!.dx;
    if (ePos < sPos + 1) ePos = sPos + 1;     // keep at least one work-day
  }
  // cull bars fully outside the window (keep while actively dragging)
  if (!active && (ePos <= 0 || sPos >= total)) return null;
  const st = STATUS_MAP[a.effective_status || "in_progress"] || STATUS_MAP["in_progress"];

  const vS = active ? sPos : Math.max(0, sPos);
  const vE = active ? ePos : Math.min(total, ePos);
  const left = vS * dw + 2;
  const width = Math.max(dw - 4, (vE - vS) * dw - 4);
  const util = a.utilization != null ? `${Math.round(a.utilization * 100)}%` : "";

  return (
    <div
      onPointerDown={(e) => ctx.onBarDown(e, a, "move")}
      onDoubleClick={(e) => { e.stopPropagation(); ctx.onEditBar(a); }}
      onContextMenu={(e) => ctx.onBarMenu(e, a)}
      title={`${a.project_name || a.label || ""} · ${a.discipline}${a.milestone ? " · " + a.milestone : ""} · ${util}  (double-click to edit · right-click for options)`}
      className={clsx(
        "absolute rounded text-xs font-medium truncate px-2.5 cursor-grab active:cursor-grabbing group",
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
      {!a.label && a.milestone ? ` ${a.milestone}` : ""} · {util}
    </div>
  );
}
function Track({ ctx, children }: { ctx: Ctx; children?: ReactNode }) {
  const { weeks, weekW } = ctx;
  return (
    <div className="relative shrink-0" style={{ width: weeks.length * weekW, height: ROW_H }}>
      <div className="absolute inset-0 flex">
        {weeks.map((w) => (
          <div key={w} className="border-r border-brand-lightgray/60" style={{ width: weekW }} />
        ))}
      </div>
      <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: dayGridBg(weekW) }} />
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
  const weekAt = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.max(0, Math.min(weeks.length - 1, Math.floor((e.clientX - rect.left) / weekW)));
    return weeks[i];
  };
  const timeoffByRes = useMemo(() => {
    const m = new Map<number, TimelineTimeOff[]>();
    for (const t of board.timeoff || [])
      (m.get(t.resource_id) || m.set(t.resource_id, []).get(t.resource_id)!).push(t);
    return m;
  }, [board.timeoff]);

  return (
    <div>
      {groups.map((g) => (
        <div key={g.discipline}>
          <button
            className="flex w-full bg-slate-400/80 border-y border-brand-lightgray/60 sticky left-0"
            onClick={() => onToggle(g.discipline)}
          >
            <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-900 flex items-center gap-1" style={{ width: LABEL_W }}>
              {collapsed.has(g.discipline) ? "▸" : "▾"} <DiscTag d={g.discipline} /> {g.discipline} · {g.rows.length}
            </div>
          </button>
          {!collapsed.has(g.discipline) &&
            g.rows.map((r) => {
              const rowAssignments = byResource.get(r.id) || [];
              const cells = load[String(r.id)] || [];
              const avail = board.availability?.[String(r.id)] || [];
              const tos = timeoffByRes.get(r.id) || [];
              const isHover = hoverRes === r.id && drag != null;
              const { placed, lanes } = packLanes(rowAssignments, weeks);
              const rowH = lanes * LANE_H;
              return (
                <div
                  key={r.id}
                  data-res-row={r.id}
                  className={clsx(
                    "flex items-stretch border-b border-brand-lightgray/60",
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
                  <div
                    className="relative shrink-0"
                    style={{ width: weeks.length * weekW, height: rowH }}
                    onDoubleClick={(e) => { const w = weekAt(e); if (w) ctx.onCellAdd(r.id, w); }}
                    onContextMenu={(e) => { const w = weekAt(e); if (w) ctx.onCellMenu(e, r.id, w); }}
                    title="Double-click an empty cell to add a project · right-click for options"
                  >
                    {/* utilization heat behind the bars (hover a cell for the %) */}
                    {weeks.map((w, i) => {
                      const v = cells[i] || 0;
                      const a = avail[i] ?? 1;
                      const blocked = a < 0.999;
                      const over = v > a + 0.0001;
                      return (
                        <div
                          key={w}
                          className="absolute top-0 border-r border-brand-lightgray/60"
                          style={{
                            left: i * weekW,
                            width: weekW,
                            height: rowH,
                            background: over ? "#fce8ea" : blocked ? "#eceef1" : v > 0 ? "#eaf6ee" : "transparent",
                          }}
                          title={
                            blocked
                              ? `${Math.round((1 - a) * 100)}% time off${v > 0 ? `, ${Math.round(v * 100)}% load` : ""}`
                              : v > 0
                                ? `${Math.round(v * 100)}% utilized`
                                : ""
                          }
                        />
                      );
                    })}
                    {/* faint day grid (5 work-days per cell) */}
                    <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: dayGridBg(weekW) }} />
                    {/* time-off bands (right-click to remove) */}
                    {tos.map((t) => {
                      const dwpx = weekW / 5;
                      const total = weeks.length * 5;
                      const sP = Math.max(0, workdayPos(t.start_date, weeks[0]));
                      const eP = Math.min(total, workdayPos(t.end_date, weeks[0]) + 1);
                      if (eP <= 0 || sP >= total || eP <= sP) return null;
                      return (
                        <div
                          key={`to-${t.id}`}
                          onContextMenu={(ev) => ctx.onTimeOffMenu(ev, t)}
                          title={`${t.reason || "OOO"} — right-click to remove`}
                          className="absolute top-0 z-[1] flex items-center gap-1 px-1.5 text-[10px] font-semibold text-slate-500 truncate"
                          style={{
                            left: sP * dwpx + 1,
                            width: (eP - sP) * dwpx - 2,
                            height: rowH,
                            background:
                              "repeating-linear-gradient(45deg,#e5e7eb,#e5e7eb 6px,#eef0f2 6px,#eef0f2 12px)",
                            border: "1px solid #d1d5db",
                            borderRadius: 4,
                          }}
                        >
                          🛇 {t.reason || "OOO"}
                        </div>
                      );
                    })}
                    {/* pre-start block: weeks before a placeholder's start date */}
                    {r.available_from && (() => {
                      const dwpx = weekW / 5;
                      const endPos = Math.min(weeks.length * 5, workdayPos(r.available_from, weeks[0]));
                      if (endPos <= 0) return null;
                      return (
                        <div
                          title={`Not started yet — available from ${format(parseISO(r.available_from), "d MMM yyyy")}`}
                          className="absolute top-0 z-[1] flex items-center gap-1 px-1.5 text-[10px] font-semibold text-violet-700 truncate"
                          style={{
                            left: 1,
                            width: endPos * dwpx - 2,
                            height: rowH,
                            background: "repeating-linear-gradient(45deg,#ede9fe,#ede9fe 6px,#f5f3ff 6px,#f5f3ff 12px)",
                            border: "1px dashed #c4b5fd",
                            borderRadius: 4,
                          }}
                        >
                          ⏳ Starts {format(parseISO(r.available_from), "d MMM")}
                        </div>
                      );
                    })()}
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
              <div className="flex bg-slate-400/80 border-y border-brand-lightgray/60">
                <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-900" style={{ width: LABEL_W }}>
                  Unassigned
                </div>
              </div>
              <div className="flex items-stretch border-b border-brand-lightgray/60">
                <LabelCell height={rowH}>
                  <span className="text-xs text-brand-gray">Drag a bar onto an engineer →</span>
                </LabelCell>
                <div
                  className="relative shrink-0"
                  style={{ width: weeks.length * weekW, height: rowH }}
                  onDoubleClick={(e) => { const w = weekAt(e); if (w) ctx.onCellAdd(null, w); }}
                  onContextMenu={(e) => { const w = weekAt(e); if (w) ctx.onCellMenu(e, null, w); }}
                >
                  {weeks.map((w, i) => (
                    <div key={w} className="absolute top-0 border-r border-brand-lightgray/60" style={{ left: i * weekW, width: weekW, height: rowH }} />
                  ))}
                  <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: dayGridBg(weekW) }} />
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
  onPatchProject,
  onDeleteProject,
}: {
  board: TimelineBoard;
  assignments: TimelineAssignment[];
  ctx: Ctx;
  onAddTo: (projectId: number) => void;
  onPatchProject: (projectId: number, patch: Partial<TimelineProject>) => void;
  onDeleteProject: (projectId: number) => void;
}) {
  const { weeks, weekW } = ctx;
  const [edit, setEdit] = useState<{ id: number; field: "client" | "name"; val: string } | null>(null);
  const startEdit = (id: number, field: "client" | "name", val: string | null | undefined) => setEdit({ id, field, val: val || "" });
  const commit = () => {
    if (!edit) return;
    const v = edit.val.trim();
    if (edit.field === "name") { if (v) onPatchProject(edit.id, { name: v }); }
    else onPatchProject(edit.id, { client: v || null });
    setEdit(null);
  };
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
          <div key={p.id} className="border-b border-brand-lightgray/60">
            <div className="flex items-stretch bg-slate-50/60">
              <LabelCell>
                {edit?.id === p.id && edit.field === "name" ? (
                  <input
                    autoFocus
                    className="w-full rounded border border-slate-300 px-1.5 py-0.5 text-sm"
                    value={edit.val}
                    onChange={(e) => setEdit({ ...edit, val: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEdit(null); }}
                    onBlur={commit}
                  />
                ) : (
                  <button className="w-full truncate text-left hover:text-brand-red" title="Click to rename" onClick={() => startEdit(p.id, "name", p.name)}>
                    <span className="font-medium">{p.name}</span>
                    {p.client && <span className="text-brand-gray text-xs"> · {p.client}</span>}
                  </button>
                )}
              </LabelCell>
              <div className="relative shrink-0 flex items-center gap-2 px-2" style={{ width: weeks.length * weekW, height: ROW_H }}>
                <select
                  value={p.status}
                  title="Change status"
                  onChange={(e) => onPatchProject(p.id, { status: e.target.value })}
                  className="text-[10px] rounded px-1 py-0.5 font-medium border-0 cursor-pointer"
                  style={{ background: st.bg, color: st.fg }}
                >
                  {STATUSES.map((s) => (
                    <option key={s.value} value={s.value} style={{ background: "#fff", color: "#1a1a1a" }}>{s.label}</option>
                  ))}
                </select>
                {edit?.id === p.id && edit.field === "client" ? (
                  <span className="inline-flex items-center gap-1">
                    <input
                      list="timeline-clients"
                      autoFocus
                      className="rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                      style={{ width: 190 }}
                      placeholder="Pick or type a client"
                      value={edit.val}
                      onChange={(e) => setEdit({ ...edit, val: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEdit(null); }}
                    />
                    <button className="text-[11px] text-brand-red font-semibold hover:underline" onClick={commit}>Save</button>
                    <button className="text-[11px] text-brand-gray hover:underline" onClick={() => setEdit(null)}>cancel</button>
                  </span>
                ) : (
                  <button className="text-[11px] text-brand-gray hover:text-brand-red" title="Set / change client" onClick={() => startEdit(p.id, "client", p.client)}>
                    {p.client ? "✎ client" : "✎ set client"}
                  </button>
                )}
                <button className="text-[11px] text-brand-red hover:underline" onClick={() => onAddTo(p.id)}>
                  + add assignment
                </button>
                <button className="text-sm text-brand-gray hover:text-brand-red ml-auto" title="Delete project" onClick={() => onDeleteProject(p.id)}>
                  🗑
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

function NewProjectPanel({ board, onClose, onSaved }: { board: TimelineBoard | null; onClose: () => void; onSaved: () => void }) {
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
  const [done, setDone] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) { setErr("Project name is required."); return; }
    setSaving(true); setErr(null); setDone(null);
    try {
      const p = await createTimelineProject({ name, client: client || null, status });
      if (start && end)
        await createTimelineAssignment({ timeline_project_id: p.id, resource_id: resourceId ? Number(resourceId) : null, discipline, milestone: milestone || null, start_date: start, end_date: end, utilization: util });
      // keep the panel open for rapid entry; just reset + refresh the board
      setDone(`Added “${name.trim()}”.`);
      setName(""); setClient(""); setStatus("in_progress");
      setResourceId(""); setMilestone(""); setStart(""); setEnd(""); setUtil(1.0);
      setSaving(false);
      onSaved();
    } catch (e: any) { setErr(e?.response?.data?.detail || e?.message || "Save failed"); setSaving(false); }
  }
  return (
    <div className="card w-[320px] shrink-0 p-4 sticky top-4 self-start">
      <div className="flex items-center justify-between mb-3">
        <h3 className="section-title">New project</h3>
        <button className="text-brand-gray hover:text-brand-red text-xl leading-none" title="Close panel" onClick={onClose}>×</button>
      </div>
      <div className="space-y-3">
        <Field label="Project name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Client">
          <input className={inputCls} list="timeline-clients" placeholder="Pick a client or type a new one" value={client} onChange={(e) => setClient(e.target.value)} />
        </Field>
        <Field label="Status"><select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>{STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
        <div className="border-t border-brand-lightgray/60 pt-3 text-[11px] uppercase tracking-wider text-brand-gray">First assignment (optional)</div>
        <Field label="Assigned to"><select className={inputCls} value={resourceId} onChange={(e) => setResourceId(e.target.value)}><option value="">Unassigned</option>{(board?.resources ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Discipline"><select className={inputCls} value={discipline} onChange={(e) => setDiscipline(e.target.value)}>{DISCIPLINES.map((d) => <option key={d}>{d}</option>)}</select></Field>
          <Field label="% Utilization"><select className={inputCls} value={util} onChange={(e) => setUtil(Number(e.target.value))}>{UTILS.map((u) => <option key={u} value={u}>{Math.round(u * 100)}%</option>)}</select></Field>
          <Field label="Start"><input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="End"><input type="date" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <Field label="Milestone"><select className={inputCls} value={milestone} onChange={(e) => setMilestone(e.target.value)}>{MILESTONES.map((m) => <option key={m} value={m}>{m || "—"}</option>)}</select></Field>
        {err && <div className="text-sm text-brand-red">{err}</div>}
        {done && <div className="text-xs text-green-600">{done} Add another or close ×.</div>}
        <button className="btn-primary w-full" onClick={save} disabled={saving}>{saving ? "Saving…" : "Create project"}</button>
      </div>
    </div>
  );
}

function AssignmentDialog({ board, assignment, projectId, presetResourceId, presetStart, onClose, onSaved, onDelete }: { board: TimelineBoard; assignment: TimelineAssignment | null; projectId: number | null; presetResourceId?: number | null; presetStart?: string | null; onClose: () => void; onSaved: () => void; onDelete: () => void }) {
  const isEdit = !!assignment;
  // "combo" = creating a brand-new assignment from a blank cell — let the PM
  // type a new or existing project name (find-or-create), pre-seed resource/date.
  const combo = !isEdit && projectId == null;
  const [pid, setPid] = useState(String(projectId ?? assignment?.timeline_project_id ?? ""));
  const [projName, setProjName] = useState("");
  const [resourceId, setResourceId] = useState(
    assignment?.resource_id != null ? String(assignment.resource_id)
      : presetResourceId != null ? String(presetResourceId) : "",
  );
  const presetDisc =
    presetResourceId != null
      ? board.resources.find((r) => r.id === presetResourceId)?.discipline
      : undefined;
  const [discipline, setDiscipline] = useState(assignment?.discipline || presetDisc || "Electrical");
  const [milestone, setMilestone] = useState(assignment?.milestone || "");
  const [start, setStart] = useState(assignment?.start_date || presetStart || "");
  const [end, setEnd] = useState(
    assignment?.end_date || (presetStart ? shiftISO(presetStart, 4) : ""),
  );
  const [util, setUtil] = useState(assignment?.utilization ?? 1.0);
  const [statusOverride, setStatusOverride] = useState(assignment?.status || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if ((!combo && !pid) || (combo && !projName.trim()) || !start || !end) {
      setErr("Project, start, and end are required."); return;
    }
    setSaving(true); setErr(null);
    const body = { resource_id: resourceId ? Number(resourceId) : null, discipline, milestone: milestone || null, start_date: start, end_date: end, utilization: util, status: statusOverride || null };
    try {
      if (isEdit && assignment) {
        await patchTimelineAssignment(assignment.id, { ...body, expected_version: assignment.version });
      } else {
        let targetPid = Number(pid);
        if (combo) {
          const typed = projName.trim();
          const existing = board.projects.find((p) => p.name.toLowerCase() === typed.toLowerCase());
          targetPid = existing ? existing.id : (await createTimelineProject({ name: typed })).id;
        }
        await createTimelineAssignment({ ...body, timeline_project_id: targetPid });
      }
      onSaved();
    } catch (e: any) {
      const d = e?.response?.data?.detail;
      const msg = e?.response?.status === 409
        ? "Someone else changed this assignment while you had it open. Close and reopen to see their version."
        : (typeof d === "string" ? d : d?.message) || e?.message || "Save failed";
      setErr(msg); setSaving(false);
    }
  }
  return (
    <Modal title={isEdit ? "Edit assignment" : "Add assignment"} onClose={onClose}>
      <div className="space-y-3">
        {combo ? (
          <Field label="Project (type a new name or pick an existing one)">
            <input className={inputCls} list="timeline-projects" value={projName} onChange={(e) => setProjName(e.target.value)} placeholder="e.g. Snapdragon Substation" autoFocus />
            <datalist id="timeline-projects">{board.projects.map((p) => <option key={p.id} value={p.name} />)}</datalist>
          </Field>
        ) : (
          <Field label="Project"><select className={inputCls} value={pid} onChange={(e) => setPid(e.target.value)} disabled={isEdit}><option value="">— pick —</option>{board.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        )}
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
  const [availFrom, setAvailFrom] = useState("");
  const [linkingId, setLinkingId] = useState<number | null>(null);
  const [linkName, setLinkName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() { setResources(await listTimelineResources(true)); }
  useEffect(() => { void load(); listGlobalRoster().then(setRoster).catch(() => setRoster([])); }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createTimelineResource({ name: name.trim(), discipline, title: title || null, is_placeholder: placeholder, available_from: (placeholder && availFrom) ? availFrom : null, order_index: resources.length });
      setName(""); setTitle(""); setPlaceholder(false); setAvailFrom("");
      await load(); onChanged();
    } finally { setBusy(false); }
  }
  async function setDisc(r: TimelineResource, d: string) { await patchTimelineResource(r.id, { discipline: d }); await load(); onChanged(); }
  async function setAvail(r: TimelineResource, v: string) { await patchTimelineResource(r.id, { available_from: v || null }); await load(); onChanged(); }
  async function toggleActive(r: TimelineResource) { await patchTimelineResource(r.id, { active: !r.active }); await load(); onChanged(); }
  async function linkToPerson(r: TimelineResource) {
    const nm = linkName.trim();
    if (!nm) return;
    // Hiring a placeholder: take the real person's name, drop placeholder
    // status (and the potential-start block — they've started).
    await patchTimelineResource(r.id, { name: nm, is_placeholder: false, available_from: null });
    setLinkingId(null); setLinkName("");
    await load(); onChanged();
  }
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
          {placeholder && (
            <label className="flex items-center gap-2 text-xs text-brand-gray">
              Potential start date
              <input type="date" className="rounded border border-slate-200 px-2 py-1" value={availFrom} onChange={(e) => setAvailFrom(e.target.value)} />
              <span className="text-[11px]">(weeks before are blocked)</span>
            </label>
          )}
          <button className="btn-primary text-sm" onClick={add} disabled={busy || !name.trim()}>{busy ? "Adding…" : "Add resource"}</button>
        </div>
        <div className="max-h-80 overflow-y-auto divide-y divide-brand-lightgray/40">
          {resources.map((r) => (
            <div key={r.id} className="py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className={clsx("flex-1 truncate", !r.active && "text-brand-gray line-through")}>
                  <DiscTag d={r.discipline} />
                  {r.name}{r.title && <span className="text-brand-gray text-xs"> · {r.title}</span>}
                  {r.is_placeholder && <span className="ml-1 text-[10px] px-1 rounded bg-violet-100 text-violet-700">placeholder</span>}
                </span>
                <select className="rounded border border-slate-200 text-xs px-1 py-0.5" value={r.discipline} onChange={(e) => void setDisc(r, e.target.value)}>{DISCIPLINES.map((d) => <option key={d}>{d}</option>)}</select>
                <button className="text-xs text-brand-gray hover:text-brand-red" onClick={() => void toggleActive(r)}>{r.active ? "Hide" : "Show"}</button>
                <button className="text-xs text-brand-red hover:underline" onClick={() => void remove(r)}>Remove</button>
              </div>
              {r.is_placeholder && (
                <div className="flex flex-wrap items-center gap-2 pl-1 pt-1.5 text-xs text-brand-gray">
                  <span>Starts</span>
                  <input type="date" className="rounded border border-slate-200 px-1.5 py-0.5" value={r.available_from || ""} onChange={(e) => void setAvail(r, e.target.value)} />
                  <span className="text-brand-lightgray">·</span>
                  {linkingId === r.id ? (
                    <span className="inline-flex items-center gap-1">
                      <input list="timeline-roster" autoFocus className="rounded border border-slate-200 px-1.5 py-0.5" placeholder="Real person's name" value={linkName} onChange={(e) => setLinkName(e.target.value)} />
                      <button className="text-brand-red font-semibold hover:underline" onClick={() => void linkToPerson(r)}>Link</button>
                      <button className="text-brand-gray hover:underline" onClick={() => { setLinkingId(null); setLinkName(""); }}>cancel</button>
                    </span>
                  ) : (
                    <button className="text-brand-red hover:underline" onClick={() => { setLinkingId(r.id); setLinkName(""); }}>🔗 Link to person…</button>
                  )}
                </div>
              )}
            </div>
          ))}
          {resources.length === 0 && <div className="py-3 text-sm text-brand-gray">No resources yet.</div>}
        </div>
      </div>
    </Modal>
  );
}

// ---------------- right-click context menu ----------------
type MenuState = { x: number; y: number; a?: TimelineAssignment; resourceId?: number | null; weekIso?: string; timeoff?: TimelineTimeOff };
function ContextMenu({
  menu, onClose, onEdit, onDuplicate, onDelete, onUnassign, onSetStatus, onSetUtil, onAddHere, onBlockTime, onRemoveTimeOff,
}: {
  menu: MenuState;
  onClose: () => void;
  onEdit: (a: TimelineAssignment) => void;
  onDuplicate: (a: TimelineAssignment) => void;
  onDelete: (a: TimelineAssignment) => void;
  onUnassign: (a: TimelineAssignment) => void;
  onSetStatus: (a: TimelineAssignment, status: string) => void;
  onSetUtil: (a: TimelineAssignment, util: number) => void;
  onAddHere: (resourceId: number | null, weekIso: string) => void;
  onBlockTime: (resourceId: number | null, weekIso: string) => void;
  onRemoveTimeOff: (t: TimelineTimeOff) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);

  const a = menu.a;
  const left = Math.min(menu.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 230);
  const top = Math.min(menu.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 380);

  return (
    <div ref={ref} className="fixed z-[60] w-56 bg-white border border-slate-200 rounded-lg shadow-xl py-1 text-sm" style={{ left, top }}>
      {a ? (
        <>
          <div className="px-3 py-1 text-[11px] text-brand-gray truncate">{a.project_name || a.label || "Assignment"}</div>
          <MenuItem onClick={() => onEdit(a)}>✎ Edit…</MenuItem>
          <MenuItem onClick={() => onDuplicate(a)}>⧉ Duplicate</MenuItem>
          {a.resource_id != null && <MenuItem onClick={() => onUnassign(a)}>⇤ Unassign</MenuItem>}
          <div className="border-t border-slate-100 my-1" />
          <div className="px-3 py-0.5 text-[10px] uppercase tracking-wider text-brand-gray">Set status</div>
          {STATUSES.map((s) => (
            <MenuItem key={s.value} onClick={() => onSetStatus(a, s.value)}>
              <span className="inline-block h-2.5 w-2.5 rounded mr-2 align-middle" style={{ background: s.bg }} />
              {s.label}
              {(a.status || a.effective_status) === s.value && <span className="ml-auto text-brand-red">✓</span>}
            </MenuItem>
          ))}
          <div className="border-t border-slate-100 my-1" />
          <div className="px-3 py-0.5 text-[10px] uppercase tracking-wider text-brand-gray">Utilization</div>
          <div className="flex flex-wrap gap-1 px-3 pb-1.5 pt-0.5">
            {UTILS.map((u) => (
              <button
                key={u}
                className={clsx(
                  "text-[11px] rounded border px-1.5 py-0.5 hover:border-brand-red hover:text-brand-red",
                  Math.abs((a.utilization ?? 1) - u) < 0.001 ? "border-brand-red text-brand-red" : "border-slate-200 text-slate-600",
                )}
                onClick={() => onSetUtil(a, u)}
              >
                {Math.round(u * 100)}%
              </button>
            ))}
          </div>
          <div className="border-t border-slate-100 my-1" />
          <MenuItem destructive onClick={() => onDelete(a)}>🗑 Delete</MenuItem>
        </>
      ) : menu.timeoff ? (
        <>
          <div className="px-3 py-1 text-[11px] text-brand-gray truncate">🛇 {menu.timeoff.reason || "OOO"}</div>
          <MenuItem destructive onClick={() => onRemoveTimeOff(menu.timeoff!)}>🗑 Remove time off</MenuItem>
        </>
      ) : (
        <>
          <div className="px-3 py-1 text-[11px] text-brand-gray">
            {menu.weekIso ? `Week of ${format(parseISO(menu.weekIso), "d MMM yyyy")}` : ""}
          </div>
          <MenuItem onClick={() => menu.weekIso && onAddHere(menu.resourceId ?? null, menu.weekIso)}>
            + Add project here…
          </MenuItem>
          {menu.resourceId != null && (
            <MenuItem onClick={() => menu.weekIso && onBlockTime(menu.resourceId ?? null, menu.weekIso)}>
              🛇 Block time off (OOO)…
            </MenuItem>
          )}
        </>
      )}
    </div>
  );
}
function MenuItem({ children, onClick, destructive }: { children: ReactNode; onClick: () => void; destructive?: boolean }) {
  return (
    <button
      className={clsx("flex w-full items-center px-3 py-1.5 text-left hover:bg-slate-50", destructive ? "text-brand-red" : "text-slate-700")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ---------------- time-off dialog ----------------
const TIMEOFF_REASONS = ["OOO", "PTO", "Holiday", "Training", "Sick", "Conference"];
function TimeOffDialog({
  board, preset, onClose, onSaved,
}: {
  board: TimelineBoard;
  preset: { resourceId: number; start: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const resource = board.resources.find((r) => r.id === preset.resourceId);
  const [start, setStart] = useState(preset.start);
  const [end, setEnd] = useState(shiftISO(preset.start, 4)); // Mon..Fri of that week
  const [reason, setReason] = useState("OOO");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!start || !end) { setErr("Start and end are required."); return; }
    if (parseISO(end) < parseISO(start)) { setErr("End must be on or after start."); return; }
    setSaving(true); setErr(null);
    try {
      await createTimelineTimeOff({
        resource_id: preset.resourceId,
        start_date: start,
        end_date: end,
        reason: reason.trim() || "OOO",
      });
      onSaved();
    } catch (e: any) { setErr(e?.response?.data?.detail || e?.message || "Save failed"); setSaving(false); }
  }
  return (
    <Modal title="Block time off" onClose={onClose}>
      <div className="space-y-3">
        <div className="text-sm">
          For <span className="font-semibold">{resource?.name || "—"}</span>
          {resource?.title && <span className="text-brand-gray"> · {resource.title}</span>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start"><input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} autoFocus /></Field>
          <Field label="End"><input type="date" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <Field label="Reason">
          <input className={inputCls} list="timeoff-reasons" value={reason} onChange={(e) => setReason(e.target.value)} />
          <datalist id="timeoff-reasons">{TIMEOFF_REASONS.map((x) => <option key={x} value={x} />)}</datalist>
        </Field>
        <p className="text-[11px] text-brand-gray">Blocked time reduces this engineer's available capacity in the Workload view and shades those weeks on the grid.</p>
        {err && <div className="text-sm text-brand-red">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Block time"}</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- workload summary view ----------------
const N_COLS = 8;
function WorkloadView({ board, load }: { board: TimelineBoard; load: Record<string, number[]> }) {
  const weeks = board.weeks;
  const HORIZON = 7;                       // current week + 6 ahead
  const vweeks = weeks.slice(0, HORIZON);
  const BARW = 22;                         // px per weekly-load bar (spaced out)
  const todayCol = colOf(todayISO(), weeks);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const assignsByRes = new Map<number, TimelineAssignment[]>();
  for (const a of board.assignments)
    if (a.resource_id != null) (assignsByRes.get(a.resource_id) || assignsByRes.set(a.resource_id, []).get(a.resource_id)!).push(a);
  const timeoffByRes = new Map<number, TimelineTimeOff[]>();
  for (const t of board.timeoff || [])
    (timeoffByRes.get(t.resource_id) || timeoffByRes.set(t.resource_id, []).get(t.resource_id)!).push(t);
  const projName = (id: number) => board.projects.find((p) => p.id === id)?.name || "—";
  const fmtRange = (s: string, e: string) => `${format(parseISO(s), "d MMM")} – ${format(parseISO(e), "d MMM")}`;

  const groups: { discipline: string; rows: TimelineResource[] }[] = [];
  for (const r of board.resources) {
    let g = groups.find((x) => x.discipline === r.discipline);
    if (!g) groups.push((g = { discipline: r.discipline, rows: [] }));
    g.rows.push(r);
  }

  const metrics = (r: TimelineResource) => {
    const arr = load[String(r.id)] || [];
    const avail = board.availability?.[String(r.id)] || [];
    let sum = 0, peak = 0, over = 0, ooo = 0;
    for (let i = 0; i < vweeks.length; i++) {
      const v = arr[i] || 0;
      const a = avail[i] ?? 1;
      sum += v;
      if (v > peak) peak = v;
      if (v > a + 0.0001) over++;
      if (a < 0.999) ooo++;
    }
    const now = todayCol >= 0 ? arr[todayCol] || 0 : 0;
    return {
      arr, avail, now,
      avg: vweeks.length ? sum / vweeks.length : 0,
      peak, over, ooo,
      projects: new Set((assignsByRes.get(r.id) || []).map((a) => a.timeline_project_id)).size,
    };
  };

  // team rollup
  let teamOver = 0, teamOoo = 0, teamNow = 0, nPeople = board.resources.length;
  for (const r of board.resources) { const m = metrics(r); teamOver += m.over; teamOoo += m.ooo; teamNow += m.now; }
  const teamNowAvg = nPeople ? teamNow / nPeople : 0;

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  // green = room · amber = near capacity · red = over · black = OOO/PTO/not-started
  const loadColor = (v: number, blocked: boolean, over: boolean) =>
    over ? "#e12a3f" : blocked ? "#1a1a1a" : v >= 0.85 ? "#f59e0b" : v > 0 ? "#278747" : "#eef0f2";

  return (
    <div className="card p-0 overflow-x-auto">
      <div className="px-4 py-3 border-b border-brand-lightgray/60 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="font-semibold">Team workload</span>
        <span className="text-brand-gray">{nPeople} people</span>
        <span className="text-brand-gray">avg load now {pct(teamNowAvg)}</span>
        <span className="text-brand-gray">{teamOver} over-allocated engineer-weeks</span>
        <span className="text-brand-gray">{teamOoo} time-off engineer-weeks</span>
        <span className="ml-auto text-[11px] text-brand-gray">click an engineer to see their projects · green ≤ capacity · amber near full · red over · black = OOO/PTO</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-brand-gray border-b border-brand-lightgray/60 align-bottom">
            <th className="text-left px-4 py-2 font-semibold">Engineer</th>
            <th className="text-right px-2 py-2 font-semibold">Projects</th>
            <th className="text-right px-2 py-2 font-semibold">Now</th>
            <th className="text-right px-2 py-2 font-semibold">Avg</th>
            <th className="text-right px-2 py-2 font-semibold">Peak</th>
            <th className="text-right px-2 py-2 font-semibold">Over</th>
            <th className="text-right px-2 py-2 font-semibold">Time off</th>
            <th className="text-left px-4 py-2 font-semibold">
              Weekly load <span className="font-normal normal-case">(next 6 wks)</span>
              <div className="flex gap-1 mt-1 normal-case tracking-normal">
                {vweeks.map((w) => (
                  <span key={w} className="text-center text-[9px] font-normal text-brand-gray" style={{ width: BARW }}>
                    {format(parseISO(w), "M/d")}
                  </span>
                ))}
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.discipline}>
              <tr className="bg-slate-400/80">
                <td colSpan={N_COLS} className="px-4 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-900">
                  <DiscTag d={g.discipline} /> {g.discipline} · {g.rows.length}
                </td>
              </tr>
              {g.rows.map((r) => {
                const m = metrics(r);
                const isOpen = expanded.has(r.id);
                const rowAssigns = [...(assignsByRes.get(r.id) || [])].sort((a, b) => a.start_date.localeCompare(b.start_date));
                const rowTimeoff = [...(timeoffByRes.get(r.id) || [])].sort((a, b) => a.start_date.localeCompare(b.start_date));
                return (
                  <Fragment key={r.id}>
                    <tr
                      className="border-b border-brand-lightgray/40 hover:bg-slate-50/60 cursor-pointer"
                      onClick={() => toggle(r.id)}
                    >
                      <td className="px-4 py-2">
                        <span className="text-brand-gray mr-1 inline-block w-3">{isOpen ? "▾" : "▸"}</span>
                        <span className="font-medium">{r.name}</span>
                        {r.title && <span className="text-brand-gray text-xs"> · {r.title}</span>}
                        {r.is_placeholder && <span className="ml-1 text-[10px] px-1 rounded bg-slate-100 text-brand-gray">placeholder</span>}
                      </td>
                      <td className="text-right px-2 py-2 text-brand-gray">{m.projects || "—"}</td>
                      <td className={clsx("text-right px-2 py-2 font-medium", m.now > 1.0001 ? "text-brand-red" : m.now > 0 ? "" : "text-brand-gray")}>{pct(m.now)}</td>
                      <td className="text-right px-2 py-2">{pct(m.avg)}</td>
                      <td className={clsx("text-right px-2 py-2 font-medium", m.peak > 1.0001 ? "text-brand-red" : "")}>{pct(m.peak)}</td>
                      <td className="text-right px-2 py-2">{m.over ? <span className="text-brand-red font-semibold">{m.over}</span> : <span className="text-brand-gray">0</span>}</td>
                      <td className="text-right px-2 py-2 text-brand-gray">{m.ooo || "—"}</td>
                      <td className="px-4 py-1.5">
                        <div className="flex items-end gap-1 h-9">
                          {vweeks.map((w, i) => {
                            const v = m.arr[i] || 0;
                            const a = m.avail[i] ?? 1;
                            const blocked = a < 0.999;
                            const over = v > a + 0.0001;
                            const h = blocked && v === 0 ? 34 : Math.max(3, Math.min(34, v * 26));
                            return (
                              <div
                                key={w}
                                title={`${format(parseISO(w), "d MMM")}: ${pct(v)} load${blocked ? ` · ${pct(1 - a)} off` : ""}`}
                                style={{ width: BARW, height: h, background: loadColor(v, blocked, over), borderRadius: 2 }}
                              />
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50/40 border-b border-brand-lightgray/40">
                        <td colSpan={N_COLS} className="px-4 py-2">
                          <div className="pl-5 space-y-1.5">
                            {rowAssigns.length === 0 && rowTimeoff.length === 0 && (
                              <div className="text-xs text-brand-gray">No projects or time off in this window.</div>
                            )}
                            {rowAssigns.map((a) => {
                              const st = STATUS_MAP[a.effective_status || "in_progress"] || STATUS_MAP["in_progress"];
                              return (
                                <div key={a.id} className="flex items-center gap-2 text-xs">
                                  <DiscTag d={a.discipline} />
                                  <span className="font-medium text-slate-700 truncate" style={{ minWidth: 180 }}>
                                    {a.label || projName(a.timeline_project_id)}
                                    {!a.label && a.milestone ? ` · ${a.milestone}` : ""}
                                  </span>
                                  <span className="text-brand-gray tabular-nums">{fmtRange(a.start_date, a.end_date)}</span>
                                  <span className="text-brand-gray">· {pct(a.utilization ?? 1)}</span>
                                  <span className="inline-flex items-center gap-1 ml-auto">
                                    <span className="inline-block h-2.5 w-2.5 rounded" style={{ background: st.bg }} />
                                    <span className="text-brand-gray">{st.label}</span>
                                  </span>
                                </div>
                              );
                            })}
                            {rowTimeoff.map((t) => (
                              <div key={`to-${t.id}`} className="flex items-center gap-2 text-xs text-slate-500">
                                <span className="inline-block text-[9px] font-bold rounded px-1 mr-1 align-middle bg-slate-300 text-white">🛇</span>
                                <span className="font-medium" style={{ minWidth: 180 }}>{t.reason || "OOO"}</span>
                                <span className="tabular-nums">{fmtRange(t.start_date, t.end_date)}</span>
                                <span className="ml-auto italic">time off</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
