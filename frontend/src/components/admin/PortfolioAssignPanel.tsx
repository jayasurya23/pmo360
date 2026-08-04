/**
 * Portfolio assignment — ONE panel, for one person or for eight.
 *
 * The row chip opens it with a single id, the bulk bar opens it with several.
 * There is deliberately no second single-person implementation: the whole
 * reason the old grid was unusable is that assigning portfolios was a per-row
 * dropdown, one person and one portfolio per pick, which is 336 interactions
 * to staff 8 people across 42 portfolios.
 *
 * Three things make it work at that size:
 *
 *  1. GROUPED AND SEARCHABLE. ~42 portfolios under ~21 clients is not a list
 *     you scan, so they are grouped by client, filterable, and each client can
 *     be staffed in one click.
 *  2. HONEST ABOUT MIXED STATE. With several people selected, "is this
 *     portfolio ticked?" often has no yes/no answer — some of them are on it,
 *     some are not. That renders as an indeterminate box and a literal "2 of
 *     5", never as the first person's answer applied to everyone.
 *  3. STAGED, NOT LIVE. Ticks accumulate into a pending add/remove set shown
 *     in the footer, and nothing is written until Apply. Staffing eight people
 *     is a decision about a set, so the set is what the footer counts and what
 *     Apply sends — and a mis-click costs a second click, not a round-trip.
 *
 * ---- WHAT ASSIGNMENT ACTUALLY DOES ----
 *
 * It is a VISIBILITY setting, not a permission. `is_portfolio_member` in
 * auth/permissions.py is disabled and returns true for anyone signed in —
 * Castillo's rule is that every PM reaches every portfolio — so nothing in
 * here grants or revokes the ability to edit anything. What it moves is where
 * somebody's *Mine* filter and dashboard scope look (`my_only` on
 * GET /api/projects, `scope=mine` on the dashboard rollups) and who appears on
 * the portfolio's Manage Team roster.
 *
 * This panel used to warn, in red, that assigning the first person LIMITED a
 * portfolio to them and revoked everyone else. That was true of a rule which
 * lasted about three hours; the warnings outlived it. Nothing here may imply
 * that assigning or unassigning takes anybody's access away.
 *
 * Member counts are derived here rather than fetched: GET /api/admin/users
 * embeds every membership row of every user, so the union across the grid IS
 * the ProjectMember table — which is what lets a row say "nobody has this on
 * their dashboard" before anything is written.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useApp } from "@/lib/state";
import {
  bulkAssignMemberships,
  listAdminUsers,
  listAllPortfolios,
} from "@/lib/api";
import type {
  AdminBulkMembershipResult,
  AdminUser,
  MembershipFlip,
  Project,
} from "@/lib/types";

/** A staged change for one portfolio. Absent = leave this portfolio alone. */
type Intent = "add" | "remove";

/** How the selected people currently sit on one portfolio. */
type RowState = "all" | "some" | "none";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Who is being staffed — one id from a row chip, several from the bulk bar. */
  userIds: number[];
  /** Fires once the batch has landed, so the grid can refetch. */
  onDone: () => void;
}

export default function PortfolioAssignPanel({
  open,
  onClose,
  userIds,
  onDone,
}: Props) {
  const { clients } = useApp();

  const [allUsers, setAllUsers] = useState<AdminUser[]>([]);
  const [portfolios, setPortfolios] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [intents, setIntents] = useState<Record<number, Intent>>({});
  const [saving, setSaving] = useState(false);
  /** Set once the batch lands. The panel then shows what actually happened
   *  instead of vanishing — 32 staged pairs collapsing into "6 added, 26
   *  already there" is the receipt that makes the idempotency legible. */
  const [result, setResult] = useState<AdminBulkMembershipResult | null>(null);

  /** Who this panel is about, snapshotted when it opens.
   *
   *  NOT read live off the prop. The parent owns the grid's tick-boxes and is
   *  very likely to clear them the moment `onDone` fires, which would empty
   *  the panel out from under the summary it is showing — and `userIds` is a
   *  fresh array on every parent render besides, so a live read would refetch
   *  and discard staged ticks on unrelated re-renders. */
  const [subjectIds, setSubjectIds] = useState<number[]>([]);

  // Does NOT clear `error` — it is also the recovery path after a half-applied
  // batch, and the message explaining what half landed has to survive it.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [grid, projects] = await Promise.all([
        listAdminUsers(),
        // Every portfolio across every client: staffing is not scoped to
        // whichever client the header happens to be sitting on.
        listAllPortfolios(false),
      ]);
      setAllUsers(grid.users ?? []);
      setPortfolios(projects);
    } catch (e: any) {
      setError(e?.message || "Could not load portfolios.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSubjectIds(userIds);
    setQuery("");
    setIntents({});
    setResult(null);
    setError(null);
    void load();
    // `userIds` is deliberately not a dependency — it is snapshotted, not
    // tracked. See the note on `subjectIds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  const clientNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of clients) m.set(c.id, c.name);
    return m;
  }, [clients]);

  const selectedUsers = useMemo(() => {
    const ids = new Set(subjectIds);
    return allUsers.filter((u) => ids.has(u.id));
  }, [allUsers, subjectIds]);

  /** Every membership row in the app, counted per portfolio. The grid endpoint
   *  returns all users with all their memberships embedded, so this union is
   *  the full ProjectMember table — which is what makes "nobody is assigned to
   *  this one" answerable before the write rather than after it. */
  const membersByProject = useMemo(() => {
    const m = new Map<number, number>();
    for (const u of allUsers) {
      for (const p of u.portfolios ?? []) {
        m.set(p.project_id, (m.get(p.project_id) ?? 0) + 1);
      }
    }
    return m;
  }, [allUsers]);

  /** How many of the SELECTED people are on each portfolio. Drives the
   *  tri-state box. */
  const selectedOnProject = useMemo(() => {
    const m = new Map<number, number>();
    for (const u of selectedUsers) {
      for (const p of u.portfolios ?? []) {
        m.set(p.project_id, (m.get(p.project_id) ?? 0) + 1);
      }
    }
    return m;
  }, [selectedUsers]);

  const total = selectedUsers.length;

  const stateFor = useCallback(
    (projectId: number): RowState => {
      const n = selectedOnProject.get(projectId) ?? 0;
      if (n === 0) return "none";
      return n >= total ? "all" : "some";
    },
    [selectedOnProject, total],
  );

  const label = useCallback(
    (p: Project) => {
      const client = clientNameById.get(p.client_id);
      return client ? `${client} · ${p.name}` : p.name;
    },
    [clientNameById],
  );

  /** Portfolios grouped under their client, filtered by the search box. */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byClient = new Map<string, Project[]>();
    for (const p of portfolios) {
      const client = clientNameById.get(p.client_id) || "Other";
      if (q && !`${client} ${p.name}`.toLowerCase().includes(q)) continue;
      const bucket = byClient.get(client);
      if (bucket) bucket.push(p);
      else byClient.set(client, [p]);
    }
    return [...byClient.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([client, items]) => ({
        client,
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [portfolios, clientNameById, query]);

  const projectById = useMemo(() => {
    const m = new Map<number, Project>();
    for (const p of portfolios) m.set(p.id, p);
    return m;
  }, [portfolios]);

  const staged = useMemo(() => {
    const adds: Project[] = [];
    const removes: Project[] = [];
    for (const [key, intent] of Object.entries(intents)) {
      const p = projectById.get(Number(key));
      if (!p) continue;
      (intent === "add" ? adds : removes).push(p);
    }
    adds.sort((a, b) => label(a).localeCompare(label(b)));
    removes.sort((a, b) => label(a).localeCompare(label(b)));
    return { adds, removes };
  }, [intents, projectById, label]);

  // A pair of memos lived here — willScope and willEmpty — that predicted
  // which portfolios were about to cross zero members, so the panel could warn
  // that assigning the first person revoked everyone else's write access and
  // that removing the last one handed it back. Neither consequence exists:
  // membership gates no write. Crossing zero is still a real event, but it is
  // a dashboard event, and the server reports it authoritatively in `flipped`
  // once the batch lands — so it is said once, afterwards, in plain type,
  // rather than twice beforehand in red.

  // Deactivated accounts cannot hold a portfolio — the server refuses the
  // assignment outright — so they are dropped from the ADD call and the panel
  // says so, rather than letting the whole batch fail on their account.
  // Removals still include them: an offboarded person's stale assignments are
  // exactly what an admin is here to clean up.
  const activeUsers = useMemo(
    () => selectedUsers.filter((u) => u.is_active),
    [selectedUsers],
  );
  const activeUserIds = useMemo(
    () => activeUsers.map((u) => u.id),
    [activeUsers],
  );
  const inactiveCount = total - activeUsers.length;

  function toggle(projectId: number) {
    const state = stateFor(projectId);
    setIntents((prev) => {
      const next = { ...prev };
      const cur = prev[projectId];
      const cycled = cycleIntent(state, cur);
      if (cycled) next[projectId] = cycled;
      else delete next[projectId];
      return next;
    });
  }

  /** Stage an add for every portfolio in one client that isn't already fully
   *  assigned — the staffing accelerator, and the reason a 21-client list is
   *  workable at all. */
  function addWholeClient(items: Project[]) {
    setIntents((prev) => {
      const next = { ...prev };
      for (const p of items) {
        if (stateFor(p.id) === "all") continue;
        next[p.id] = "add";
      }
      return next;
    });
  }

  async function handleApply() {
    if (!staged.adds.length && !staged.removes.length) return;
    if (staged.adds.length && activeUserIds.length === 0) {
      setError(
        "Everyone selected is deactivated, so nobody can be assigned to a " +
          "portfolio. Reactivate them first.",
      );
      return;
    }

    // No confirmation step. Assignment takes nothing away from anybody, and a
    // dialog in front of a reversible visibility change is how admins learn to
    // dismiss dialogs without reading them.
    setSaving(true);
    setError(null);
    try {
      let combined: AdminBulkMembershipResult = {
        added: 0,
        removed: 0,
        skipped: 0,
        flipped: [],
      };
      // Two calls because the wire contract carries one action per request.
      // The order used to be load-bearing — a stranded removal was the
      // permissive half — and no longer is, since neither direction changes
      // who may write. Removals still go first so a failure between the two
      // leaves FEWER assignments than intended rather than more: under-staffed
      // dashboards are the state the error message tells the admin to fix, and
      // re-pressing Apply is safe because a re-sent add counts as skipped.
      if (staged.removes.length) {
        combined = mergeResults(
          combined,
          await bulkAssignMemberships(
            subjectIds,
            staged.removes.map((p) => p.id),
            "remove",
          ),
        );
      }
      if (staged.adds.length && activeUserIds.length) {
        combined = mergeResults(
          combined,
          await bulkAssignMemberships(
            activeUserIds,
            staged.adds.map((p) => p.id),
            "add",
          ),
        );
      }
      setResult(combined);
      setIntents({});
      onDone();
    } catch (e: any) {
      setError(e?.message || "The server rejected that change.");
      // The two halves are two requests, so a failure here can mean the first
      // one already landed. Re-read before letting anyone press Apply again:
      // every count on screen — the tri-state boxes, "2 of 5", "nobody
      // assigned" — is derived from the memberships loaded above, and a stale
      // set would have the admin restaging changes that already applied. The
      // retry itself is safe: a re-sent assignment is counted as skipped.
      void load();
      onDone();
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const changeCount = staged.adds.length + staged.removes.length;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="portfolio-assign-title"
    >
      <div
        className="absolute inset-0 bg-brand-black/40 backdrop-blur-sm"
        onClick={() => !saving && onClose()}
      />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3
              id="portfolio-assign-title"
              className="text-base font-semibold text-brand-black"
            >
              {result ? "Portfolios updated" : "Assign portfolios"}
            </h3>
            <div className="mt-0.5 truncate text-xs text-brand-gray">
              {describePeople(selectedUsers) || `${subjectIds.length} selected`}
            </div>
          </div>
          <button
            type="button"
            className="text-xs text-brand-lightgray hover:text-brand-gray"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="rounded-md border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
            {error}
          </div>
        )}

        {result ? (
          <ResultSummary result={result} />
        ) : loading ? (
          <p className="py-6 text-sm text-brand-gray">Loading portfolios…</p>
        ) : selectedUsers.length === 0 ? (
          // The grid moved under us — those ids no longer exist. Nothing here
          // could be computed honestly (membership counts, mixed state, who
          // "everyone else" is), so the panel refuses rather than guessing.
          <p className="py-6 text-sm text-brand-gray">
            Those people are no longer in the user list. Close this and reload
            the grid.
          </p>
        ) : (
          <>
            <input
              type="text"
              className="input"
              placeholder="Filter by client or portfolio…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />

            {inactiveCount > 0 && (
              <p className="text-[11px] text-brand-gray">
                {inactiveCount === 1
                  ? "One selected person is deactivated"
                  : `${inactiveCount} selected people are deactivated`}{" "}
                and cannot be assigned to a portfolio — reactivate them first.
                They can still be removed from portfolios here.
              </p>
            )}

            <div className="flex-1 overflow-y-auto rounded-[10px] border border-surface-border">
              {groups.length === 0 ? (
                <p className="p-4 text-sm text-brand-gray">
                  {query
                    ? "No portfolio matches that."
                    : "No portfolios exist yet."}
                </p>
              ) : (
                groups.map(({ client, items }) => (
                  <div key={client}>
                    <div className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-surface-hairline bg-surface-mute px-3 py-1.5">
                      <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-brand-gray">
                        {client}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-[11px] font-semibold text-brand-gray hover:text-brand-red"
                        onClick={() => addWholeClient(items)}
                      >
                        + Add all {items.length}
                      </button>
                    </div>
                    <ul>
                      {items.map((p) => (
                        <PortfolioRow
                          key={p.id}
                          project={p}
                          state={stateFor(p.id)}
                          intent={intents[p.id]}
                          selectedCount={selectedOnProject.get(p.id) ?? 0}
                          totalPeople={total}
                          memberCount={membersByProject.get(p.id) ?? 0}
                          onToggle={() => toggle(p.id)}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>

            {/* One quiet line, above the buttons, saying what the whole panel
                does. It sits here rather than in a tooltip because "does this
                take somebody's access away?" is the question an admin brings
                to this screen, and the answer has to be visible without
                hovering anything. */}
            <p className="text-[11px] text-brand-gray">
              Assigning a portfolio puts it on that person's{" "}
              <strong className="font-semibold">Mine</strong> filter, dashboard
              and Manage Team roster. It does not change what anyone may edit —
              every permission holder can already work on every portfolio.
            </p>

            <div className="flex items-center justify-between gap-2 border-t border-surface-hairline pt-3">
              <div className="text-xs text-brand-gray">
                {changeCount === 0 ? (
                  "Click a portfolio to stage a change"
                ) : (
                  <>
                    {staged.adds.length > 0 && (
                      <span className="font-semibold text-status-completed-text">
                        {staged.adds.length} to add
                      </span>
                    )}
                    {staged.adds.length > 0 && staged.removes.length > 0 && " · "}
                    {staged.removes.length > 0 && (
                      <span className="font-semibold text-brand-brightred">
                        {staged.removes.length} to remove
                      </span>
                    )}
                    <button
                      type="button"
                      className="ml-2 text-brand-lightgray hover:text-brand-gray"
                      onClick={() => setIntents({})}
                    >
                      clear
                    </button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={onClose}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleApply()}
                  disabled={saving || changeCount === 0}
                >
                  {saving ? "Applying…" : "Apply"}
                </button>
              </div>
            </div>
          </>
        )}

        {result && (
          <div className="flex justify-end border-t border-surface-hairline pt-3">
            <button type="button" className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ============================================================
 * Row
 * ============================================================ */
function PortfolioRow({
  project,
  state,
  intent,
  selectedCount,
  totalPeople,
  memberCount,
  onToggle,
}: {
  project: Project;
  state: RowState;
  intent?: Intent;
  selectedCount: number;
  totalPeople: number;
  memberCount: number;
  onToggle: () => void;
}) {
  // The box shows the state this portfolio would END UP in, so a staged change
  // reads as the result rather than as a second thing to decode. The words on
  // the right say which of the two it is.
  const checked = intent === "add" || (state === "all" && intent !== "remove");
  const indeterminate = !checked && state === "some" && intent === undefined;

  return (
    <li
      className={clsx(
        "flex cursor-pointer items-center gap-3 border-b border-surface-hairline px-3 py-1.5 last:border-0 transition",
        intent ? "bg-surface-mute" : "hover:bg-surface-rowhover",
      )}
      onClick={onToggle}
    >
      <TriCheckbox
        checked={checked}
        indeterminate={indeterminate}
        label={`Assign ${project.name}`}
      />
      <span className="min-w-0 flex-1 truncate text-[13px] text-brand-black">
        {project.name}
        {/* Said once per row, quietly. A portfolio nobody is assigned to is
            reachable and editable like any other — it just never surfaces on a
            Mine filter or a scoped dashboard, which is precisely the gap an
            admin opens this panel to close. */}
        {memberCount === 0 && (
          <span
            className="ml-2 text-[11px] text-brand-lightgray"
            title="Nobody is assigned, so this portfolio appears on no one's Mine filter or dashboard. It is still editable by anyone holding the matching permission."
          >
            nobody assigned
          </span>
        )}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums">
        {intent === "add" ? (
          <span className="font-semibold text-status-completed-text">
            + adding
          </span>
        ) : intent === "remove" ? (
          <span className="font-semibold text-brand-brightred">− removing</span>
        ) : (
          <span className="text-brand-lightgray">
            {describeMembership(selectedCount, totalPeople)}
          </span>
        )}
      </span>
    </li>
  );
}

/** A checkbox that can say "some of them" — the state a multi-person picker
 *  spends most of its life in. `indeterminate` is a DOM property with no HTML
 *  attribute, so it can only be set through a ref. */
function TriCheckbox({
  checked,
  indeterminate,
  label,
}: {
  checked: boolean;
  indeterminate: boolean;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-3.5 w-3.5 shrink-0 accent-brand-red"
      checked={checked}
      aria-label={label}
      // Presentational: the whole <li> is the click target, and a click that
      // starts on the box bubbles up to it like any other. Deliberately NOT
      // stopping propagation here — doing so would make the one part of the
      // row that looks most clickable the one part that does nothing.
      readOnly
    />
  );
}

/* ============================================================
 * Result
 * ============================================================ */
/**
 * What the batch did, plus the two zero-crossings the server reports.
 *
 * `flipped` is worth keeping on screen, but only just, and only in this tone.
 * It was added when crossing zero members changed who could WRITE to a
 * portfolio; that rule is gone and the field's own docstring now calls it a
 * visibility report. What survives is a genuinely useful fact an admin cannot
 * get anywhere else in one step: this portfolio was on nobody's dashboard and
 * now it is on somebody's, or the reverse. That is the outcome they came here
 * for, confirmed from the authoritative side rather than from the counts this
 * panel guessed at beforehand. So it stays — as plain type, in the summary,
 * with no colour and no alarm, and it stops appearing the moment the server
 * stops sending it.
 */
function ResultSummary({ result }: { result: AdminBulkMembershipResult }) {
  const nowStaffed = (result.flipped ?? []).filter((f) => f.became_scoped);
  const nowEmpty = (result.flipped ?? []).filter((f) => f.became_unowned);
  return (
    <div className="space-y-3">
      <p className="text-sm text-brand-black">
        {sentenceFor(result)}
        {result.skipped > 0 && (
          <span className="text-brand-gray">
            {" "}
            {result.skipped}{" "}
            {result.skipped === 1 ? "assignment was" : "assignments were"}{" "}
            already the way you asked for, so nothing changed there.
          </span>
        )}
      </p>

      {nowStaffed.length > 0 && (
        <Notice title="Now on somebody's dashboard">
          {listNames(nowStaffed.map(flipLabel))} had nobody assigned, so{" "}
          {nowStaffed.length === 1 ? "it appeared" : "they appeared"} on no
          one's <em>Mine</em> filter or dashboard.{" "}
          {nowStaffed.length === 1 ? "It does" : "They do"} now.
        </Notice>
      )}
      {nowEmpty.length > 0 && (
        <Notice title="Now on nobody's dashboard">
          {listNames(nowEmpty.map(flipLabel))}{" "}
          {nowEmpty.length === 1 ? "has" : "have"} nobody assigned now, so{" "}
          {nowEmpty.length === 1 ? "it drops" : "they drop"} off every{" "}
          <em>Mine</em> filter and scoped dashboard until someone is assigned
          again. Editing is unaffected.
        </Notice>
      )}
    </div>
  );
}

function sentenceFor(r: AdminBulkMembershipResult): string {
  const parts: string[] = [];
  if (r.added) parts.push(`${r.added} ${r.added === 1 ? "assignment" : "assignments"} added`);
  if (r.removed) parts.push(`${r.removed} removed`);
  if (!parts.length) return "Nothing needed changing.";
  return `${parts.join(", ")}.`;
}

function flipLabel(f: MembershipFlip): string {
  return f.client_name ? `${f.client_name} · ${f.project_name}` : f.project_name;
}

/* ============================================================
 * Bits
 * ============================================================ */
/** A neutral aside in the result summary. It carried an alert/caution tone
 *  when the two notices under it announced access changing hands; both now
 *  report where a portfolio shows up, which is information, not a hazard —
 *  status colours here would have an admin looking for a problem to fix. */
function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-surface-border bg-surface-mute px-3 py-2 text-[11.5px] leading-relaxed text-brand-gray">
      <span className="font-semibold text-brand-black">{title}. </span>
      {children}
    </div>
  );
}

function cycleIntent(state: RowState, current: Intent | undefined): Intent | undefined {
  // Every cycle returns to "leave it alone", so a mis-click is always one more
  // click away from undone rather than needing a separate reset.
  if (state === "all") return current === "remove" ? undefined : "remove";
  if (state === "none") return current === "add" ? undefined : "add";
  // Mixed: both directions are meaningful, so offer both before neutral.
  if (current === undefined) return "add";
  if (current === "add") return "remove";
  return undefined;
}

function describeMembership(assigned: number, total: number): string {
  if (total <= 1) return assigned > 0 ? "assigned" : "—";
  if (assigned === 0) return `0 of ${total}`;
  if (assigned >= total) return `all ${total}`;
  return `${assigned} of ${total}`;
}

/** "Ana Ruiz", "Ana Ruiz and Bo Chen", "Ana Ruiz and 6 others". Used in prose,
 *  so it has to read as a sentence fragment rather than a list dump. */
function describePeople(users: AdminUser[]): string {
  const names = users.map((u) => u.name || u.email || `User #${u.id}`);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/** Same idea for portfolios, but these are the subject of a warning, so as
 *  many as will fit are named outright — "3 portfolios" would leave the admin
 *  guessing which three. */
function listNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= 4) {
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

function mergeResults(
  a: AdminBulkMembershipResult,
  b: AdminBulkMembershipResult,
): AdminBulkMembershipResult {
  return {
    added: a.added + (b.added ?? 0),
    removed: a.removed + (b.removed ?? 0),
    skipped: a.skipped + (b.skipped ?? 0),
    flipped: [...a.flipped, ...(b.flipped ?? [])],
  };
}
