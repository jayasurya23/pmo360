import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { StatusSelect, StatusPill } from "@/components/StatusPill";
import { useApp } from "@/lib/state";
import {
  listActions,
  updateAction,
  deleteAction,
  createAction,
  listMeetings,
} from "@/lib/api";
import type { ActionItem, Meeting } from "@/lib/types";
import { format, parseISO } from "date-fns";

const STATUS_FILTERS = [
  { value: "open_pending", label: "Open + Pending" },
  { value: "all", label: "All statuses" },
  { value: "open", label: "Open only" },
  { value: "pending", label: "Pending only" },
  { value: "completed", label: "Completed only" },
  { value: "cancelled", label: "Cancelled only" },
] as const;

export default function Actions() {
  const { currentProject } = useApp();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [filter, setFilter] = useState<string>("open_pending");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (!currentProject) return;
    setLoading(true);
    const [a, m] = await Promise.all([
      listActions(currentProject.id),
      listMeetings(currentProject.id),
    ]);
    setActions(a);
    setMeetings(m);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [currentProject?.id]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  const filtered = actions.filter((a) => {
    if (filter === "all") return true;
    if (filter === "open_pending")
      return a.status === "open" || a.status === "pending";
    return a.status === filter;
  });

  const handlePatch = async (id: number, patch: Partial<ActionItem>) => {
    // Optimistic update
    setActions(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    try {
      await updateAction(id, patch as any);
    } catch (e: any) {
      alert(e.message);
      void load();
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this action?")) return;
    await deleteAction(id);
    setActions(actions.filter((a) => a.id !== id));
  };

  const handleAdd = async () => {
    if (!meetings.length) {
      alert("Create a meeting first — actions are tied to an originating meeting.");
      return;
    }
    const newRow = await createAction({
      project_id: currentProject.id,
      originating_meeting_id: meetings[0].id,
      text: "New action item",
      owner: "",
      due_date: null,
      status: "open",
    });
    setActions([newRow, ...actions]);
  };

  const counts = {
    open: actions.filter((a) => a.status === "open").length,
    pending: actions.filter((a) => a.status === "pending").length,
    completed: actions.filter((a) => a.status === "completed").length,
    cancelled: actions.filter((a) => a.status === "cancelled").length,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rolling action items"
        subtitle={`${actions.length} total — ${counts.open} open, ${counts.pending} pending, ${counts.completed} completed, ${counts.cancelled} cancelled`}
        actions={
          <>
            <select
              className="select w-44"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <button className="btn-primary" onClick={handleAdd}>
              + Add action
            </button>
          </>
        }
      />

      {loading ? (
        <div className="card p-5 text-sm text-brand-gray">Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No actions match this filter"
          hint="Try a different status filter or add a new item."
        />
      ) : (
        <div className="card divide-y divide-brand-lightgray/60 overflow-hidden">
          <div className="grid grid-cols-[1fr_140px_140px_140px_60px] gap-3 px-5 py-2 text-xs uppercase tracking-wider text-brand-gray font-semibold bg-brand-nearwhite/70">
            <div>Action</div>
            <div>Owner</div>
            <div>Due</div>
            <div>Status</div>
            <div></div>
          </div>
          {filtered.map((a) => {
            const raisedMeeting = meetings.find(
              (m) => m.id === a.originating_meeting_id
            );
            return (
              <div
                key={a.id}
                className="grid grid-cols-[1fr_140px_140px_140px_60px] gap-3 px-5 py-3 items-start"
              >
                <div className="space-y-1">
                  <textarea
                    className="textarea text-sm"
                    rows={2}
                    value={a.text}
                    onChange={(e) =>
                      setActions(
                        actions.map((x) =>
                          x.id === a.id ? { ...x, text: e.target.value } : x
                        )
                      )
                    }
                    onBlur={(e) =>
                      a.text !== e.target.value
                        ? handlePatch(a.id, { text: e.target.value })
                        : null
                    }
                  />
                  <div className="text-[11px] text-brand-gray">
                    Raised{" "}
                    {raisedMeeting
                      ? format(parseISO(raisedMeeting.meeting_date), "MMM d, yyyy")
                      : "—"}
                  </div>
                </div>
                <input
                  className="input"
                  value={a.owner || ""}
                  onChange={(e) =>
                    setActions(
                      actions.map((x) =>
                        x.id === a.id ? { ...x, owner: e.target.value } : x
                      )
                    )
                  }
                  onBlur={(e) => handlePatch(a.id, { owner: e.target.value })}
                />
                <input
                  type="date"
                  className="input"
                  value={a.due_date || ""}
                  onChange={(e) =>
                    handlePatch(a.id, { due_date: e.target.value || null })
                  }
                />
                <StatusSelect
                  value={a.status}
                  onChange={(v) => handlePatch(a.id, { status: v })}
                />
                <button
                  className="btn-danger"
                  onClick={() => handleDelete(a.id)}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
