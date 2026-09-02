import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ButtonHTMLAttributes } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import PageHeader from "@/components/PageHeader";
import { DraftTextarea, type DraftCommit } from "@/components/DraftField";
import EmptyState from "@/components/EmptyState";
import { StatusSelect } from "@/components/StatusPill";
import OwedBySelect, { OWED_BY_HINT } from "@/components/actions/OwedBySelect";
import { useConfirm } from "@/components/ConfirmDialog";
import OwnerPicker from "@/components/actions/OwnerPicker";
import SubProjectSelect from "@/components/SubProjectSelect";
import MoveActionDialog, {
  type ReassignMode,
  type ReassignTarget,
} from "@/components/actions/MoveActionDialog";
import OwnerFilterSelect, {
  OWNER_ALL,
  OWNER_MINE,
} from "@/components/actions/OwnerFilterSelect";
import { useApp } from "@/lib/state";
import {
  listActions,
  updateAction,
  deleteAction,
  createAction,
  listMeetings,
  moveAction,
  copyAction,
} from "@/lib/api";
import { serialWrite } from "@/lib/serialWrite";
import { saveActionsCsv } from "@/lib/documents";
import type {
  ActionItem,
  ActionScope,
  ActionScopeLevel,
  Meeting,
} from "@/lib/types";
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
 * The scope segmented control, narrow → wide.
 *
 * A segmented control rather than a toggle because there are three answers now,
 * and because the old two-state toggle was the discoverability half of the bug:
 * the view a client call needs took two separate steps (pick the portfolio in
 * the header, then find and flip a control on the page), so it read as though
 * the only choices were one portfolio or the entire company.
 */
const SCOPE_OPTIONS: { value: ActionScopeLevel; label: string }[] = [
  { value: "portfolio", label: "This portfolio" },
  { value: "client", label: "This client" },
  { value: "all", label: "All" },
];

/** `?scope=` lives beside the header's own `?client=` / `?portfolio=` params so
 *  the level survives a reload and travels in a pasted link. */
const SCOPE_PARAM = "scope";

function isScopeLevel(v: string | null): v is ActionScopeLevel {
  return v === "portfolio" || v === "client" || v === "all";
}

// One grid definition shared by the header row and every action row so the
// columns can never drift apart: checkbox / action / owner / due / status /
// delete.
// Last column holds two glyphs (move, delete) rather than one. Widened for
// both and applied to every row, so the controls sit in the same place on
// every row in every state — nothing slides sideways as rows change.
const ROW_GRID = "md:grid-cols-[36px_1fr_170px_150px_150px_64px]";

/** One portfolio's slice of a multi-portfolio result. `ActionItem.project_id`
 *  IS the portfolio (actions have no sub-portfolio tier), so it is the key. */
interface PortfolioGroup {
  key: number;
  portfolio: string;
  client: string | null;
  rows: ActionItem[];
  /** Counted over everything in scope for this portfolio, NOT over the rows
   *  the status filter left visible — the header states a fact about the
   *  portfolio, which is what makes it useful while filtered to "Completed".
   *  The OWNER filter is honoured though: once the page is narrowed to one
   *  person, a number on their group header reads as theirs. */
  open: number;
  pending: number;
}

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

/**
 * The bulk "change owner" field.
 *
 * Its own component purely so the owner text lives in ITS state rather than the
 * page's. As page state, every character re-ran the status + owner filter,
 * rebuilt the portfolio groups (deliberately unmemoised) and re-rendered every
 * visible row — the same per-keystroke page render that made the action text
 * stutter at real row counts.
 *
 * Deliberately NOT built on DraftField: this value is read by a discrete action
 * (Enter / Apply), and a debounced hand-up would let Enter fire against a value
 * the field hasn't pushed yet — applying a half-typed owner across every
 * selected row.
 */
function BulkOwnerInput({
  busy,
  onApply,
  onCancel,
}: {
  busy: boolean;
  onApply: (owner: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const apply = () => {
    void onApply(value);
    setValue("");
  };
  return (
    <div className="flex w-full items-center gap-2 border-t border-surface-hairline pt-2.5">
      <input
        className="input flex-1"
        placeholder="New owner (comma-separate for multiple)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply();
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      <button className="btn-primary" onClick={apply} disabled={busy}>
        Apply
      </button>
      <button className="btn-ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}

export default function Actions() {
  const { clients, projects, currentClient, currentProject, me } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);

  /**
   * What the URL asked for AT ARRIVAL, read once.
   *
   * `searchParams` is reactive and the header rewrites `?client=` / `?portfolio=`
   * as soon as the user touches it, so anything that means "how did we get
   * here" has to be captured on mount or it turns into "where are we now".
   */
  const [entry] = useState(() => ({
    ownerMine: searchParams.get("owner") === "mine",
    namesPortfolio: searchParams.get("portfolio") != null,
  }));

  // ---------- scope ----------
  // The level the user PICKED, or null while they haven't. Null is not "all":
  // it means "follow the header", which is what makes the default below work.
  const [chosenLevel, setChosenLevel] = useState<ActionScopeLevel | null>(() => {
    const raw = searchParams.get(SCOPE_PARAM);
    return isScopeLevel(raw) ? raw : null;
  });

  // THE DEFAULT IS THE FIX — do not "restore" the old one.
  //
  // Client calls are run per portfolio ("the calls with client are usually per
  // portfolio"), so the view a PM needs for a call must be the view they LAND
  // on. This page used to default to every action in the company with
  // per-portfolio as an opt-in toggle, which inverted that: the common view was
  // two steps away and the page read as "one project or everything".
  //
  // Derived rather than seeded-once on purpose: the header hydrates
  // asynchronously (clients, then that client's portfolios), so a one-shot seed
  // fires in the gap and pins "this client" on a header that is a tick away
  // from selecting a portfolio. It stops being derived the moment the user
  // picks a level, which is the persistence rule below.
  //
  // THE ONE EXCEPTION: a `?owner=mine` link that names no portfolio. "What is
  // assigned to me" is a PERSON-shaped question, not a portfolio-shaped one —
  // Home and MyWorkPanel count it across every client and portfolio and print
  // that number on the button ("View all 12 open actions →"). Those links
  // predate `?scope=`, and the header auto-selects a first client and a first
  // portfolio when nothing is stored, so following the header here would land a
  // button labelled 12 on a page showing 2. MyWorkPanel's portfolio-scoped
  // branch DOES send `?portfolio=`, and that one still means one portfolio.
  const defaultLevel: ActionScopeLevel =
    entry.ownerMine && !entry.namesPortfolio
      ? "all"
      : currentProject
        ? "portfolio"
        : currentClient
          ? "client"
          : "all";
  const scopeLevel = chosenLevel ?? defaultLevel;

  /**
   * HYBRID PERSISTENCE: the header owns WHICH client/portfolio, this control
   * owns HOW WIDE, and a header change must not silently rewrite the width.
   * Switching from Utopian Power to another client while on "This client"
   * leaves you on "This client" for the new client.
   *
   * The level goes in the URL so it survives a reload and can be shared. That
   * write also re-runs the header's own URL watchers in lib/state, but they
   * re-resolve `?client=` / `?portfolio=` — untouched here — to the ids they
   * already hold, so it is a no-op there.
   */
  const pickScope = (level: ActionScopeLevel) => {
    setChosenLevel(level);
    setSearchParams(
      (sp) => {
        const next = new URLSearchParams(sp);
        next.set(SCOPE_PARAM, level);
        return next;
      },
      { replace: true },
    );
  };

  // The one scope object handed to the list call and the CSV export, so the
  // file a PM downloads is always the rows on their screen.
  const scope: ActionScope = {
    level: scopeLevel,
    projectId: currentProject?.id ?? null,
    clientId: currentClient?.id ?? null,
  };
  // A level the header can't satisfy (a hand-edited URL, or a client cleared
  // out from under us) shows an empty state rather than quietly widening —
  // quietly widening to the whole company is the behaviour being fixed.
  const scopeReady =
    scopeLevel === "all" ||
    (scopeLevel === "portfolio" && !!currentProject) ||
    (scopeLevel === "client" && !!currentClient);
  // Two portfolios or more can be on screen, so the rows need grouping.
  const grouping = scopeLevel !== "portfolio";

  // Honour a deep-link from Home's "Your open actions" card: ?status= sets the
  // status filter, ?owner=mine scopes to the signed-in user (by owner_user_id).
  const [filter, setFilter] = useState<string>(() => {
    const s = searchParams.get("status");
    return s && STATUS_FILTERS.some((f) => f.value === s) ? s : "open_pending";
  });
  // ?owner=mine is read here, synchronously, exactly like ?status= above — NOT
  // in an effect. It used to be applied by a latched effect that raced the
  // header's two-stage hydration: the reset effect below fires again when the
  // portfolio resolves a round-trip after the client, by which point the
  // apply-once effect had already spent itself, so the deep link was silently
  // reset to "All owners" on every load.
  const [ownerFilter, setOwnerFilter] = useState<string>(
    entry.ownerMine ? OWNER_MINE : OWNER_ALL,
  );
  const [loading, setLoading] = useState(false);
  // Bumped on every completed load. The owner dropdown fetches its own grouped
  // list from the server, so it has no way to notice that a PM just retyped an
  // owner in the table — this is the nudge that keeps the two in step.
  const [loadSeq, setLoadSeq] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMode, setBulkMode] = useState<null | "owner" | "due" | "owed">(null);
  /** Rows awaiting a move/copy destination. Holds ids rather than the action
   *  objects so a refetch underneath the open dialog cannot leave it acting on
   *  stale copies. */
  const [reassigning, setReassigning] = useState<null | { ids: number[] }>(null);
  const [bulkDueValue, setBulkDueValue] = useState("");
  // Inline-edit save failures. Deliberately not an alert(): see commitText.
  const [saveError, setSaveError] = useState<string | null>(null);
  const confirm = useConfirm();

  /**
   * The header is still arriving. `clients` is empty only before `listClients`
   * resolves (or on a genuinely empty install, where there are no actions to
   * show either), so this is the one signal that separates "nothing selected"
   * from "not selected YET".
   *
   * Worth having because `defaultLevel` is derived: without it the first commit
   * has no client and no portfolio, resolves to "all", and fires a full-company
   * query that is always superseded — the heaviest request on the page, issued
   * on every visit, purely to render a flash of the exact view this change
   * exists to stop landing on.
   */
  const headerHydrating = clients.length === 0 && !currentClient;

  // Monotonic request token. Header hydration produces three commits — nothing
  // selected, then the client, then that client's portfolio — and because the
  // default is derived, those are three DIFFERENT scopes: "all", "this client",
  // "this portfolio". The widest is issued first and is by far the slowest, so
  // without a token its response can land last and leave every client's rows on
  // screen under a kicker, a segmented control and a CSV export that all say one
  // portfolio — and a bulk "mark completed" would then reach rows the PM
  // believes are inside a single portfolio.
  const reqSeq = useRef(0);

  const load = async () => {
    const seq = ++reqSeq.current;
    // Unsatisfiable scope (or a header that hasn't landed): nothing to load,
    // the render shows a hint.
    if (headerHydrating || !scopeReady) {
      setActions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [a, m] = await Promise.all([
        // One call for all three levels — `listActions` sends the id the level
        // needs and nothing for "all".
        listActions(scope),
        // Meetings back the "Add action" picker + raised-date lookup; only the
        // selected portfolio's are needed (cross-portfolio rows carry their own
        // originating_meeting_date from the API).
        currentProject ? listMeetings(currentProject.id) : Promise.resolve([] as Meeting[]),
      ]);
      // Superseded: a newer scope is already in flight or already rendered.
      // Dropping the whole commit (rows, meetings, loading, loadSeq) keeps the
      // table, the kicker and the owner dropdown describing one scope.
      if (seq !== reqSeq.current) return;
      setActions(a);
      setMeetings(m);
      setLoading(false);
      setLoadSeq((n) => n + 1);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      console.error(e);
      // Clear the spinner rather than leaving "Loading…" on screen forever —
      // an empty table is at least an honest one.
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, currentClient?.id, scopeLevel, headerHydrating]);

  // Reset selection + bulk panels + collapse state whenever the rows underneath
  // them change — a bulk op must never reach rows that have left the view, and
  // group keys are portfolio ids, so a collapse carried into a different client
  // would fold away portfolios the user never touched. Widening or narrowing
  // the scope counts as changing the rows.
  useEffect(() => {
    setSelectedIds(new Set());
    setCollapsedGroups(new Set());
    setBulkMode(null);
  }, [currentProject?.id, currentClient?.id, scopeLevel]);

  // The owner filter is reset by a HEADER change only, not by a scope change:
  // "show me everything Dylan owns across this client" is the reason someone
  // widens the scope, and clearing the owner would answer a different question.
  //
  // A header CHANGE, not the header ARRIVING. Hydration walks null -> client,
  // then null -> portfolio one round-trip later, and treating either as a user
  // action is what used to reset a `?owner=mine` deep link to "All owners" on
  // essentially every load. So: reset only when an id that had already resolved
  // becomes a different value (a different portfolio, a different client, or
  // cleared to "All"). An id going null -> something is the header landing.
  const prevHeader = useRef<{ c: number | null; p: number | null }>({
    c: null,
    p: null,
  });
  useEffect(() => {
    const c = currentClient?.id ?? null;
    const p = currentProject?.id ?? null;
    const prev = prevHeader.current;
    prevHeader.current = { c, p };
    const clientChanged = prev.c !== null && c !== prev.c;
    const portfolioChanged = prev.p !== null && p !== prev.p;
    if (clientChanged || portfolioChanged) setOwnerFilter(OWNER_ALL);
  }, [currentProject?.id, currentClient?.id]);

  // Deduped, case-insensitively-sorted owner names off all loaded actions (not
  // just the visible ones — picking from a hidden owner is a legitimate use
  // case). This used to BE the dropdown; it is now only the fallback the owner
  // filter falls back to when /actions/owners can't be reached, so the filter
  // degrades to "names, no companies" instead of to nothing.
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

  const matchesStatus = (a: ActionItem) => {
    if (filter === "open_pending")
      return a.status === "open" || a.status === "pending";
    if (filter === "all") return true;
    return a.status === filter;
  };

  /**
   * Owner filter. OWNER_MINE scopes to the signed-in user by the canonical
   * owner_user_id link (matches Home's "Your open actions"); otherwise the
   * selected name is matched EXACTLY against the comma-split owner parts.
   *
   * Exact, not substring, and the dropdown is why. Every option now carries
   * the count of actions naming that person, computed by splitting on commas
   * and folding case — so a substring match here would show "CK  3" and then
   * return every row whose owner merely CONTAINS those letters, Nick and
   * Rickard included. A badge that disagrees with the list beside it is worse
   * than no badge. The options are the distinct owner parts, so exact match
   * is also what the reader means by picking one.
   *
   * Split out from the status predicate because the group headers need one and
   * not the other — see `portfolioTotals`.
   */
  const matchesOwner = (a: ActionItem) => {
    if (ownerFilter === OWNER_MINE) return !!me && a.owner_user_id === me.id;
    if (ownerFilter === OWNER_ALL) return true;
    const needle = ownerFilter.trim().toLowerCase();
    return splitOwners(a.owner).some((p) => p.toLowerCase() === needle);
  };

  const filtered = actions.filter((a) => matchesStatus(a) && matchesOwner(a));

  // Open/pending per portfolio, over everything in scope rather than over the
  // status-filtered rows — see PortfolioGroup for why that asymmetry is the
  // useful one.
  //
  // The OWNER filter is applied though, unlike the status filter. Once a reader
  // has narrowed the page to one person, a count sitting on a group header
  // reads as that person's count; "7 open · 3 pending" above Dylan's single row
  // is a claim about Dylan that the rows underneath contradict, and it is the
  // number a PM scans to decide which portfolio he is behind on.
  const portfolioTotals = useMemo(() => {
    const totals = new Map<number, { open: number; pending: number }>();
    for (const a of actions) {
      if (!matchesOwner(a)) continue;
      const t = totals.get(a.project_id) || { open: 0, pending: 0 };
      if (a.status === "open") t.open += 1;
      else if (a.status === "pending") t.pending += 1;
      totals.set(a.project_id, t);
    }
    return totals;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, ownerFilter, me?.id]);

  // Group by portfolio under the two wide scopes. This is the "sort the
  // portfolios" half of the ask: a client call still walks one portfolio at a
  // time even with the whole client on screen, and an undifferentiated list of
  // 200 rows is exactly what sends people back to picking one portfolio.
  //
  // Not memoised: `filtered` is rebuilt every render anyway, so a memo here
  // would only pretend to save work.
  const groups: PortfolioGroup[] | null = grouping
    ? (() => {
        const byPortfolio = new Map<number, PortfolioGroup>();
        for (const a of filtered) {
          let g = byPortfolio.get(a.project_id);
          if (!g) {
            const totals = portfolioTotals.get(a.project_id);
            g = {
              key: a.project_id,
              // The name comes from the list endpoint; the id is the honest
              // fallback rather than a blank header.
              portfolio: a.project_name || `Portfolio #${a.project_id}`,
              client: a.client_name || null,
              rows: [],
              open: totals?.open || 0,
              pending: totals?.pending || 0,
            };
            byPortfolio.set(a.project_id, g);
          }
          g.rows.push(a);
        }
        return Array.from(byPortfolio.values()).sort(
          (x, y) =>
            (x.client || "").localeCompare(y.client || "") ||
            x.portfolio.localeCompare(y.portfolio),
        );
      })()
    : null;

  // Rows the table is actually SHOWING. Collapsed groups are excluded so
  // "select all visible" cannot reach rows nobody can see — a bulk complete
  // that silently swept up a folded-away portfolio would be unrecoverable.
  // `toggleGroup` handles the other half of that promise: it drops a group's
  // rows from the selection as they fold away, because the bulk bar acts on
  // `selectedIds` and not on this list.
  const renderedActions = groups
    ? groups
        .filter((g) => !collapsedGroups.has(g.key))
        .flatMap((g) => g.rows)
    : filtered;

  const visibleIds = renderedActions.map((a) => a.id);
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

  const toggleGroup = (key: number) => {
    const collapsing = !collapsedGroups.has(key);
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!collapsing) return;
    // Drop this group's rows from the selection as they leave the screen. The
    // bulk bar operates on `selectedIds`, not on what is rendered, so a
    // selection made BEFORE the collapse would otherwise let "Mark cancelled"
    // or a bulk owner overwrite sweep up a folded-away portfolio the user
    // cannot see and cannot undo row by row.
    const rows = groups?.find((g) => g.key === key)?.rows ?? [];
    if (!rows.length) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const r of rows) next.delete(r.id);
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setBulkMode(null);
  };

  /** Commit an edited action text. Stable (empty deps + functional setState) so
   *  DraftTextarea's memo actually holds — a handler rebuilt every render
   *  would re-render every row on every commit and undo the whole point.
   *  `key` is the action id, passed straight back by the draft component.
   *
   *  Two things this must NOT do, both learned the hard way:
   *
   *  1. Fire the PATCH straight at axios. DraftTextarea commits on an idle
   *     debounce as well as on blur, so composing a sentence with thinking
   *     pauses issues several writes for this row, each carrying a growing
   *     prefix of the same column against an endpoint with no version token.
   *     Concurrently, a late-arriving early write truncates the row in the DB
   *     while the screen still shows the whole sentence. serialWrite keeps one
   *     write per action in flight, so arrival order == issue order.
   *  2. `alert()` on failure and reload. Failures now arrive per typing pause,
   *     so a 30-second network blip threw a stack of blocking modals mid-
   *     sentence, and the reload then replaced the row's text underneath a
   *     focused field. The error goes to a quiet line under the toolbar and
   *     the text stays where the PM put it. */
  const commitText = useCallback<DraftCommit>((text, key) => {
    const id = Number(key);
    setActions((prev) => prev.map((x) => (x.id === id ? { ...x, text } : x)));
    void serialWrite(`action:${id}`, () =>
      updateAction(id, { text } as any),
    ).then(
      () => setSaveError(null),
      (e: any) =>
        setSaveError(
          `Couldn't save that edit — ${e?.message || "the server rejected it"}. ` +
            "The text is still on screen but is NOT saved; edit the field again to retry.",
        ),
    );
  }, []);

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

  /**
   * Move or copy the rows the dialog was opened for.
   *
   * Serial, not `Promise.all`, and that is the one place this differs from the
   * bulk handlers above. A partial failure here is not "one row kept its old
   * owner" — it is rows scattered across two portfolios with no record of which
   * landed. Stopping at the first error leaves a prefix that moved and a
   * suffix that did not, and re-throwing lets the dialog say so while the
   * refetch shows exactly where everything ended up.
   */
  const handleReassign = async (mode: ReassignMode, target: ReassignTarget) => {
    const ids = reassigning?.ids ?? [];
    if (!ids.length) return;
    const fn = mode === "move" ? moveAction : copyAction;
    let done = 0;
    try {
      for (const id of ids) {
        await fn(id, target);
        done += 1;
      }
    } catch (e: any) {
      await load();
      clearSelection();
      if (done > 0) {
        // Say what actually happened. "Failed" alone would leave the PM
        // assuming nothing moved when some of it did.
        const detail = e?.response?.data?.detail || e?.message || "";
        throw new Error(
          `${done} of ${ids.length} ${mode === "move" ? "moved" : "copied"} before this failed: ${detail}`,
        );
      }
      throw e;
    }
    await load();
    clearSelection();
    setReassigning(null);
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

  // Empty string is a legitimate value — it clears the owner. The value comes
  // in from BulkOwnerInput rather than living in page state: typing it here
  // re-ran the status+owner filter, rebuilt the portfolio groups and
  // re-rendered every row on every character, which is the same stutter this
  // page was reported for.
  const bulkApplyOwner = (owner: string) => runBulk({ owner });
  /** Triage the selection in one go. `null` puts rows back to untriaged, which
   *  is how a mis-swept batch is undone. */
  const bulkApplyOwed = (client_owed: boolean | null) =>
    runBulk({ client_owed } as Partial<ActionItem>);

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

  // The kicker NAMES the active scope, so a screenshot pasted into a call is
  // unambiguous about which rows it is showing.
  const scopeLabel =
    scopeLevel === "portfolio"
      ? currentProject
        ? currentProject.name
        : "No portfolio selected"
      : scopeLevel === "client"
        ? currentClient
          ? `${currentClient.name} — all portfolios`
          : "No client selected"
        : "All portfolios";

  // A client that genuinely has no portfolios. `projects` is also empty for the
  // one round-trip between the client resolving and its portfolios arriving, so
  // this settles by the time the first result renders.
  const clientHasNoPortfolios = !!currentClient && projects.length === 0;

  // Why a segment is greyed out, in the page rather than in a tooltip: this
  // page is used on phones, where a title attribute never appears.
  //
  // Derived from WHICH SEGMENT is blocked, not from which id is missing. Keying
  // it on the ids told a client with zero portfolios to "pick a portfolio in
  // the header" — from a dropdown that has none in it — and told someone in
  // "All clients" mode with a portfolio pinned from the URL that they could not
  // scope to a portfolio, which they can.
  const portfolioSegmentBlocked = !currentProject;
  const clientSegmentBlocked = !currentClient;
  const scopeHints: string[] = [];
  if (portfolioSegmentBlocked)
    scopeHints.push(
      clientHasNoPortfolios
        ? `${currentClient!.name} has no portfolios yet, so “This portfolio” has nothing to scope to.`
        : "Pick a portfolio in the header to use “This portfolio”.",
    );
  if (clientSegmentBlocked)
    scopeHints.push("Pick a client in the header to use “This client”.");
  const scopeHint = scopeHints.length ? scopeHints.join(" ") : null;

  /** One action row. Extracted so the grouped and ungrouped layouts render
   *  the identical row rather than two copies that drift. */
  const renderRow = (a: ActionItem) => {
    // Prefer the date the API attached (works cross-portfolio); fall back to
    // the loaded meetings list when scoped to one portfolio.
    const raisedDate =
      a.originating_meeting_date ||
      meetings.find((m) => m.id === a.originating_meeting_id)?.meeting_date ||
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
          {/* Move + delete shown on mobile next to the checkbox; on desktop
              the dedicated cell at the end of the row handles both (these stay
              hidden via md:hidden). */}
          <div className="flex items-center gap-1.5 md:hidden">
            <button
              className="btn-ghost px-2 py-1 text-[13px]"
              onClick={() => setReassigning({ ids: [a.id] })}
              title="Move or copy to another portfolio"
              aria-label={`Move or copy action ${a.id}`}
            >
              ⇄
            </button>
            <button
              className="btn-danger"
              onClick={() => handleDelete(a)}
              title="Delete"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="min-w-0 space-y-1">
          <CellLabel>Action</CellLabel>
          {/* No per-row portfolio label any more — the group header above
              carries it, and repeating it on every row was noise. */}
          {/* The reported field. Keystrokes stay inside DraftTextarea; the
              page (and the PATCH) hear about the text on its debounce / blur /
              unmount. Before, every character re-ran the status+owner filter,
              invalidated the portfolioTotals scan, rebuilt every portfolio
              group and re-rendered every row. */}
          <DraftTextarea
            className="textarea text-[13.5px] leading-[1.5]"
            rows={2}
            value={a.text}
            commitKey={a.id}
            onCommit={commitText}
          />
          {/* Sub-project, under the action's OWN portfolio — not the header's.
              On a client-wide list every row can belong to a different
              portfolio, so offering the header's sub-projects would offer the
              wrong ones. Renders nothing at all when the portfolio has none,
              which is most of them: an empty dropdown reads as broken, and
              tagging is meant to be an extra step, not a prompt. */}
          <SubProjectSelect
            portfolioId={a.project_id}
            value={a.portfolio_project_id ?? null}
            ariaLabel={`Project for action ${a.id}`}
            className="select select-sm w-auto max-w-[13rem]"
            onChange={(next) => {
              setActions((prev) =>
                prev.map((x) =>
                  x.id === a.id ? { ...x, portfolio_project_id: next } : x,
                ),
              );
              void handlePatch(a.id, { portfolio_project_id: next });
            }}
          />
          {/* Provenance on one line — raised date + who filed it. */}
          <div className="text-[11px] text-brand-lightgray">
            Raised{" "}
            {raisedDate ? format(parseISO(raisedDate), "MMM d, yyyy") : "—"}
            {a.created_by?.name ? ` · created by ${a.created_by.name}` : ""}
          </div>
        </div>

        <div className="space-y-1">
          <CellLabel>Owner</CellLabel>
          <OwnerPicker
            value={a.owner || ""}
            ownerUserId={a.owner_user_id ?? null}
            onChange={({ owner, owner_user_id }) => {
              setActions(
                actions.map((x) =>
                  x.id === a.id ? { ...x, owner, owner_user_id } : x,
                ),
              );
              void handlePatch(a.id, { owner, owner_user_id });
            }}
          />
          {/* Who closes it. Sits under the owner because it answers the
              question the owner column cannot: `owner` is free text and a null
              owner_user_id covers vendors as well as clients. */}
          <OwedBySelect
            value={a.client_owed}
            ariaLabel={`Who closes action ${a.id}`}
            className="select select-sm w-full text-[12.5px]"
            onChange={(next) => {
              setActions((prev) =>
                prev.map((x) => (x.id === a.id ? { ...x, client_owed: next } : x)),
              );
              void handlePatch(a.id, { client_owed: next });
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

        {/* Desktop-only row controls (mobile's are in the top row) — bare
            glyphs, so the row's only strong colour stays the overdue rail.
            Both always render, so neither ever shifts under the cursor. */}
        <div className="hidden items-start justify-center gap-2 pt-2 md:flex">
          <button
            className="text-[14px] leading-none text-brand-lightgray transition hover:text-brand-red"
            onClick={() => setReassigning({ ids: [a.id] })}
            title="Move or copy to another portfolio"
            aria-label={`Move or copy action ${a.id}`}
          >
            ⇄
          </button>
          <button
            className="text-[15px] leading-none text-brand-lightgray transition hover:text-brand-brightred"
            onClick={() => handleDelete(a)}
            title="Delete"
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-[18px]">
      <PageHeader
        kicker={`${scopeLabel} · ${actions.length} total — ${counts.open} open, ${counts.pending} pending, ${counts.completed} completed, ${counts.cancelled} cancelled`}
        title="Rolling action items"
        actions={
          <>
            {/* Scope: this portfolio (the default when one is selected) /
                this client / everything. */}
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <div
                role="group"
                aria-label="Action scope"
                className="inline-flex overflow-hidden rounded-lg border border-surface-border text-[13px]"
              >
                {SCOPE_OPTIONS.map((opt) => {
                  const blocked =
                    (opt.value === "portfolio" && !currentProject) ||
                    (opt.value === "client" && !currentClient);
                  const active = scopeLevel === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={blocked}
                      aria-pressed={active}
                      onClick={() => pickScope(opt.value)}
                      title={
                        blocked
                          ? opt.value === "portfolio"
                            ? clientHasNoPortfolios
                              ? `${currentClient!.name} has no portfolios yet`
                              : "Pick a portfolio in the header first"
                            : "Pick a client in the header first"
                          : opt.value === "portfolio"
                            ? `Only ${currentProject!.name}`
                            : opt.value === "client"
                              ? `Every portfolio under ${currentClient!.name}`
                              : "Every portfolio in the company"
                      }
                      className={clsx(
                        "whitespace-nowrap px-3 py-[7px] transition sm:px-3.5",
                        active
                          ? "bg-brand-red font-semibold text-white"
                          : "bg-surface-card text-brand-gray hover:bg-surface-page",
                        blocked &&
                          "cursor-not-allowed opacity-50 hover:bg-surface-card",
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              {scopeHint && (
                <p className="max-w-[260px] text-[11px] leading-tight text-brand-gray sm:text-right">
                  {scopeHint}
                </p>
              )}
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
            {/* Custom, not a <select>: browsers ignore colour on <option>, and
                colour-per-company was the point. See OwnerFilterSelect for
                what that costs and what it reimplements. */}
            <OwnerFilterSelect
              value={ownerFilter}
              onChange={setOwnerFilter}
              // THE SAME scope object the table and the export get. Handing it
              // a portfolio id would have been right at two levels out of three
              // and a company-wide superset at "This client" — the dropdown
              // would offer people this client has no rows for, with counts the
              // table beside it contradicts.
              scope={scope}
              meName={me ? me.name || me.email || "" : null}
              fallbackNames={ownerOptions}
              reloadKey={loadSeq}
            />
            {/* Button, not anchor — the export route is token-gated and an
                href sends no Authorization header. See lib/documents.ts. */}
            <button
              type="button"
              className="btn-ghost"
              // Disabled while the scope is unsatisfiable. An id-less
              // "portfolio" scope sends no filter at all, so the export would
              // quietly hand back every client in the company under a filename
              // and a screen that both say one portfolio.
              disabled={!scopeReady}
              onClick={() =>
                void saveActionsCsv(
                  // The scope ON SCREEN, not the header's selection: an export
                  // that ignores it hands back a plausible-looking file of the
                  // wrong rows.
                  scope,
                  filter || "all",
                  ownerFilter === OWNER_ALL || ownerFilter === OWNER_MINE
                    ? ""
                    : ownerFilter,
                  // "Mine" travels as the USER ID, because that is the key the
                  // table filtered on (`a.owner_user_id === me.id`). Sending
                  // `me.name` instead — as this used to — silently swapped rows
                  // in both directions: a row reading "D. Wraga" linked to Dylan
                  // dropped out, a stale "Dylan Wraga" with no link appeared,
                  // and the counts could still match.
                  ownerFilter === OWNER_MINE ? (me?.id ?? null) : null,
                )
              }
              title={
                scopeReady
                  ? `Download the filtered actions for ${scopeLabel} as a CSV` +
                    " — the whole scope, including any collapsed groups"
                  : "Pick a scope the header can fill before exporting"
              }
            >
              📥 Export CSV
            </button>
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

      {/* Inline-edit save failure. A quiet line rather than an alert() so a
          flaky connection can't interrupt someone mid-sentence — see
          commitText. Dismissible because the retry is just typing again. */}
      {saveError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-[10px] border border-surface-border border-l-[3px] border-l-brand-brightred bg-surface-card px-4 py-2.5 text-[13px] text-brand-black"
        >
          <span className="flex-1">{saveError}</span>
          <button
            className="shrink-0 text-xs font-semibold text-brand-gray transition hover:text-brand-red"
            onClick={() => setSaveError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

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
            onClick={() => setBulkMode(bulkMode === "owner" ? null : "owner")}
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
          <BulkButton
            onClick={() => setBulkMode(bulkMode === "owed" ? null : "owed")}
            disabled={bulkBusy}
          >
            Owed by…
          </BulkButton>
          <BulkButton
            onClick={() => setReassigning({ ids: Array.from(selectedIds) })}
            disabled={bulkBusy}
          >
            Move / copy…
          </BulkButton>
          <button
            className="ml-auto text-xs font-semibold text-brand-gray transition hover:text-brand-red disabled:opacity-50"
            onClick={clearSelection}
            disabled={bulkBusy}
          >
            Clear selection
          </button>

          {bulkMode === "owner" && (
            <BulkOwnerInput
              busy={bulkBusy}
              onApply={bulkApplyOwner}
              onCancel={() => setBulkMode(null)}
            />
          )}

          {bulkMode === "owed" && (
            <div className="flex w-full flex-wrap items-center gap-2 border-t border-surface-hairline pt-2.5">
              <span className="text-xs text-brand-gray">{OWED_BY_HINT}</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  className="btn-ghost"
                  onClick={() => bulkApplyOwed(null)}
                  disabled={bulkBusy}
                >
                  Untriaged
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => bulkApplyOwed(false)}
                  disabled={bulkBusy}
                >
                  Us
                </button>
                <button
                  className="btn-primary"
                  onClick={() => bulkApplyOwed(true)}
                  disabled={bulkBusy}
                >
                  The client
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => setBulkMode(null)}
                  disabled={bulkBusy}
                >
                  Cancel
                </button>
              </div>
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

      {!scopeReady ? (
        <EmptyState
          title={
            scopeLevel === "portfolio"
              ? "Pick a portfolio to scope"
              : "Pick a client to scope"
          }
          hint={
            scopeLevel === "portfolio"
              ? "Choose a client + portfolio in the header, or widen the scope."
              : "Choose a client in the header, or widen the scope."
          }
          action={
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              {scopeLevel === "portfolio" && currentClient && (
                <button className="btn-ghost" onClick={() => pickScope("client")}>
                  Show {currentClient.name}
                </button>
              )}
              <button className="btn-primary" onClick={() => pickScope("all")}>
                Show all portfolios
              </button>
            </div>
          }
        />
      ) : loading ? (
        <div className="card p-5 text-sm text-brand-gray">Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No actions match this filter"
          hint="Try a different status or owner filter, widen the scope, or add a new item."
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
              Select all visible ({renderedActions.length})
            </span>
          </div>

          {groups
            ? groups.map((g, gi) => {
                const collapsed = collapsedGroups.has(g.key);
                return (
                  <div
                    key={g.key}
                    // The rows' `last:border-b-0` strips the hairline off the
                    // final row of every group, so the separator between two
                    // groups has to live on the header instead.
                    className={clsx(gi > 0 && "border-t border-surface-border")}
                  >
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.key)}
                      aria-expanded={!collapsed}
                      className="flex w-full items-center gap-2.5 border-b border-surface-hairline bg-surface-mute px-4 py-2 text-left transition hover:bg-surface-rowhover md:px-5"
                    >
                      <svg
                        className={clsx(
                          "h-3 w-3 shrink-0 text-brand-lightgray transition-transform",
                          collapsed && "-rotate-90",
                        )}
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        aria-hidden
                      >
                        <path
                          d="M3 4.5 6 7.5 9 4.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-brand-black">
                        {/* The client only earns a mention when more than one
                            can be on screen. */}
                        {scopeLevel === "all" && g.client && (
                          <span className="font-normal text-brand-gray">
                            {g.client} ·{" "}
                          </span>
                        )}
                        {g.portfolio}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-brand-gray">
                        {g.open} open · {g.pending} pending
                      </span>
                    </button>
                    {!collapsed && g.rows.map(renderRow)}
                  </div>
                );
              })
            : filtered.map(renderRow)}
        </div>
      )}

      {/* Move / copy. `sourceProjectId` is the portfolio the selection shares,
          or null when it spans several — a mixed selection has no single
          "already lives here", so the dialog must not claim one. */}
      <MoveActionDialog
        open={!!reassigning}
        count={reassigning?.ids.length ?? 0}
        sourceProjectId={(() => {
          const ids = new Set(reassigning?.ids ?? []);
          const owners = new Set(
            actions.filter((a) => ids.has(a.id)).map((a) => a.project_id),
          );
          return owners.size === 1 ? [...owners][0] : null;
        })()}
        clients={clients}
        onCancel={() => setReassigning(null)}
        onSubmit={handleReassign}
      />
    </div>
  );
}
