import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { StatusSelect } from "@/components/StatusPill";
import { useConfirm } from "@/components/ConfirmDialog";
import UpdatedByLine from "@/components/UpdatedByLine";
import OwnerPicker from "@/components/actions/OwnerPicker";
import { useApp } from "@/lib/state";
import {
  listActions,
  actionsCsvUrl,
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

/**
 * Split a comma-separated owner string into trimmed, non-empty parts.
 * "Roashaael Mary John, Dylan Wraga" -> ["Roashaael Mary John", "Dylan Wraga"]
 */
function splitOwners(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function Actions() {
  const { currentProject, me } = useApp();
  const [searchParams] = useSearchParams();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  // Honour a deep-link from Home's "Your open actions" card: ?status= sets the
  // status filter, ?owner=mine scopes to the signed-in user (by owner_user_id).
  const [filter, setFilter] = useState<string>(() => {
    const s = searchParams.get("status");
    return s && STATUS_FILTERS.some((f) => f.value === s) ? s : "open_pending";
  });
  const [ownerFilter, setOwnerFilter] = useState<string>("__all__");
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMode, setBulkMode] = useState<null | "owner" | "due">(null);
  const [bulkOwnerValue, setBulkOwnerValue] = useState("");
  const [bulkDueValue, setBulkDueValue] = useState("");
  const confirm = useConfirm();

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

  // Reset selection + bulk panels whenever the project changes.
  useEffect(() => {
    setSelectedIds(new Set());
    setBulkMode(null);
    setOwnerFilter("__all__");
  }, [currentProject?.id]);

  // Apply a ?owner=mine deep-link ONCE, after the project-reset above has run
  // (so it isn't clobbered back to "__all__" when the portfolio first hydrates).
  const ownerParamApplied = useRef(false);
  useEffect(() => {
    if (ownerParamApplied.current || !currentProject) return;
    ownerParamApplied.current = true;
    if (searchParams.get("owner") === "mine") setOwnerFilter("__mine__");
  }, [currentProject?.id]);

  // Build the deduped, case-insensitively-sorted owner list off all loaded
  // actions (not just the visible ones — picking from a hidden owner is a
  // legitimate use case).
  const ownerOptions = useMemo(() => {
    const seen = new Map<string, string>(); // lower -> display
    for (const a of actions) {
      for (const part of splitOwners(a.owner)) {
        const key = part.toLowerCase();
        if (!seen.has(key)) seen.set(key, part);
      }
    }
    return Array.from(seen.values()).sort((x, y) =>
      x.toLowerCase().localeCompare(y.toLowerCase())
    );
  }, [actions]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  const filtered = actions.filter((a) => {
    // Status filter
    if (filter === "open_pending") {
      if (!(a.status === "open" || a.status === "pending")) return false;
    } else if (filter !== "all") {
      if (a.status !== filter) return false;
    }
    // Owner filter. "__mine__" scopes to the signed-in user by the canonical
    // owner_user_id link (matches Home's "Your open actions"); otherwise it's a
    // case-insensitive substring match on the comma-split owner-name parts.
    if (ownerFilter === "__mine__") {
      if (!(me && a.owner_user_id === me.id)) return false;
    } else if (ownerFilter !== "__all__") {
      const needle = ownerFilter.toLowerCase();
      const hit = splitOwners(a.owner).some((p) =>
        p.toLowerCase().includes(needle)
      );
      if (!hit) return false;
    }
    return true;
  });

  const visibleIds = filtered.map((a) => a.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected =
    visibleIds.some((id) => selectedIds.has(id)) && !allVisibleSelected;

  const toggleOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        for (const id of visibleIds) next.add(id);
      } else {
        for (const id of visibleIds) next.delete(id);
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBulkMode(null);
  };

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

  const handleDelete = async (action: ActionItem) => {
    const ok = await confirm({
      title: "Delete this action?",
      body: action.text,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await deleteAction(action.id);
    setActions(actions.filter((a) => a.id !== action.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(action.id);
      return next;
    });
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

  // ---------- Bulk operations ----------
  // All four bulk handlers fan out via Promise.all so N updates hit the API
  // in parallel rather than serial. After every bulk op we clear the
  // selection and refetch to keep our view consistent with the server.

  const runBulk = async (patch: Partial<ActionItem>) => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      await Promise.all(ids.map((id) => updateAction(id, patch as any)));
      await load();
      clearSelection();
    } catch (e: any) {
      alert(e.message || "Bulk update failed");
      void load();
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkMarkCompleted = async () => {
    const ok = await confirm({
      title: `Mark ${selectedIds.size} action${selectedIds.size === 1 ? "" : "s"} as completed?`,
      confirmLabel: "Mark completed",
    });
    if (!ok) return;
    await runBulk({ status: "completed" });
  };

  const bulkMarkCancelled = async () => {
    const ok = await confirm({
      title: `Mark ${selectedIds.size} action${selectedIds.size === 1 ? "" : "s"} as cancelled?`,
      body: "Cancelled actions are excluded from rolling reports.",
      confirmLabel: "Mark cancelled",
      destructive: true,
    });
    if (!ok) return;
    await runBulk({ status: "cancelled" });
  };

  const bulkApplyOwner = async () => {
    // Empty string is a legitimate value — it clears the owner.
    await runBulk({ owner: bulkOwnerValue });
    setBulkOwnerValue("");
  };

  const bulkApplyDue = async () => {
    await runBulk({ due_date: bulkDueValue || null });
    setBulkDueValue("");
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
              aria-label="Status filter"
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              className="select w-48"
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              aria-label="Owner filter"
            >
              <option value="__all__">All owners</option>
              {me && <option value="__mine__">Mine (me)</option>}
              {ownerOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <a
              className="btn-ghost"
              href={
                currentProject
                  ? actionsCsvUrl(
                      currentProject.id,
                      filter || "all",
                      ownerFilter === "__all__"
                        ? ""
                        : ownerFilter === "__mine__"
                          ? me?.name || ""
                          : ownerFilter,
                    )
                  : "#"
              }
              title="Download the currently-filtered actions as a CSV (Excel-friendly)"
              aria-disabled={!currentProject}
            >
              📥 Export CSV
            </a>
            <button className="btn-primary" onClick={handleAdd}>
              + Add action
            </button>
          </>
        }
      />

      {selectedIds.size > 0 && (
        <div className="sticky top-2 z-20 bg-white border border-slate-200 rounded-lg shadow-sm flex flex-wrap gap-2 p-3 items-center">
          <span className="text-sm font-semibold text-slate-700 mr-2">
            {selectedIds.size} selected
          </span>
          <button
            className="btn-ghost"
            onClick={bulkMarkCompleted}
            disabled={bulkBusy}
          >
            Mark Completed
          </button>
          <button
            className="btn-danger"
            onClick={bulkMarkCancelled}
            disabled={bulkBusy}
          >
            Mark Cancelled
          </button>
          <button
            className="btn-ghost"
            onClick={() => {
              setBulkMode(bulkMode === "owner" ? null : "owner");
              setBulkOwnerValue("");
            }}
            disabled={bulkBusy}
          >
            Change owner…
          </button>
          <button
            className="btn-ghost"
            onClick={() => {
              setBulkMode(bulkMode === "due" ? null : "due");
              setBulkDueValue("");
            }}
            disabled={bulkBusy}
          >
            Change due date…
          </button>
          <button
            className="btn-ghost"
            onClick={clearSelection}
            disabled={bulkBusy}
          >
            Clear selection
          </button>

          {bulkMode === "owner" && (
            <div className="w-full flex gap-2 items-center pt-2">
              <input
                className="input flex-1"
                placeholder="New owner (comma-separate for multiple)"
                value={bulkOwnerValue}
                onChange={(e) => setBulkOwnerValue(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void bulkApplyOwner();
                  }
                  if (e.key === "Escape") setBulkMode(null);
                }}
              />
              <button
                className="btn-primary"
                onClick={bulkApplyOwner}
                disabled={bulkBusy}
              >
                Apply
              </button>
              <button
                className="btn-ghost"
                onClick={() => setBulkMode(null)}
                disabled={bulkBusy}
              >
                Cancel
              </button>
            </div>
          )}

          {bulkMode === "due" && (
            <div className="w-full flex gap-2 items-center pt-2">
              <input
                type="date"
                className="input flex-1"
                value={bulkDueValue}
                onChange={(e) => setBulkDueValue(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void bulkApplyDue();
                  }
                  if (e.key === "Escape") setBulkMode(null);
                }}
              />
              <button
                className="btn-primary"
                onClick={bulkApplyDue}
                disabled={bulkBusy}
              >
                Apply
              </button>
              <button
                className="btn-ghost"
                onClick={() => setBulkMode(null)}
                disabled={bulkBusy}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="card p-5 text-sm text-brand-gray">Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No actions match this filter"
          hint="Try a different status or owner filter, or add a new item."
        />
      ) : (
        <div className="card divide-y divide-brand-lightgray/60 overflow-hidden">
          {/* Desktop column headers — hidden on mobile because each row
              renders its own inline labels below md (saves a header row
              that would just steal vertical space on a phone). */}
          <div className="hidden md:grid md:grid-cols-[32px_1fr_180px_140px_140px_60px] gap-3 px-5 py-2 text-xs uppercase tracking-wider text-brand-gray font-semibold bg-brand-nearwhite/70 items-center">
            <div className="flex justify-center">
              <input
                type="checkbox"
                aria-label="Select all visible"
                tabIndex={-1}
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someVisibleSelected;
                }}
                onChange={(e) => toggleAllVisible(e.target.checked)}
              />
            </div>
            <div>Action</div>
            <div>Owner</div>
            <div>Due</div>
            <div>Status</div>
            <div></div>
          </div>
          {/* Mobile-only Select-all bar — surfaces the bulk checkbox that
              would otherwise be hidden in the desktop header. */}
          <div className="md:hidden px-4 py-2 bg-brand-nearwhite/70 flex items-center gap-3 text-xs">
            <input
              type="checkbox"
              aria-label="Select all visible"
              checked={allVisibleSelected}
              ref={(el) => {
                if (el) el.indeterminate = someVisibleSelected;
              }}
              onChange={(e) => toggleAllVisible(e.target.checked)}
            />
            <span className="text-brand-gray">
              Select all visible ({filtered.length})
            </span>
          </div>
          {filtered.map((a) => {
            const raisedMeeting = meetings.find(
              (m) => m.id === a.originating_meeting_id
            );
            const checked = selectedIds.has(a.id);
            return (
              <div
                key={a.id}
                // Mobile: stacked card layout with explicit labels.
                // Desktop (md+): the original 6-col grid (180px owner col
                // up from 140px to fit the new typeahead picker chip).
                className="flex flex-col gap-2 px-4 py-3 md:grid md:grid-cols-[32px_1fr_180px_140px_140px_60px] md:gap-3 md:px-5 md:py-3 md:items-start"
              >
                {/* Top row on mobile: select checkbox + delete, far ends */}
                <div className="flex justify-between items-center md:flex md:justify-center md:items-start md:pt-2 md:block">
                  <input
                    type="checkbox"
                    aria-label={`Select action ${a.id}`}
                    tabIndex={-1}
                    checked={checked}
                    onChange={(e) => toggleOne(a.id, e.target.checked)}
                  />
                  {/* Delete button shown on mobile next to the checkbox; on
                      desktop the dedicated delete cell at the end of the row
                      handles it (this one stays hidden via md:hidden). */}
                  <button
                    className="btn-danger md:hidden"
                    onClick={() => handleDelete(a)}
                    title="Delete"
                  >
                    ×
                  </button>
                </div>

                <div className="space-y-1">
                  <span className="text-[10px] uppercase tracking-wider text-brand-gray font-semibold md:hidden">
                    Action
                  </span>
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
                  <UpdatedByLine
                    user={a.created_by}
                    at={a.created_at}
                    prefix="Created by"
                  />
                </div>

                <div>
                  <span className="text-[10px] uppercase tracking-wider text-brand-gray font-semibold md:hidden block mb-0.5">
                    Owner
                  </span>
                  <OwnerPicker
                    value={a.owner || ""}
                    ownerUserId={a.owner_user_id ?? null}
                    onChange={({ owner, owner_user_id }) => {
                      setActions(
                        actions.map((x) =>
                          x.id === a.id
                            ? { ...x, owner, owner_user_id }
                            : x,
                        ),
                      );
                      void handlePatch(a.id, { owner, owner_user_id });
                    }}
                  />
                </div>

                <div>
                  <span className="text-[10px] uppercase tracking-wider text-brand-gray font-semibold md:hidden block mb-0.5">
                    Due
                  </span>
                  <input
                    type="date"
                    className="input"
                    value={a.due_date || ""}
                    onChange={(e) =>
                      handlePatch(a.id, { due_date: e.target.value || null })
                    }
                  />
                </div>

                <div>
                  <span className="text-[10px] uppercase tracking-wider text-brand-gray font-semibold md:hidden block mb-0.5">
                    Status
                  </span>
                  <StatusSelect
                    value={a.status}
                    onChange={(v) => handlePatch(a.id, { status: v })}
                  />
                </div>

                {/* Desktop-only delete button (mobile's is in the top row) */}
                <button
                  className="btn-danger hidden md:block"
                  onClick={() => handleDelete(a)}
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
