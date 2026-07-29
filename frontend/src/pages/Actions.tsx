import { useEffect, useMemo, useRef, useState } from "react";
import type { ButtonHTMLAttributes } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { StatusSelect } from "@/components/StatusPill";
import { useConfirm } from "@/components/ConfirmDialog";
import OwnerPicker from "@/components/actions/OwnerPicker";
import { useApp } from "@/lib/state";
import {
  listActions,
  listAllActions,
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

// One grid definition shared by the header row and every action row so the
// columns can never drift apart: checkbox / action / owner / due / status /
// delete.
const ROW_GRID = "md:grid-cols-[36px_1fr_170px_150px_150px_44px]";

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

/**
 * Bulk-bar button — a shorter, denser ghost than `.btn-ghost`. `tone` picks the
 * hover colour so the two status-changing actions preview their own outcome
 * (green for complete, alert red for cancel) instead of all going brand red.
 */
function BulkButton({
  tone = "red",
  className,
  ...rest
}: { tone?: "red" | "green" | "alert" } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex items-center whitespace-nowrap rounded-[7px] border border-surface-ghost",
        "bg-surface-card px-[13px] py-1.5 text-xs font-semibold text-brand-black transition",
        "disabled:cursor-not-allowed disabled:opacity-50",
        tone === "green" && "hover:border-brand-green hover:text-brand-green",
        tone === "alert" &&
          "hover:border-brand-brightred hover:text-brand-brightred",
        tone === "red" && "hover:border-brand-red hover:text-brand-red",
        className,
      )}
    />
  );
}

/** Mobile-only column label — the md+ layout has a real header row instead. */
function CellLabel({ children }: { children: string }) {
  return (
    <span className="micro-label mb-0.5 block text-brand-gray md:hidden">
      {children}
    </span>
  );
}

export default function Actions() {
  const { currentProject, me } = useApp();
  const [searchParams] = useSearchParams();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  // Default: all actions across every portfolio. Toggle on to scope the list to
  // the header's selected portfolio (the Client > Portfolio picker up top).
  const [scopeToProject, setScopeToProject] = useState(false);
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

  const scoped = scopeToProject && !!currentProject;

  const load = async () => {
    // Scoped-but-no-portfolio: nothing to load, the render shows a hint.
    if (scopeToProject && !currentProject) {
      setActions([]);
      return;
    }
    setLoading(true);
    const [a, m] = await Promise.all([
      scoped ? listActions(currentProject!.id) : listAllActions(),
      // Meetings back the "Add action" picker + raised-date lookup; only the
      // selected portfolio's are needed (cross-portfolio rows carry their own
      // originating_meeting_date from the API).
      currentProject ? listMeetings(currentProject.id) : Promise.resolve([] as Meeting[]),
    ]);
    setActions(a);
    setMeetings(m);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, scopeToProject]);

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

  // Local calendar day as a plain ISO date, so overdue is a pure string compare
  // against `due_date` (also a plain date) with no timezone drift.
  const todayIso = format(new Date(), "yyyy-MM-dd");
  const isOverdue = (a: ActionItem) =>
    !!a.due_date &&
    a.due_date < todayIso &&
    (a.status === "open" || a.status === "pending");

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
    if (!currentProject) {
      alert("Pick a client + portfolio in the header first — a new action needs a portfolio.");
      return;
    }
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
    <div className="space-y-[18px]">
      <PageHeader
        kicker={`${scoped ? currentProject!.name : "All portfolios"} · ${actions.length} total — ${counts.open} open, ${counts.pending} pending, ${counts.completed} completed, ${counts.cancelled} cancelled`}
        title="Rolling action items"
        actions={
          <>
            {/* Scope toggle: all portfolios (default) vs the header-selected one. */}
            <div className="inline-flex overflow-hidden rounded-lg border border-surface-border text-[13px]">
              <button
                type="button"
                onClick={() => setScopeToProject(false)}
                className={
                  !scopeToProject
                    ? "bg-brand-red px-3.5 py-[7px] font-semibold text-white"
                    : "bg-surface-card px-3.5 py-[7px] text-brand-gray transition hover:bg-surface-page"
                }
              >
                All portfolios
              </button>
              <button
                type="button"
                onClick={() => setScopeToProject(true)}
                title={
                  currentProject
                    ? `Scope to ${currentProject.name}`
                    : "Pick a portfolio in the header to scope"
                }
                className={
                  scopeToProject
                    ? "bg-brand-red px-3.5 py-[7px] font-semibold text-white"
                    : "bg-surface-card px-3.5 py-[7px] text-brand-gray transition hover:bg-surface-page"
                }
              >
                {currentProject ? "This portfolio" : "Selected portfolio"}
              </button>
            </div>
            <select
              className="select w-44 rounded-lg text-[13px]"
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
              className="select w-48 rounded-lg text-[13px]"
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
              href={actionsCsvUrl(
                scoped ? currentProject!.id : null,
                filter || "all",
                ownerFilter === "__all__"
                  ? ""
                  : ownerFilter === "__mine__"
                    ? me?.name || ""
                    : ownerFilter,
              )}
              title={
                scoped
                  ? "Download this portfolio's filtered actions as a CSV"
                  : "Download all portfolios' filtered actions as a CSV"
              }
            >
              📥 Export CSV
            </a>
            <button
              className="btn-primary"
              onClick={handleAdd}
              disabled={!currentProject}
              title={
                currentProject
                  ? "Add a new action to the selected portfolio"
                  : "Pick a portfolio in the header to add an action"
              }
            >
              + Add action
            </button>
          </>
        }
      />

      {selectedIds.size > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-[10px] border border-surface-border border-l-[3px] border-l-brand-red bg-surface-card px-4 py-2.5">
          <span className="mr-1 text-[13px] font-bold text-brand-black">
            {selectedIds.size} selected
          </span>
          <BulkButton
            tone="green"
            onClick={bulkMarkCompleted}
            disabled={bulkBusy}
          >
            ✓ Mark completed
          </BulkButton>
          <BulkButton
            tone="alert"
            onClick={bulkMarkCancelled}
            disabled={bulkBusy}
          >
            Mark cancelled
          </BulkButton>
          <BulkButton
            onClick={() => {
              setBulkMode(bulkMode === "owner" ? null : "owner");
              setBulkOwnerValue("");
            }}
            disabled={bulkBusy}
          >
            Change owner…
          </BulkButton>
          <BulkButton
            onClick={() => {
              setBulkMode(bulkMode === "due" ? null : "due");
              setBulkDueValue("");
            }}
            disabled={bulkBusy}
          >
            Change due date…
          </BulkButton>
          <button
            className="ml-auto text-xs font-semibold text-brand-gray transition hover:text-brand-red disabled:opacity-50"
            onClick={clearSelection}
            disabled={bulkBusy}
          >
            Clear selection
          </button>

          {bulkMode === "owner" && (
            <div className="flex w-full items-center gap-2 border-t border-surface-hairline pt-2.5">
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
            <div className="flex w-full items-center gap-2 border-t border-surface-hairline pt-2.5">
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

      {scopeToProject && !currentProject ? (
        <EmptyState
          title="Pick a portfolio to scope"
          hint="Choose a client + portfolio in the header, or switch back to All portfolios."
          action={
            <button
              className="btn-primary mt-2"
              onClick={() => setScopeToProject(false)}
            >
              Show all portfolios
            </button>
          }
        />
      ) : loading ? (
        <div className="card p-5 text-sm text-brand-gray">Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No actions match this filter"
          hint="Try a different status or owner filter, or add a new item."
        />
      ) : (
        <div className="card overflow-hidden">
          {/* Desktop column headers — hidden on mobile because each row
              renders its own inline labels below md (saves a header row
              that would just steal vertical space on a phone). The
              transparent left border matches the rows' 3px overdue rail so
              the columns stay in register. */}
          <div
            className={clsx(
              "hidden gap-3 border-b border-l-[3px] border-surface-hairline border-l-transparent",
              "bg-surface-rowhover px-5 py-[9px] text-[10.5px] font-semibold uppercase",
              "tracking-[0.08em] text-brand-gray md:grid md:items-center",
              ROW_GRID,
            )}
          >
            <input
              type="checkbox"
              className="accent-brand-red justify-self-center"
              aria-label="Select all visible"
              tabIndex={-1}
              checked={allVisibleSelected}
              ref={(el) => {
                if (el) el.indeterminate = someVisibleSelected;
              }}
              onChange={(e) => toggleAllVisible(e.target.checked)}
            />
            <div>Action</div>
            <div>Owner</div>
            <div>Due</div>
            <div>Status</div>
            <div></div>
          </div>
          {/* Mobile-only Select-all bar — surfaces the bulk checkbox that
              would otherwise be hidden in the desktop header. */}
          <div className="flex items-center gap-3 border-b border-surface-hairline bg-surface-rowhover px-4 py-2 text-xs md:hidden">
            <input
              type="checkbox"
              className="accent-brand-red"
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
            // Prefer the date the API attached (works cross-portfolio); fall
            // back to the loaded meetings list when scoped to one portfolio.
            const raisedDate =
              a.originating_meeting_date ||
              meetings.find((m) => m.id === a.originating_meeting_id)
                ?.meeting_date ||
              null;
            const checked = selectedIds.has(a.id);
            return (
              <div
                key={a.id}
                // Mobile: stacked card layout with explicit labels.
                // Desktop (md+): the shared 6-col grid. The left border is the
                // overdue rail — always 3px so nothing reflows when a due date
                // slips past today.
                className={clsx(
                  "flex flex-col gap-2 border-b border-l-[3px] border-surface-page px-4 py-3",
                  "last:border-b-0 md:grid md:items-start md:gap-3 md:px-5 md:py-[13px]",
                  isOverdue(a) ? "border-l-brand-red" : "border-l-transparent",
                  a.status === "completed" && "opacity-[0.65]",
                  ROW_GRID,
                )}
              >
                {/* Top row on mobile: select checkbox + delete, far ends */}
                <div className="flex items-center justify-between md:justify-center md:pt-2">
                  <input
                    type="checkbox"
                    className="accent-brand-red"
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
                    ✕
                  </button>
                </div>

                <div className="min-w-0 space-y-1">
                  <CellLabel>Action</CellLabel>
                  {/* Which portfolio this action belongs to — only meaningful in
                      the cross-portfolio "All portfolios" view. */}
                  {!scoped && a.project_name && (
                    <div className="text-[11px] leading-tight">
                      {a.client_name && (
                        <span className="text-brand-gray">
                          {a.client_name} ·{" "}
                        </span>
                      )}
                      <span className="font-semibold text-brand-red">
                        {a.project_name}
                      </span>
                    </div>
                  )}
                  <textarea
                    className="textarea text-[13.5px] leading-[1.5]"
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
                  {/* Provenance on one line — raised date + who filed it. */}
                  <div className="text-[11px] text-brand-lightgray">
                    Raised{" "}
                    {raisedDate
                      ? format(parseISO(raisedDate), "MMM d, yyyy")
                      : "—"}
                    {a.created_by?.name ? ` · created by ${a.created_by.name}` : ""}
                  </div>
                </div>

                <div>
                  <CellLabel>Owner</CellLabel>
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
                  <CellLabel>Due</CellLabel>
                  <input
                    type="date"
                    className="input text-[13px]"
                    value={a.due_date || ""}
                    onChange={(e) =>
                      handlePatch(a.id, { due_date: e.target.value || null })
                    }
                  />
                </div>

                <div>
                  <CellLabel>Status</CellLabel>
                  <StatusSelect
                    value={a.status}
                    onChange={(v) => handlePatch(a.id, { status: v })}
                  />
                </div>

                {/* Desktop-only delete (mobile's is in the top row) — a bare
                    glyph, so the row's only strong colour stays the overdue rail. */}
                <button
                  className="hidden justify-center pt-2 text-[15px] leading-none text-brand-lightgray transition hover:text-brand-brightred md:flex"
                  onClick={() => handleDelete(a)}
                  title="Delete"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
