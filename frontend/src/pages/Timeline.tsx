import { useEffect, useMemo, useState, type ReactNode } from "react";
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
import { format, parseISO, startOfWeek } from "date-fns";
import clsx from "clsx";

// ---- constants ----
const WEEK_W = 86; // px per week column
const LABEL_W = 230; // px sticky label column
const ROW_H = 30; // px per bar row

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

const mondayISO = (iso: string) =>
  format(startOfWeek(parseISO(iso), { weekStartsOn: 1 }), "yyyy-MM-dd");

/** Column index (0-based) of a date within the weeks array. */
function colOf(iso: string, weeks: string[]): number {
  if (!weeks.length) return 0;
  const base = parseISO(weeks[0]).getTime();
  const d = parseISO(mondayISO(iso)).getTime();
  return Math.round((d - base) / (7 * 86400000));
}

type View = "engineer" | "project";

export default function Timeline() {
  const confirm = useConfirm();
  const [board, setBoard] = useState<TimelineBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("engineer");
  const [showNewProject, setShowNewProject] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [editing, setEditing] = useState<TimelineAssignment | null>(null);
  const [addingToProject, setAddingToProject] = useState<number | null>(null);

  async function reload() {
    setLoading(true);
    try {
      setBoard(await fetchTimelineBoard());
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  const weeks = board?.weeks ?? [];
  const gridWidth = LABEL_W + weeks.length * WEEK_W;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Timeline Estimator"
        subtitle="Resource-loaded capacity planner. Each weekly cell = 5 working days × 100%; cells over 100% are over-allocated."
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-ghost text-sm" onClick={() => setShowResources(true)}>
              👥 Manage resources
            </button>
            <button className="btn-primary text-sm" onClick={() => setShowNewProject(true)}>
              + New project
            </button>
          </div>
        }
      />

      {/* view toggle + legend */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 p-0.5 text-xs font-semibold">
          {(["engineer", "project"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={clsx(
                "px-3 py-1 rounded-full transition",
                view === v ? "bg-white text-brand-red shadow-sm" : "text-slate-500 hover:text-slate-900",
              )}
            >
              {v === "engineer" ? "By engineer" : "By project"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {STATUSES.map((s) => (
            <span key={s.value} className="inline-flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded" style={{ background: s.bg }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      {loading && <div className="text-sm text-brand-gray">Loading timeline…</div>}
      {error && <div className="text-sm text-brand-red">{error}</div>}

      {board && !loading && (
        board.assignments.length === 0 && board.resources.length === 0 ? (
          <EmptyState
            title="No timeline data yet"
            hint="Add resources (engineers / placeholders), then create a project and assign work."
          />
        ) : (
          <div className="card p-0 overflow-x-auto">
            <div style={{ width: gridWidth, minWidth: gridWidth }}>
              {/* header */}
              <div className="flex sticky top-0 z-10 bg-white border-b border-brand-lightgray">
                <div
                  className="shrink-0 px-3 py-2 text-[11px] uppercase tracking-wider text-brand-gray sticky left-0 bg-white z-10 border-r border-brand-lightgray"
                  style={{ width: LABEL_W }}
                >
                  {view === "engineer" ? "Engineer" : "Project"}
                </div>
                {weeks.map((w) => (
                  <div
                    key={w}
                    className="shrink-0 px-1 py-2 text-[11px] text-center text-brand-gray border-r border-brand-lightgray/50"
                    style={{ width: WEEK_W }}
                  >
                    {format(parseISO(w), "d-MMM")}
                  </div>
                ))}
              </div>

              {view === "engineer" ? (
                <EngineerView board={board} onEditBar={setEditing} />
              ) : (
                <ProjectView board={board} onEditBar={setEditing} onAddTo={setAddingToProject} />
              )}
            </div>
          </div>
        )
      )}

      {showNewProject && (
        <NewProjectDialog
          board={board}
          onClose={() => setShowNewProject(false)}
          onSaved={() => {
            setShowNewProject(false);
            void reload();
          }}
        />
      )}
      {showResources && (
        <ResourceManagerDialog
          onClose={() => setShowResources(false)}
          onChanged={() => void reload()}
        />
      )}
      {(editing || addingToProject !== null) && board && (
        <AssignmentDialog
          board={board}
          assignment={editing}
          projectId={addingToProject ?? editing?.timeline_project_id ?? null}
          onClose={() => {
            setEditing(null);
            setAddingToProject(null);
          }}
          onSaved={() => {
            setEditing(null);
            setAddingToProject(null);
            void reload();
          }}
          onDelete={async () => {
            if (!editing) return;
            const ok = await confirm({
              title: "Delete this assignment?",
              body: editing.project_name || undefined,
              confirmLabel: "Delete",
              destructive: true,
            });
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

// ---- a single bar ----
function Bar({
  a,
  weeks,
  onClick,
}: {
  a: TimelineAssignment;
  weeks: string[];
  onClick: () => void;
}) {
  const start = Math.max(0, colOf(a.start_date, weeks));
  const end = Math.min(weeks.length - 1, colOf(a.end_date, weeks));
  if (end < 0 || start > weeks.length - 1 || end < start) return null;
  const st = STATUS_MAP[a.effective_status || "in_progress"] || STATUS_MAP["in_progress"];
  const left = start * WEEK_W + 2;
  const width = (end - start + 1) * WEEK_W - 4;
  const util = a.utilization != null ? `${Math.round(a.utilization * 100)}%` : "";
  return (
    <button
      onClick={onClick}
      title={`${a.project_name || a.label || ""} · ${a.discipline}${a.milestone ? " · " + a.milestone : ""} · ${util}`}
      className="absolute rounded text-[11px] font-medium truncate px-1.5 hover:ring-2 hover:ring-black/20"
      style={{
        left,
        width,
        top: 4,
        height: ROW_H - 8,
        background: st.bg,
        color: st.fg,
        lineHeight: `${ROW_H - 8}px`,
      }}
    >
      {a.label || a.project_name || "—"}
      {a.milestone ? ` ${a.milestone}` : ""} · {util}
    </button>
  );
}

// ---- track wrapper (relative, with week gridlines) ----
function Track({ weeks, children }: { weeks: string[]; children?: ReactNode }) {
  return (
    <div className="relative shrink-0" style={{ width: weeks.length * WEEK_W, height: ROW_H }}>
      <div className="absolute inset-0 flex">
        {weeks.map((w) => (
          <div key={w} className="border-r border-brand-lightgray/30" style={{ width: WEEK_W }} />
        ))}
      </div>
      {children}
    </div>
  );
}

function LabelCell({ children, indent }: { children: ReactNode; indent?: number }) {
  return (
    <div
      className="shrink-0 px-3 sticky left-0 bg-white z-[1] border-r border-brand-lightgray/60 flex items-center text-sm"
      style={{ width: LABEL_W, height: ROW_H, paddingLeft: 12 + (indent || 0) * 14 }}
    >
      <span className="truncate">{children}</span>
    </div>
  );
}

// ---- engineer view ----
function EngineerView({
  board,
  onEditBar,
}: {
  board: TimelineBoard;
  onEditBar: (a: TimelineAssignment) => void;
}) {
  const { weeks, resources, assignments, load } = board;
  const byResource = useMemo(() => {
    const m = new Map<number, TimelineAssignment[]>();
    for (const a of assignments) {
      if (a.resource_id == null) continue;
      const arr = m.get(a.resource_id) || [];
      arr.push(a);
      m.set(a.resource_id, arr);
    }
    return m;
  }, [assignments]);

  // group resources by discipline (preserve backend order)
  const groups: { discipline: string; rows: TimelineResource[] }[] = [];
  for (const r of resources) {
    let g = groups.find((x) => x.discipline === r.discipline);
    if (!g) {
      g = { discipline: r.discipline, rows: [] };
      groups.push(g);
    }
    g.rows.push(r);
  }
  const unassigned = assignments.filter((a) => a.resource_id == null);

  return (
    <div>
      {groups.map((g) => (
        <div key={g.discipline}>
          <div className="flex bg-slate-50/80 border-b border-brand-lightgray/60">
            <div
              className="shrink-0 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-gray sticky left-0 bg-slate-50/80 z-[1]"
              style={{ width: LABEL_W }}
            >
              {g.discipline}
            </div>
            <div className="shrink-0" style={{ width: weeks.length * WEEK_W }} />
          </div>
          {g.rows.map((r) => {
            const rowAssignments = byResource.get(r.id) || [];
            const cells = load[String(r.id)] || [];
            return (
              <div key={r.id} className="border-b border-brand-lightgray/40">
                {/* resource header + utilization strip */}
                <div className="flex items-stretch">
                  <LabelCell>
                    <span className="font-medium">{r.name}</span>
                    {r.title && <span className="text-brand-gray text-xs"> · {r.title}</span>}
                    {r.is_placeholder && (
                      <span className="ml-1 text-[10px] px-1 rounded bg-slate-100 text-brand-gray">
                        placeholder
                      </span>
                    )}
                  </LabelCell>
                  <div className="relative shrink-0 flex" style={{ width: weeks.length * WEEK_W, height: ROW_H }}>
                    {weeks.map((w, i) => {
                      const v = cells[i] || 0;
                      const over = v > 1.0001;
                      return (
                        <div
                          key={w}
                          className="border-r border-brand-lightgray/30 flex items-center justify-center text-[10px]"
                          style={{
                            width: WEEK_W,
                            background: over
                              ? "#fce8ea"
                              : v > 0
                                ? "#eaf6ee"
                                : "transparent",
                            color: over ? "#a31420" : "#4d4d4f",
                            fontWeight: over ? 700 : 400,
                          }}
                          title={`${Math.round(v * 100)}% utilized`}
                        >
                          {v > 0 ? `${Math.round(v * 100)}%` : ""}
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* one row per assignment */}
                {rowAssignments.map((a) => (
                  <div key={a.id} className="flex items-stretch">
                    <LabelCell indent={1}>
                      <span className="text-xs text-brand-gray">
                        <DiscTag d={a.discipline} /> {a.project_name}
                      </span>
                    </LabelCell>
                    <Track weeks={weeks}>
                      <Bar a={a} weeks={weeks} onClick={() => onEditBar(a)} />
                    </Track>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}

      {unassigned.length > 0 && (
        <div>
          <div className="flex bg-slate-50/80 border-b border-brand-lightgray/60">
            <div
              className="shrink-0 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-gray sticky left-0 bg-slate-50/80 z-[1]"
              style={{ width: LABEL_W }}
            >
              Unassigned
            </div>
            <div className="shrink-0" style={{ width: weeks.length * WEEK_W }} />
          </div>
          {unassigned.map((a) => (
            <div key={a.id} className="flex items-stretch border-b border-brand-lightgray/40">
              <LabelCell indent={1}>
                <span className="text-xs text-brand-gray">
                  <DiscTag d={a.discipline} /> {a.project_name}
                </span>
              </LabelCell>
              <Track weeks={weeks}>
                <Bar a={a} weeks={weeks} onClick={() => onEditBar(a)} />
              </Track>
            </div>
          ))}
        </div>
      )}
      <div className="px-3 py-2">
        <span className="text-xs text-brand-gray">
          Tip: click any bar to edit. Use “Manage resources” to add engineers or new-hire placeholders.
        </span>
      </div>
    </div>
  );
}

// ---- project view ----
function ProjectView({
  board,
  onEditBar,
  onAddTo,
}: {
  board: TimelineBoard;
  onEditBar: (a: TimelineAssignment) => void;
  onAddTo: (projectId: number) => void;
}) {
  const { weeks, projects, assignments, resources } = board;
  const resName = (id?: number | null) =>
    id == null ? "Unassigned" : resources.find((r) => r.id === id)?.name || "Unassigned";
  const byProject = new Map<number, TimelineAssignment[]>();
  for (const a of assignments) {
    const arr = byProject.get(a.timeline_project_id) || [];
    arr.push(a);
    byProject.set(a.timeline_project_id, arr);
  }
  return (
    <div>
      {projects.map((p) => {
        const rows = byProject.get(p.id) || [];
        const st = STATUS_MAP[p.status] || STATUS_MAP["in_progress"];
        return (
          <div key={p.id} className="border-b border-brand-lightgray/40">
            <div className="flex items-stretch bg-slate-50/60">
              <LabelCell>
                <span className="font-medium">{p.name}</span>
                {p.client && <span className="text-brand-gray text-xs"> · {p.client}</span>}
              </LabelCell>
              <div className="relative shrink-0 flex items-center gap-2 px-2" style={{ width: weeks.length * WEEK_W, height: ROW_H }}>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: st.bg, color: st.fg }}
                >
                  {st.label}
                </span>
                <button
                  className="text-[11px] text-brand-red hover:underline"
                  onClick={() => onAddTo(p.id)}
                >
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
                <Track weeks={weeks}>
                  <Bar a={a} weeks={weeks} onClick={() => onEditBar(a)} />
                </Track>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function DiscTag({ d }: { d: string }) {
  const t = DISC_TAG[d] || DISC_TAG["Other"];
  return (
    <span
      className="inline-block text-[9px] font-bold rounded px-1 mr-1 align-middle"
      style={{ background: t.color, color: "#fff" }}
      title={d}
    >
      {t.short}
    </span>
  );
}

// ---- modal shell ----
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="card w-full max-w-lg mt-16 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="section-title">{title}</h3>
          <button className="text-brand-gray hover:text-brand-red text-xl leading-none" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-red/30";
const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block">
    <span className="block text-[11px] uppercase tracking-wider text-brand-gray mb-1">{label}</span>
    {children}
  </label>
);

// ---- new project (project + first assignment) ----
function NewProjectDialog({
  board,
  onClose,
  onSaved,
}: {
  board: TimelineBoard | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [status, setStatus] = useState("in_progress");
  const [resourceId, setResourceId] = useState<string>("");
  const [discipline, setDiscipline] = useState("Electrical");
  const [milestone, setMilestone] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [util, setUtil] = useState(1.0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setErr("Project name is required.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const p = await createTimelineProject({ name, client: client || null, status });
      if (start && end) {
        await createTimelineAssignment({
          timeline_project_id: p.id,
          resource_id: resourceId ? Number(resourceId) : null,
          discipline,
          milestone: milestone || null,
          start_date: start,
          end_date: end,
          utilization: util,
        });
      }
      onSaved();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Save failed");
      setSaving(false);
    }
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Project name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client">
            <input className={inputCls} value={client} onChange={(e) => setClient(e.target.value)} />
          </Field>
          <Field label="Status">
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="border-t border-brand-lightgray/60 pt-3 text-[11px] uppercase tracking-wider text-brand-gray">
          First assignment (optional)
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assigned to">
            <select className={inputCls} value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              <option value="">Unassigned</option>
              {(board?.resources ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Discipline">
            <select className={inputCls} value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              {DISCIPLINES.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="Start">
            <input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End">
            <input type="date" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Milestone">
            <select className={inputCls} value={milestone} onChange={(e) => setMilestone(e.target.value)}>
              {MILESTONES.map((m) => (
                <option key={m} value={m}>
                  {m || "—"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="% Utilization">
            <select className={inputCls} value={util} onChange={(e) => setUtil(Number(e.target.value))}>
              {UTILS.map((u) => (
                <option key={u} value={u}>
                  {Math.round(u * 100)}%
                </option>
              ))}
            </select>
          </Field>
        </div>
        {err && <div className="text-sm text-brand-red">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- add / edit assignment ----
function AssignmentDialog({
  board,
  assignment,
  projectId,
  onClose,
  onSaved,
  onDelete,
}: {
  board: TimelineBoard;
  assignment: TimelineAssignment | null;
  projectId: number | null;
  onClose: () => void;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [pid, setPid] = useState<string>(String(projectId ?? assignment?.timeline_project_id ?? ""));
  const [resourceId, setResourceId] = useState<string>(
    assignment?.resource_id != null ? String(assignment.resource_id) : "",
  );
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
    if (!pid || !start || !end) {
      setErr("Project, start, and end are required.");
      return;
    }
    setSaving(true);
    setErr(null);
    const body = {
      resource_id: resourceId ? Number(resourceId) : null,
      discipline,
      milestone: milestone || null,
      start_date: start,
      end_date: end,
      utilization: util,
      status: statusOverride || null,
    };
    try {
      if (isEdit && assignment) {
        await patchTimelineAssignment(assignment.id, body);
      } else {
        await createTimelineAssignment({ ...body, timeline_project_id: Number(pid) });
      }
      onSaved();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || e?.message || "Save failed");
      setSaving(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit assignment" : "Add assignment"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Project">
          <select className={inputCls} value={pid} onChange={(e) => setPid(e.target.value)} disabled={isEdit}>
            <option value="">— pick —</option>
            {board.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assigned to">
            <select className={inputCls} value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
              <option value="">Unassigned</option>
              {board.resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Discipline">
            <select className={inputCls} value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              {DISCIPLINES.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="Start">
            <input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End">
            <input type="date" className={inputCls} value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Milestone">
            <select className={inputCls} value={milestone} onChange={(e) => setMilestone(e.target.value)}>
              {MILESTONES.map((m) => (
                <option key={m} value={m}>
                  {m || "—"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="% Utilization">
            <select className={inputCls} value={util} onChange={(e) => setUtil(Number(e.target.value))}>
              {UTILS.map((u) => (
                <option key={u} value={u}>
                  {Math.round(u * 100)}%
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Status override (optional — defaults to project status)">
          <select className={inputCls} value={statusOverride} onChange={(e) => setStatusOverride(e.target.value)}>
            <option value="">Use project status</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        {err && <div className="text-sm text-brand-red">{err}</div>}
        <div className="flex justify-between gap-2 pt-1">
          <div>
            {isEdit && (
              <button className="btn-ghost text-brand-red" onClick={onDelete}>
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---- resource manager ----
function ResourceManagerDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const confirm = useConfirm();
  const [resources, setResources] = useState<TimelineResource[]>([]);
  const [roster, setRoster] = useState<GlobalAttendee[]>([]);
  const [name, setName] = useState("");
  const [discipline, setDiscipline] = useState("Electrical");
  const [title, setTitle] = useState("");
  const [placeholder, setPlaceholder] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    setResources(await listTimelineResources(true));
  }
  useEffect(() => {
    void load();
    listGlobalRoster().then(setRoster).catch(() => setRoster([]));
  }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const match = roster.find((g) => g.full_name.toLowerCase() === name.trim().toLowerCase());
      await createTimelineResource({
        name: name.trim(),
        discipline,
        title: title || null,
        is_placeholder: placeholder,
        order_index: resources.length,
      });
      void match; // (user link could be wired later)
      setName("");
      setTitle("");
      setPlaceholder(false);
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(r: TimelineResource) {
    await patchTimelineResource(r.id, { active: !r.active });
    await load();
    onChanged();
  }
  async function setDisc(r: TimelineResource, d: string) {
    await patchTimelineResource(r.id, { discipline: d });
    await load();
    onChanged();
  }
  async function remove(r: TimelineResource) {
    const ok = await confirm({
      title: `Remove ${r.name}?`,
      body: "Their assignments become Unassigned (not deleted).",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    await deleteTimelineResource(r.id);
    await load();
    onChanged();
  }

  return (
    <Modal title="Manage resources" onClose={onClose}>
      <div className="space-y-3">
        <div className="rounded-lg border border-brand-lightgray/60 p-3 space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-brand-gray">Add engineer or placeholder</div>
          <input
            className={inputCls}
            list="timeline-roster"
            placeholder="Type a name (roster suggestions) or a placeholder like 'New Hire'"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <datalist id="timeline-roster">
            {roster.map((g) => (
              <option key={g.id} value={g.full_name} />
            ))}
          </datalist>
          <div className="grid grid-cols-2 gap-2">
            <select className={inputCls} value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
              {DISCIPLINES.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
            <input className={inputCls} placeholder="Title (e.g. EE II)" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-xs text-brand-gray">
            <input type="checkbox" checked={placeholder} onChange={(e) => setPlaceholder(e.target.checked)} />
            Placeholder (new hire / vendor — not a real person yet)
          </label>
          <button className="btn-primary text-sm" onClick={add} disabled={busy || !name.trim()}>
            {busy ? "Adding…" : "Add resource"}
          </button>
        </div>

        <div className="max-h-72 overflow-y-auto divide-y divide-brand-lightgray/40">
          {resources.map((r) => (
            <div key={r.id} className="flex items-center gap-2 py-2 text-sm">
              <span className={clsx("flex-1 truncate", !r.active && "text-brand-gray line-through")}>
                {r.name}
                {r.title && <span className="text-brand-gray text-xs"> · {r.title}</span>}
                {r.is_placeholder && (
                  <span className="ml-1 text-[10px] px-1 rounded bg-slate-100 text-brand-gray">placeholder</span>
                )}
              </span>
              <select
                className="rounded border border-slate-200 text-xs px-1 py-0.5"
                value={r.discipline}
                onChange={(e) => void setDisc(r, e.target.value)}
              >
                {DISCIPLINES.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
              <button className="text-xs text-brand-gray hover:text-brand-red" onClick={() => void toggleActive(r)}>
                {r.active ? "Hide" : "Show"}
              </button>
              <button className="text-xs text-brand-red hover:underline" onClick={() => void remove(r)}>
                Remove
              </button>
            </div>
          ))}
          {resources.length === 0 && <div className="py-3 text-sm text-brand-gray">No resources yet.</div>}
        </div>
      </div>
    </Modal>
  );
}
