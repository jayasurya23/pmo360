import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  updateProject,
  listProjectDeliverables,
  suggestActionFromNote,
  createAction,
  getLatestMeeting,
  type SuggestedAction,
} from "@/lib/api";
import type { Note, Deliverable, MeetingDetail } from "@/lib/types";
import {
  mergeSubProjects,
  NEW_AREA_SENTINEL,
  NEW_AREA_LABEL,
} from "@/lib/subprojects";

const PRIORITY_OPTS = ["Low", "Medium", "High"];
const STATUS_OPTS = ["open", "closed"];

// Priority reads as a tinted pill in the redesign, but it stays a <select> so
// PMs can still change it inline — these are the pill tints per level.
const PRIORITY_TINT: Record<string, string> = {
  High: "bg-status-open-bg text-status-open-text",
  Medium: "bg-status-pending-bg text-status-pending-text",
  Low: "bg-surface-border text-brand-gray",
};

// The note card's meta row is denser than the app-wide .input/.select — the
// utilities after `input`/`select` override the component-layer padding/size.
// Width is left to each call site (the component class sets w-full).
const META_CONTROL = "rounded-[7px] px-2.5 py-1 text-xs";

// Special area-filter values. "" maps to "All", "__common__" matches notes
// whose project_area is blank/null (no area set), and "__unspecified__" is
// the same — kept separate so we can render a distinct label.
const FILTER_ALL = "__all__";
const FILTER_UNSPECIFIED = "__unspecified__";

export default function NotesPage() {
  const { currentProject, refreshProjects, selectedSubProject } = useApp();
  const [notes, setNotes] = useState<Note[]>([]);
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "closed">(
    "open"
  );
  const [areaFilter, setAreaFilter] = useState<string>(FILTER_ALL);

  // Honour the header's Project picker: when a Project is selected up top,
  // scope the Notes list to it; clearing it (All projects) drops back to all.
  // The local filter dropdown can still override afterwards.
  useEffect(() => {
    setAreaFilter(selectedSubProject ? selectedSubProject : FILTER_ALL);
  }, [selectedSubProject]);
  const [loading, setLoading] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const confirm = useConfirm();

  // Latest meeting on this portfolio — needed because ActionItem.originating_meeting_id
  // is NOT NULL. We only enable the ✨ Suggest action button when there's a
  // meeting to attribute the new action to.
  const [latestMeeting, setLatestMeeting] = useState<MeetingDetail | null>(null);

  // Suggestion modal state — driven at the page level so we can compose
  // the createAction call here (with the latestMeeting we already fetched).
  const [suggesting, setSuggesting] = useState<Note | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestedAction | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [suggestionBusy, setSuggestionBusy] = useState(false);

  const load = async () => {
    if (!currentProject) return;
    setLoading(true);
    const [notesData, delivData, latestMtg] = await Promise.all([
      listNotes(currentProject.id),
      listProjectDeliverables(currentProject.id).catch(() => [] as Deliverable[]),
      getLatestMeeting(currentProject.id).catch(() => null),
    ]);
    setNotes(notesData);
    setDeliverables(delivData);
    setLatestMeeting(latestMtg);
    setLoading(false);
  };

  // Open the suggestion modal for a note. Calls /suggest-action, stashes
  // the response, lets the user accept/edit/dismiss.
  const handleSuggest = async (note: Note) => {
    setSuggesting(note);
    setSuggestion(null);
    setSuggestionError(null);
    setSuggestionBusy(true);
    try {
      const s = await suggestActionFromNote(note.id);
      setSuggestion(s);
    } catch (e: any) {
      setSuggestionError(e?.message || "Couldn't get a suggestion");
    } finally {
      setSuggestionBusy(false);
    }
  };

  // Create the action from the accepted (possibly edited) suggestion.
  const handleAcceptSuggestion = async (edited: SuggestedAction) => {
    if (!currentProject || !latestMeeting) return;
    setSuggestionBusy(true);
    try {
      await createAction({
        project_id: currentProject.id,
        originating_meeting_id: latestMeeting.id,
        text: edited.text,
        owner: edited.owner || "",
        due_date: edited.due_date || null,
        status: "open",
      });
      // Optionally: link back to the note via the source field, or mark the
      // note as closed. Conservative: leave the note as-is so PMs can review
      // both side-by-side. Just close the modal.
      setSuggesting(null);
      setSuggestion(null);
    } catch (e: any) {
      setSuggestionError(e?.message || "Couldn't create the action");
    } finally {
      setSuggestionBusy(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  // ---- Merged sub-project list ----
  // Source priority:
  //   1. Curated `Project.sub_projects_json`
  //   2. Discovered `Deliverable.project_segment`
  //   3. Existing `Note.project_area` (so a free-typed value sticks around)
  const subProjects = useMemo(() => {
    return mergeSubProjects(
      currentProject?.sub_projects_json || [],
      deliverables.map((d) => d.project_segment || ""),
      notes.map((n) => n.project_area || "")
    );
  }, [currentProject?.sub_projects_json, deliverables, notes]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  const filtered = notes.filter((n) => {
    if (statusFilter !== "all" && (n.status || "open") !== statusFilter)
      return false;
    if (areaFilter === FILTER_ALL) return true;
    const area = (n.project_area || "").trim();
    if (areaFilter === FILTER_UNSPECIFIED) return !area;
    return area.toLowerCase() === areaFilter.toLowerCase();
  });

  // Counts sit on the status pills — computed off the unfiltered list so the
  // numbers don't move as you switch between them.
  const counts = {
    open: notes.filter((n) => (n.status || "open") === "open").length,
    closed: notes.filter((n) => n.status === "closed").length,
    all: notes.length,
  };

  const handleAdd = async () => {
    const n = await createNote({
      project_id: currentProject.id,
      note_date: new Date().toISOString().slice(0, 10),
      topic: "New note",
      priority: "Medium",
      status: "open",
    });
    setNotes([n, ...notes]);
  };

  const handlePatch = async (id: number, patch: Partial<Note>) => {
    setNotes(notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    await updateNote(id, patch);
  };

  const handleDelete = async (note: Note) => {
    const ok = await confirm({
      title: "Delete this note?",
      body: note.topic || note.action_needed || undefined,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await deleteNote(note.id);
    setNotes(notes.filter((n) => n.id !== note.id));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Lightweight notes between meetings · separate from rolling actions"
        title="Planner notes"
        actions={
          <>
            <div className="flex items-center gap-1.5">
              <FilterPill
                label="Open"
                count={counts.open}
                active={statusFilter === "open"}
                onClick={() => setStatusFilter("open")}
              />
              <FilterPill
                label="Closed"
                count={counts.closed}
                active={statusFilter === "closed"}
                onClick={() => setStatusFilter("closed")}
              />
              <FilterPill
                label="All"
                count={counts.all}
                active={statusFilter === "all"}
                onClick={() => setStatusFilter("all")}
              />
            </div>
            <select
              className="select w-44"
              value={areaFilter}
              onChange={(e) => setAreaFilter(e.target.value)}
              title="Project filter"
            >
              <option value={FILTER_ALL}>All projects</option>
              {subProjects.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value={FILTER_UNSPECIFIED}>Unspecified</option>
            </select>
            <button
              className="btn-ghost"
              onClick={() => setShowManage((v) => !v)}
              aria-expanded={showManage}
            >
              Manage projects ▾
            </button>
            <button className="btn-primary" onClick={handleAdd}>
              + Add note
            </button>
          </>
        }
      />

      {showManage && (
        <ManageSubProjectsPanel
          onClose={() => setShowManage(false)}
          projectId={currentProject.id}
          curated={currentProject.sub_projects_json || []}
          deliverables={deliverables}
          onSaved={async () => {
            await refreshProjects();
          }}
        />
      )}

      {loading ? (
        <div className="card p-5 text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No notes" hint="Use + Add note to capture one." />
      ) : (
        <div className="grid items-start gap-[18px] lg:grid-cols-2">
          {filtered.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              subProjects={subProjects}
              onPatch={(patch) => handlePatch(n.id, patch)}
              onDelete={() => handleDelete(n)}
              onSuggest={() => handleSuggest(n)}
              canSuggest={!!latestMeeting}
            />
          ))}
        </div>
      )}

      <SuggestionModal
        open={suggesting !== null}
        note={suggesting}
        suggestion={suggestion}
        error={suggestionError}
        busy={suggestionBusy}
        canCreate={!!latestMeeting}
        onClose={() => {
          setSuggesting(null);
          setSuggestion(null);
          setSuggestionError(null);
        }}
        onAccept={handleAcceptSuggestion}
      />
    </div>
  );
}


// ============================================================
// Status filter pill — Open / Closed / All with a live count
// ============================================================
function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "rounded-full border px-3 py-1 text-xs font-semibold transition",
        active
          ? "border-brand-black bg-brand-black text-white"
          : "border-surface-border bg-surface-card text-brand-gray hover:border-brand-red hover:text-brand-red",
      )}
    >
      {label} <span className="tabular-nums">{count}</span>
    </button>
  );
}

// ============================================================
// Suggestion modal — review + edit before creating the action
// ============================================================
function SuggestionModal({
  open,
  note,
  suggestion,
  error,
  busy,
  canCreate,
  onClose,
  onAccept,
}: {
  open: boolean;
  note: Note | null;
  suggestion: SuggestedAction | null;
  error: string | null;
  busy: boolean;
  canCreate: boolean;
  onClose: () => void;
  onAccept: (edited: SuggestedAction) => void;
}) {
  // Local editable copies so the PM can tweak the AI's proposal before
  // accepting. Reseed whenever the upstream suggestion changes.
  const [text, setText] = useState("");
  const [owner, setOwner] = useState("");
  const [dueDate, setDueDate] = useState<string>("");
  useEffect(() => {
    setText(suggestion?.text || "");
    setOwner(suggestion?.owner || "");
    setDueDate(suggestion?.due_date || "");
  }, [suggestion?.text, suggestion?.owner, suggestion?.due_date]);

  if (!open) return null;

  const informational = !!suggestion && !suggestion.text.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg card p-5 space-y-3 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="section-title">✦ Suggested action</h3>
          <button
            type="button"
            className="text-xs text-brand-lightgray transition hover:text-brand-brightred"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {note && (
          <div className="text-xs text-brand-gray border-l-2 border-l-brand-lightgray pl-2 italic">
            From note: <b>{note.topic || "(untitled)"}</b>
            {note.action_needed && note.action_needed !== note.topic
              ? ` — ${note.action_needed.slice(0, 120)}${note.action_needed.length > 120 ? "…" : ""}`
              : ""}
          </div>
        )}

        {busy && !suggestion && (
          <div className="text-sm text-brand-gray py-4">Asking the model…</div>
        )}

        {error && (
          <div className="text-sm text-status-open-text bg-status-open-bg border border-status-open-border rounded px-3 py-2">
            {error}
          </div>
        )}

        {suggestion && informational && (
          <div className="text-sm text-status-pending-text bg-status-pending-bg border border-status-pending-border rounded px-3 py-2">
            {suggestion.rationale || "No clear action in this note."}
          </div>
        )}

        {suggestion && !informational && (
          <>
            {suggestion.rationale && (
              <div className="text-xs text-brand-gray italic">
                Why: {suggestion.rationale}
              </div>
            )}
            <div className="space-y-2">
              <label className="block">
                <span className="label">Action</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="label">Owner</span>
                  <input
                    className="input"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="Roashaael Mary John"
                  />
                </label>
                <label className="block">
                  <span className="label">Due date</span>
                  <input
                    className="input"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                  />
                </label>
              </div>
              {!canCreate && (
                <div className="text-xs text-brand-deepgold">
                  This portfolio doesn't have a meeting yet — actions are
                  attributed to a meeting. Capture or save a meeting first,
                  then come back to accept this suggestion.
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            {informational ? "OK" : "Dismiss"}
          </button>
          {!informational && (
            <button
              className="btn-primary"
              onClick={() =>
                onAccept({
                  text: text.trim(),
                  owner: owner.trim(),
                  due_date: dueDate || null,
                  rationale: suggestion?.rationale || "",
                })
              }
              disabled={busy || !text.trim() || !canCreate}
            >
              {busy ? "Creating…" : "Create action"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Manage sub-projects panel
// ============================================================
function ManageSubProjectsPanel({
  onClose,
  projectId,
  curated,
  deliverables,
  onSaved,
}: {
  onClose: () => void;
  projectId: number;
  curated: string[];
  deliverables: Deliverable[];
  onSaved: () => Promise<void> | void;
}) {
  // textarea text mirrors the curated list — one name per line.
  const [text, setText] = useState(() => (curated || []).join("\n"));
  const [saving, setSaving] = useState(false);

  // Keep textarea in sync when the curated list changes externally (e.g. user
  // switches portfolio).
  useEffect(() => {
    setText((curated || []).join("\n"));
  }, [curated.join("|")]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const names = text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await updateProject(projectId, { sub_projects_json: names });
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  const handlePullFromDeliverables = () => {
    const existing = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const discovered = deliverables.map((d) => d.project_segment || "");
    const merged = mergeSubProjects(existing, discovered);
    setText(merged.join("\n"));
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-surface-hairline px-5 py-3.5">
        <h3 className="section-title">Manage projects</h3>
        <button
          type="button"
          className="text-sm text-brand-lightgray transition hover:text-brand-brightred"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="px-5 py-4 space-y-3">
        <p className="text-xs text-brand-gray">
          One project name per line. These populate the project dropdown on
          every note for this portfolio.
        </p>
        <textarea
          className="textarea"
          rows={Math.max(4, text.split("\n").length + 1)}
          placeholder={"Snapdragon\nTwo Blues"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex gap-2">
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save list"}
          </button>
          <button
            className="btn-ghost"
            onClick={handlePullFromDeliverables}
            title="Add any unique project_segment values from this portfolio's deliverables"
            disabled={deliverables.length === 0}
          >
            Pull from deliverables
          </button>
        </div>
        {deliverables.length === 0 && (
          <p className="text-xs text-brand-gray italic">
            No deliverables on this portfolio yet — pull from deliverables is
            disabled.
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Per-note card
// ============================================================
function NoteCard({
  note,
  subProjects,
  onPatch,
  onDelete,
  onSuggest,
  canSuggest,
}: {
  note: Note;
  subProjects: string[];
  onPatch: (p: Partial<Note>) => void;
  onDelete: () => void;
  onSuggest: () => void;
  canSuggest: boolean;
}) {
  const [draft, setDraft] = useState(note);
  // When `+ New area…` is picked, swap the select for a free-text input. We
  // also enter this mode automatically if the existing value isn't in the
  // merged list (legacy / freshly-typed value).
  const [newAreaMode, setNewAreaMode] = useState(false);

  useEffect(() => {
    setDraft(note);
    setNewAreaMode(false);
  }, [note.id]);

  // Detect a free-typed value not in the dropdown so we surface it as a text
  // input rather than silently dropping the selection. Matches the merged
  // list case-insensitively, like the dedupe helper.
  const areaInList = useMemo(() => {
    const v = (draft.project_area || "").trim().toLowerCase();
    if (!v) return true; // empty is "no selection", not a missing value
    return subProjects.some((s) => s.toLowerCase() === v);
  }, [draft.project_area, subProjects]);

  const showTextInput = newAreaMode || !areaInList;
  // Closed notes stay legible but visibly parked — dimmed card, struck topic.
  const closed = (draft.status || "open") === "closed";
  const priority = draft.priority || "Medium";

  return (
    <div className={clsx("card overflow-hidden", closed && "opacity-70")}>
      <div className="flex items-center gap-2.5 border-b border-surface-hairline px-[18px] py-3">
        <input
          className={clsx(
            "min-w-0 flex-1 border-0 bg-transparent p-0 text-[14.5px] font-semibold",
            "text-brand-black placeholder:text-brand-lightgray focus:outline-none",
            closed && "line-through",
          )}
          placeholder="Topic"
          value={draft.topic || ""}
          onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
          onBlur={() => onPatch({ topic: draft.topic })}
        />
        <select
          className={clsx(
            "shrink-0 cursor-pointer appearance-none rounded-full border-0 px-2.5 py-0.5",
            "text-[11px] font-semibold focus:outline focus:outline-2 focus:outline-brand-red/25",
            PRIORITY_TINT[priority] ?? PRIORITY_TINT.Medium,
          )}
          title="Priority"
          value={priority}
          onChange={(e) => {
            setDraft({ ...draft, priority: e.target.value });
            onPatch({ priority: e.target.value });
          }}
        >
          {PRIORITY_OPTS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select
          className="select w-auto shrink-0 rounded-[7px] px-2 py-1 text-xs"
          title="Status"
          value={draft.status || "open"}
          onChange={(e) => {
            setDraft({ ...draft, status: e.target.value });
            onPatch({ status: e.target.value });
          }}
        >
          {STATUS_OPTS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <button
          type="button"
          className="shrink-0 text-sm text-brand-lightgray transition hover:text-brand-brightred"
          onClick={onDelete}
          aria-label="Delete note"
          title="Delete note"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-2.5 px-[18px] py-3.5">
        <textarea
          className="textarea rounded-[7px] px-[11px] py-[9px] text-[13.5px]"
          rows={2}
          placeholder="Action / follow-up"
          value={draft.action_needed || ""}
          onChange={(e) => setDraft({ ...draft, action_needed: e.target.value })}
          onBlur={() => onPatch({ action_needed: draft.action_needed })}
        />
        <div className="flex flex-wrap items-center gap-2.5 text-xs text-brand-gray">
          {showTextInput ? (
            <input
              className={clsx("input", META_CONTROL, "w-[130px]")}
              placeholder="Project"
              autoFocus={newAreaMode}
              value={draft.project_area || ""}
              onChange={(e) =>
                setDraft({ ...draft, project_area: e.target.value })
              }
              onBlur={() => {
                onPatch({ project_area: draft.project_area });
                // If the value now matches a known sub-project, drop back to the
                // dropdown on next render. The blur path takes care of saving.
                setNewAreaMode(false);
              }}
            />
          ) : (
            <select
              className={clsx("select w-auto", META_CONTROL)}
              value={draft.project_area || ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === NEW_AREA_SENTINEL) {
                  setNewAreaMode(true);
                  setDraft({ ...draft, project_area: "" });
                  onPatch({ project_area: "" });
                  return;
                }
                setDraft({ ...draft, project_area: v });
                onPatch({ project_area: v });
              }}
            >
              <option value="">— Project —</option>
              {subProjects.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value={NEW_AREA_SENTINEL}>{NEW_AREA_LABEL}</option>
            </select>
          )}
          <input
            className={clsx("input", META_CONTROL, "w-[110px]")}
            placeholder="Source"
            value={draft.source || ""}
            onChange={(e) => setDraft({ ...draft, source: e.target.value })}
            onBlur={() => onPatch({ source: draft.source })}
          />
          <label className="flex items-center gap-1.5">
            Note
            <input
              type="date"
              className={clsx("input w-auto", META_CONTROL)}
              value={draft.note_date}
              onChange={(e) => {
                setDraft({ ...draft, note_date: e.target.value });
                onPatch({ note_date: e.target.value });
              }}
            />
          </label>
          <label className="flex items-center gap-1.5">
            Follow-up
            <input
              type="date"
              className={clsx("input w-auto", META_CONTROL)}
              value={draft.follow_up_date || ""}
              onChange={(e) => {
                const v = e.target.value || null;
                setDraft({ ...draft, follow_up_date: v });
                onPatch({ follow_up_date: v });
              }}
            />
          </label>
          <button
            type="button"
            className="ml-auto text-xs font-semibold text-brand-deepgold transition hover:text-brand-red disabled:opacity-50"
            onClick={onSuggest}
            disabled={!draft.action_needed?.trim() && !draft.topic?.trim()}
            title={
              canSuggest
                ? "Use AI to turn this note into an action item"
                : "Capture a meeting on this portfolio first — actions are linked to a meeting."
            }
          >
            ✦ Suggest action
          </button>
        </div>
      </div>
    </div>
  );
}
