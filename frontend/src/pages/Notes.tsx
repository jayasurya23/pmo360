import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { useApp } from "@/lib/state";
import { listNotes, createNote, updateNote, deleteNote } from "@/lib/api";
import type { Note } from "@/lib/types";

const PRIORITY_OPTS = ["Low", "Medium", "High"];
const STATUS_OPTS = ["open", "closed"];

export default function NotesPage() {
  const { currentProject } = useApp();
  const [notes, setNotes] = useState<Note[]>([]);
  const [filter, setFilter] = useState<"all" | "open" | "closed">("open");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!currentProject) return;
    setLoading(true);
    const data = await listNotes(currentProject.id);
    setNotes(data);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, [currentProject?.id]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  const filtered = notes.filter(
    (n) => filter === "all" || (n.status || "open") === filter
  );

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

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this note?")) return;
    await deleteNote(id);
    setNotes(notes.filter((n) => n.id !== id));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Planner notes"
        subtitle="Lightweight notes between meetings — separate from rolling action items."
        actions={
          <>
            <select
              className="select w-32"
              value={filter}
              onChange={(e) => setFilter(e.target.value as any)}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
            <button className="btn-primary" onClick={handleAdd}>
              + Add note
            </button>
          </>
        }
      />

      {loading ? (
        <div className="card p-5 text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No notes" hint="Use + Add note to capture one." />
      ) : (
        <div className="space-y-3">
          {filtered.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              onPatch={(patch) => handlePatch(n.id, patch)}
              onDelete={() => handleDelete(n.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NoteCard({
  note,
  onPatch,
  onDelete,
}: {
  note: Note;
  onPatch: (p: Partial<Note>) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(note);
  useEffect(() => setDraft(note), [note.id]);
  return (
    <div className="card p-4 space-y-2">
      <div className="grid grid-cols-12 gap-2">
        <input
          className="input col-span-4"
          placeholder="Topic"
          value={draft.topic || ""}
          onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
          onBlur={() => onPatch({ topic: draft.topic })}
        />
        <input
          className="input col-span-3"
          placeholder="Source"
          value={draft.source || ""}
          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
          onBlur={() => onPatch({ source: draft.source })}
        />
        <input
          className="input col-span-2"
          placeholder="Area"
          value={draft.project_area || ""}
          onChange={(e) =>
            setDraft({ ...draft, project_area: e.target.value })
          }
          onBlur={() => onPatch({ project_area: draft.project_area })}
        />
        <select
          className="select col-span-1"
          value={draft.priority || "Medium"}
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
          className="select col-span-1"
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
        <button className="btn-danger col-span-1" onClick={onDelete}>
          ×
        </button>
      </div>
      <textarea
        className="textarea"
        rows={2}
        placeholder="Action / follow-up"
        value={draft.action_needed || ""}
        onChange={(e) => setDraft({ ...draft, action_needed: e.target.value })}
        onBlur={() => onPatch({ action_needed: draft.action_needed })}
      />
      <div className="grid grid-cols-2 gap-2 text-xs text-brand-gray">
        <label className="flex items-center gap-2">
          Note date
          <input
            type="date"
            className="input text-xs"
            value={draft.note_date}
            onChange={(e) => {
              setDraft({ ...draft, note_date: e.target.value });
              onPatch({ note_date: e.target.value });
            }}
          />
        </label>
        <label className="flex items-center gap-2">
          Follow-up
          <input
            type="date"
            className="input text-xs"
            value={draft.follow_up_date || ""}
            onChange={(e) => {
              const v = e.target.value || null;
              setDraft({ ...draft, follow_up_date: v });
              onPatch({ follow_up_date: v });
            }}
          />
        </label>
      </div>
    </div>
  );
}
