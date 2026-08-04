/**
 * User Management — the people half of the admin console on Settings.
 *
 * ONE LINE PER PERSON. Identity (avatar + name + email) in a single cell, then
 * the eight permission checkboxes, then a portfolio count, then a disclosure
 * for the rare heavy edits. Eight people fit on a laptop screen without
 * scrolling in either direction, which is the point of a permission matrix:
 * you are comparing rows, and you cannot compare what you cannot see at once.
 *
 * Three things this component deliberately does NOT do:
 *
 *  1. Enforce anything. It renders for console operators only, but that is
 *     presentation. Every call below lands on a permission-gated endpoint, so
 *     a hand-rolled request is refused whatever the SPA shows. Where a box or
 *     a button is disabled here it is a courtesy — the boundary is the server.
 *  2. Re-derive the refusals. The server owns the rules — an ADMIN_EMAILS
 *     floor admin can't be touched, neither can the last remaining admin,
 *     nobody can act on themselves, and only an admin can edit an admin. We
 *     fire the request and print the server's own sentence, because a second
 *     copy of those rules here would drift out of step with the real one.
 *
 *     The exceptions are the conditions the server itself sends down per row
 *     (`is_env_admin`, `is_admin`) and the one we know about ourselves (am I an
 *     admin?). Those refusals are permanent for this operator, and walking
 *     someone through a confirm dialog to reach a guaranteed 403 is worse than
 *     telling them up front.
 *  3. Fold in the admin bypass. `permissions` arrives EFFECTIVE, so an admin's
 *     row is already all-true. Recomputing that here would be a second copy of
 *     an authorization rule.
 *
 * WIDTH — the reason the layout is what it is. Settings renders at max-w-doc
 * (1240px, see Layout.tsx::DOC_WIDTH_PATHS) less the shell's px-9 gutters
 * (72px) and the card's 1px borders, which leaves 1166px of table. The budget
 * in the colgroup below fixes every column except the identity cell at 580px
 * total, so the identity cell takes the remaining 586px and all eight
 * permissions fit at their natural 3.5rem with no horizontal scroll and no
 * abbreviated headers.
 *
 * Those numbers have moved once already — this route was max-w-narrow (860px,
 * 786px of table) until the grid outgrew it — so treat max-w-doc as the input
 * and re-derive rather than trusting the pixel figures if the route changes
 * again. The fixed 580px is the part that is really load-bearing: it is
 * 2rem + 8 x 3.5rem + 3.5rem + 2.75rem and comes straight from the colgroup.
 *
 * The fit is also what removed the old First name / Last name pair and the
 * Title / Department columns: two names that were one name, and two fields
 * edited about once a year, were costing 30rem of the very budget the Access
 * band needed. Both survive — the name as the identity cell, title and
 * department inside the row's disclosure.
 *
 * Saving is per control, immediately, with no Save button. A checkbox carries
 * exactly one bit of intent, and a Save button over eight boxes × N people
 * invites exactly the "did that take?" doubt it is meant to remove. So: the
 * box does not move until the server says it moved (no optimistic tick), the
 * row shows "Saved" for a moment afterwards, and a refusal replaces that with
 * the server's own sentence. Text fields can't save per keystroke, so they
 * commit on blur or Enter and revert on Escape.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { format, parseISO } from "date-fns";
import AdminSection, { Avatar, RowMessage } from "./AdminSection";
import {
  AccessCells,
  AccessCols,
  AccessGroupHead,
  AccessHeadCells,
  FALLBACK_PERMISSION_DEFS,
} from "./PermissionGrid";
import AddPersonDialog from "./AddPersonDialog";
import PortfolioAssignPanel from "./PortfolioAssignPanel";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  bulkPermissionRefusals,
  bulkUpdatePermissions,
  listAdminUsers,
  updateAdminUser,
} from "@/lib/api";
import type {
  AdminUser,
  PermissionDef,
  PermissionName,
  UserPermissionsPatch,
} from "@/lib/types";

/** How long the per-row "Saved" acknowledgement stays up. Long enough to
 *  notice after a click, short enough not to pile up while ticking a row. */
const SAVED_MS = 2400;

/** What a finished bulk action left behind. Kept after the selection clears so
 *  the tick marks vanishing is explained rather than merely observed — and so
 *  `ids` can put the same group back for a second grant. */
type BulkOutcome = { text: string; ids: number[] };

export default function AdminUsersCard() {
  const { me } = useApp();
  const confirm = useConfirm();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [permissionDefs, setPermissionDefs] = useState<PermissionDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Row currently mid-request for a whole-row change (admin / active) —
   *  disables that user's controls only, so one slow call doesn't freeze the
   *  whole table. */
  const [busyId, setBusyId] = useState<number | null>(null);
  /** `${userId}:${field}` for the field-level saves, so ticking one box
   *  doesn't grey out the other seven. */
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [savedIds, setSavedIds] = useState<Record<number, true>>({});

  /** Ticked rows, by user id. Deliberately untouched by any save path: a
   *  refresh after toggling one person's box must not throw away the group you
   *  spent six clicks assembling. Stale ids are harmless — every read of this
   *  goes through `selectedUsers`, which intersects it with the live list. */
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** Which row has its title/department/account disclosure open. One at a
   *  time: the whole point of the rebuild is that the list stays short. */
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [bulkPerm, setBulkPerm] = useState<PermissionName | "">("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkOutcome, setBulkOutcome] = useState<BulkOutcome | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  /** Whose portfolios the assign panel is editing — a snapshot, not a live
   *  read of `selected`, so clearing the selection underneath it can't change
   *  who the open panel is about. `null` means closed. */
  const [assignFor, setAssignFor] = useState<number[] | null>(null);

  // Timers for the "Saved" flags. Held in a ref so unmounting mid-save can't
  // set state on a dead component.
  const savedTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  useEffect(
    () => () => {
      for (const t of Object.values(savedTimers.current)) clearTimeout(t);
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const grid = await listAdminUsers();
      setUsers(grid.users ?? []);
      // An older backend that still answers with a bare array would leave this
      // empty; the fallback list keeps the grid renderable either way.
      setPermissionDefs(grid.permissions ?? []);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message || "Could not load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const defs = permissionDefs.length ? permissionDefs : FALLBACK_PERMISSION_DEFS;

  // Default the bulk picker once the real column list lands, so the bar opens
  // ready to act instead of on a "choose one" placeholder.
  useEffect(() => {
    if (!bulkPerm && defs.length) setBulkPerm(defs[0].name);
  }, [defs, bulkPerm]);

  /** Am I a full admin, or a `user_mgmt` holder running the console? The
   *  server enforces the difference; this only decides what to grey out. */
  const iAmAdmin = !!me?.is_admin;

  /** A `user_mgmt` holder who isn't an admin may not touch an admin at all —
   *  the server 403s the whole PATCH, so the row is not offerable in bulk
   *  either. The only refusal we pre-empt, because it is the only one that is
   *  permanent for this operator regardless of what they click. */
  const outranksMe = useCallback(
    (u: AdminUser) => u.is_admin && !iAmAdmin,
    [iAmAdmin],
  );

  const selectableUsers = useMemo(
    () => users.filter((u) => !outranksMe(u)),
    [users, outranksMe],
  );
  const selectedUsers = useMemo(
    () => selectableUsers.filter((u) => selected.has(u.id)),
    [selectableUsers, selected],
  );
  /**
   * Selected rows the permission batch is going to refuse.
   *
   * `POST /admin/users/bulk` is ALL-OR-NOTHING (see lib/api.ts): one
   * untouchable person and nothing is written. These three conditions are the
   * ones the server hands us per row — `is_admin`, `is_env_admin`, and the id
   * we know is ours — so they are deterministic here rather than re-derived,
   * and naming them up front beats walking an admin to a guaranteed 409 whose
   * only content is a list of rows they can see. Everything else stays the
   * server's to refuse; the 409 handler marks whatever we didn't predict.
   */
  const bulkBlocked = useMemo(
    () =>
      selectedUsers.filter(
        (u) => u.is_admin || u.is_env_admin || me?.id === u.id,
      ),
    [selectedUsers, me?.id],
  );
  const allSelected =
    selectableUsers.length > 0 && selectedUsers.length === selectableUsers.length;

  function toggleSelected(userId: number, next: boolean) {
    // Touching the selection starts a new intent, so the previous action's
    // receipt stops being the thing on screen.
    setBulkOutcome(null);
    setSelected((prev) => {
      const s = new Set(prev);
      if (next) s.add(userId);
      else s.delete(userId);
      return s;
    });
  }

  function clearSelection() {
    setSelected(new Set());
    setBulkError(null);
    setBulkOutcome(null);
  }

  function clearRowError(userId: number) {
    setRowErrors((e) => {
      const { [userId]: _drop, ...rest } = e;
      return rest;
    });
  }

  function markSaved(userId: number) {
    clearTimeout(savedTimers.current[userId]);
    setSavedIds((s) => ({ ...s, [userId]: true }));
    savedTimers.current[userId] = setTimeout(() => {
      setSavedIds((s) => {
        const { [userId]: _drop, ...rest } = s;
        return rest;
      });
    }, SAVED_MS);
  }

  function noteError(userId: number, e: any) {
    setSavedIds((s) => {
      const { [userId]: _drop, ...rest } = s;
      return rest;
    });
    setRowErrors((prev) => ({
      ...prev,
      [userId]: e?.message || "The server rejected that change.",
    }));
  }

  /** Run a whole-row mutation, then re-read the list. Used where a change can
   *  move the goalposts for *other* rows too — granting admin changes who the
   *  last admin is, and membership changes come back from another endpoint. */
  async function run(userId: number, fn: () => Promise<unknown>) {
    setBusyId(userId);
    clearRowError(userId);
    try {
      await fn();
      await refresh();
      markSaved(userId);
    } catch (e: any) {
      noteError(userId, e);
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Save one field of one row and splice the server's answer back in.
   *
   * Only the fields we sent are taken from the response, never the whole row:
   * two boxes toggled a second apart each come back with a snapshot, and
   * replacing the row wholesale would let the slower reply undo the faster
   * one. Merging the sent field can't do that.
   */
  async function patchField<K extends keyof AdminUser>(
    userId: number,
    field: string,
    payload: Parameters<typeof updateAdminUser>[1],
    merge: (row: AdminUser, saved: AdminUser) => Pick<AdminUser, K>,
  ) {
    const key = `${userId}:${field}`;
    setPending((p) => new Set(p).add(key));
    clearRowError(userId);
    try {
      const saved = await updateAdminUser(userId, payload);
      setUsers((list) =>
        list.map((u) => (u.id === userId ? { ...u, ...merge(u, saved) } : u)),
      );
      markSaved(userId);
    } catch (e: any) {
      noteError(userId, e);
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(key);
        return next;
      });
    }
  }

  function togglePermission(u: AdminUser, name: PermissionName, next: boolean) {
    const patch: UserPermissionsPatch = { [name]: next };
    void patchField(u.id, name, { permissions: patch }, (row, saved) => ({
      // The whole map comes back effective; take only the box that moved.
      permissions: { ...row.permissions, [name]: !!saved.permissions?.[name] },
    }));
  }

  function saveTitle(u: AdminUser, value: string) {
    void patchField(u.id, "title", { title: value }, (_row, saved) => ({
      title: saved.title,
    }));
  }

  function saveDepartment(u: AdminUser, value: string) {
    void patchField(u.id, "department", { department: value }, (_row, saved) => ({
      department: saved.department,
    }));
  }

  async function toggleAdmin(u: AdminUser) {
    const who = displayName(u);
    if (u.is_admin) {
      const ok = await confirm({
        title: "Remove admin access?",
        body: `${who} stops holding every permission automatically — their individual Access boxes take over, so check them after the change. They keep their portfolios and their history.`,
        confirmLabel: "Remove admin",
        destructive: true,
      });
      if (!ok) return;
    }
    await run(u.id, () => updateAdminUser(u.id, { is_admin: !u.is_admin }));
  }

  async function toggleActive(u: AdminUser) {
    const who = displayName(u);
    if (u.is_active) {
      const ok = await confirm({
        title: "Deactivate this user?",
        body: `${who} will be signed out of PMO 360 and refused on their next request. Nothing they authored is deleted — meetings, actions and documents stay exactly as they are, and you can reactivate them here at any time.`,
        confirmLabel: "Deactivate",
        destructive: true,
      });
      if (!ok) return;
    }
    await run(u.id, () => updateAdminUser(u.id, { is_active: !u.is_active }));
  }

  /**
   * Grant or revoke one permission across the whole selection.
   *
   * Splices the response rather than refetching: the route only ever writes
   * permissions, and it refuses admins outright, so nothing it can do changes
   * a row we didn't send — unlike `is_admin`, which moves the last-admin
   * goalposts for everyone and stays per-row for that reason.
   */
  async function applyBulkPermission(next: boolean) {
    const ids = selectedUsers.map((u) => u.id);
    const def = defs.find((d) => d.name === bulkPerm);
    if (!ids.length || !def) return;
    setBulkBusy(true);
    setBulkError(null);
    setBulkOutcome(null);
    setRowErrors({});
    try {
      const patch: UserPermissionsPatch = { [def.name]: next };
      const updated = await bulkUpdatePermissions(ids, patch);
      const byId = new Map(updated.map((row) => [row.id, row]));
      setUsers((list) => list.map((u) => byId.get(u.id) ?? u));
      for (const id of ids) markSaved(id);
      // Clearing is the safe direction: leaving rows ticked after they have
      // already been acted on is how the *next* action hits the wrong people.
      // The outcome line below carries the group back if it was wanted twice.
      setSelected(new Set());
      setBulkOutcome({
        text: `${next ? "Granted" : "Revoked"} ${def.label} ${
          next ? "to" : "from"
        } ${peopleCount(ids.length)}.`,
        ids,
      });
    } catch (e: any) {
      // Selection survives a refusal — you fix the cause and press it again.
      // A 409 names every blocked person, so mark their rows instead of making
      // the admin match names out of one long sentence.
      const refusals = bulkPermissionRefusals(e);
      if (refusals.length) {
        setRowErrors(
          Object.fromEntries(refusals.map((r) => [r.user_id, r.reason])),
        );
      }
      setBulkError(e?.message || "The server rejected that change.");
    } finally {
      setBulkBusy(false);
    }
  }

  const openAssign = useCallback((ids: number[]) => {
    setBulkError(null);
    setBulkOutcome(null);
    setAssignFor(ids);
  }, []);

  const totalCols = 2 + defs.length + 2;

  return (
    <AdminSection
      title="User Management"
      hint={loading ? "loading…" : peopleCount(users.length)}
      actions={
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-md border border-surface-ghost bg-surface-card px-2.5 py-1 text-[12px] font-semibold text-brand-gray transition hover:border-brand-red hover:text-brand-red"
          title="Set up a Castillo colleague before their first sign-in — permissions and portfolios can be ready on day one."
        >
          + Add person
        </button>
      }
    >
      {loadError ? (
        <p className="px-5 py-4 text-sm text-status-open-text">{loadError}</p>
      ) : loading ? (
        <p className="px-5 py-4 text-sm text-brand-gray">Loading users…</p>
      ) : users.length === 0 ? (
        <p className="px-5 py-4 text-sm text-brand-gray">
          Nobody is in the directory yet. A row appears the first time someone
          signs in — or use <strong>Add person</strong> to set a colleague up
          before that.
        </p>
      ) : (
        <>
          {/* The bulk bar sits ABOVE the table, in the flow, never floating.
              A docked bar is the usual answer, and it is the wrong one here:
              the whole roster now fits on one screen, so a bar pinned to the
              bottom of the viewport would cover the very rows it acts on, and
              one pinned to the top would cover them on the way past. Static
              also puts it beside the select-all box it belongs to. */}
          {(selectedUsers.length > 0 || bulkOutcome) && (
            <div className="border-b border-surface-hairline bg-surface-mute px-5 py-2.5">
              {selectedUsers.length > 0 ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-[13px] font-semibold text-brand-black">
                    {peopleCount(selectedUsers.length)} selected
                  </span>
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="text-[12px] text-brand-gray underline underline-offset-2 hover:text-brand-red"
                  >
                    Clear
                  </button>

                  <span className="h-4 w-px bg-surface-border" />

                  <select
                    aria-label="Permission to grant or revoke"
                    value={bulkPerm}
                    disabled={bulkBusy}
                    onChange={(e) =>
                      setBulkPerm(e.target.value as PermissionName)
                    }
                    className="rounded-md border border-surface-border bg-surface-card px-2 py-1 text-[12px] text-brand-black focus:border-brand-red focus:outline-none disabled:opacity-50"
                  >
                    {defs.map((d) => (
                      <option key={d.name} value={d.name}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <BarButton
                    onClick={() => void applyBulkPermission(true)}
                    disabled={bulkBusy || bulkBlocked.length > 0}
                    title={bulkBlocked.length ? BULK_BLOCKED_HINT : undefined}
                  >
                    Grant
                  </BarButton>
                  <BarButton
                    onClick={() => void applyBulkPermission(false)}
                    disabled={bulkBusy || bulkBlocked.length > 0}
                    title={bulkBlocked.length ? BULK_BLOCKED_HINT : undefined}
                    danger
                  >
                    Revoke
                  </BarButton>

                  <span className="h-4 w-px bg-surface-border" />

                  {/* "Edit", not "Add to": the same panel stages removals, and
                      a button that under-promises is how an admin misses that
                      they just unassigned six people. */}
                  <BarButton
                    onClick={() => openAssign(selectedUsers.map((u) => u.id))}
                    disabled={bulkBusy}
                  >
                    Edit portfolios…
                  </BarButton>

                  {bulkBlocked.length > 0 && (
                    <span className="basis-full text-[11px] text-status-pending-text">
                      Grant and Revoke are off: {peopleCount(bulkBlocked.length)}{" "}
                      here {bulkBlocked.length === 1 ? "is" : "are"} an
                      administrator or your own row, and the batch is
                      all-or-nothing — one refusal writes nothing for anybody.
                      Portfolios can still be assigned to them.{" "}
                      <button
                        type="button"
                        onClick={() =>
                          setSelected((prev) => {
                            const s = new Set(prev);
                            for (const u of bulkBlocked) s.delete(u.id);
                            return s;
                          })
                        }
                        className="font-semibold underline underline-offset-2"
                      >
                        Deselect {bulkBlocked.length === 1 ? "them" : `those ${bulkBlocked.length}`}
                      </button>
                    </span>
                  )}
                  {bulkError && (
                    <div className="basis-full">
                      <RowMessage>{bulkError}</RowMessage>
                    </div>
                  )}
                </div>
              ) : (
                bulkOutcome && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                    <span className="font-semibold text-brand-green">
                      ✓ {bulkOutcome.text}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set(bulkOutcome.ids))}
                      className="text-brand-gray underline underline-offset-2 hover:text-brand-red"
                    >
                      Select those {bulkOutcome.ids.length} again
                    </button>
                    <button
                      type="button"
                      onClick={() => setBulkOutcome(null)}
                      className="ml-auto text-brand-lightgray hover:text-brand-red"
                      aria-label="Dismiss"
                    >
                      ✕
                    </button>
                  </div>
                )
              )}
            </div>
          )}

          {/* Nothing scrolls sideways at the width Settings actually renders
              at — see the budget below. The wrapper is the escape hatch for a
              phone, where 1166px of card simply does not exist. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[45rem] table-fixed text-[13px]">
              {/* COLUMN BUDGET. Settings is max-w-doc (1240px) less the
                  shell's px-9 gutters (72px) less the card's 1px borders =
                  1166px of table.

                    select        2rem      32px
                    Access   8 × 3.5rem    448px
                    Portfolios   3.5rem     56px
                    Manage      2.75rem     44px
                                          -----
                    fixed                  580px
                    identity (remainder)   586px   at 1166px of card

                  586px carries a 32px avatar, an 8px gap and 20px of padding,
                  leaving ~526px of text — roughly 80 characters of name at
                  13px, so the title attribute is now a formality rather than
                  the thing keeping long names readable. (It was 206px / ~23
                  characters while this route was max-w-narrow; the route
                  widened when the grid outgrew it.) Every fixed column is
                  sized to its longest HEADER word, not its content, because
                  the header is what wrapped in the version this replaces.
                  `min-w-[45rem]` (720px) is the floor: below it the wrapper
                  scrolls rather than crushing the identity cell to nothing,
                  which is only ever reached on a phone. */}
              <colgroup>
                <col style={{ width: "2rem" }} />
                {/* No width: table-fixed hands this column whatever the eight
                    Access columns and their three neighbours leave over. */}
                <col />
                <AccessCols defs={defs} />
                <col style={{ width: "3.5rem" }} />
                <col style={{ width: "2.75rem" }} />
              </colgroup>

              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-brand-gray font-semibold">
                  <th scope="col" rowSpan={2} className="px-[9px] py-2 align-bottom">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-brand-red align-middle"
                      checked={allSelected}
                      // Partial selection is a third state, and rendering it as
                      // "off" would make the header lie about the group below.
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            selectedUsers.length > 0 && !allSelected;
                      }}
                      disabled={selectableUsers.length === 0}
                      aria-label="Select all people"
                      title="Select everyone you can edit"
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? new Set(selectableUsers.map((u) => u.id))
                            : new Set(),
                        )
                      }
                    />
                  </th>
                  <th scope="col" rowSpan={2} className="pl-3 pr-2 py-2 align-bottom font-semibold">
                    Person
                  </th>
                  <AccessGroupHead defs={defs} />
                  <th
                    scope="col"
                    rowSpan={2}
                    className="px-1 py-2 align-bottom text-center font-semibold"
                    title="How many portfolios this person is assigned to. Assignment is what their Mine filter, dashboard scope and Manage Team roster follow — it does not gate what they may edit. Click a count to change it."
                  >
                    <span className="block whitespace-nowrap normal-case tracking-normal text-[10px]">
                      Portfolios
                    </span>
                  </th>
                  {/* Labelled, not sr-only: a bare chevron is where an admin
                      would never think to look for "deactivate". */}
                  <th
                    scope="col"
                    rowSpan={2}
                    className="px-1 py-2 align-bottom text-center font-semibold"
                    title="Title, department, admin and deactivate — one row at a time."
                  >
                    <span className="block whitespace-nowrap normal-case tracking-normal text-[10px]">
                      Manage
                    </span>
                  </th>
                </tr>
                <tr>
                  <AccessHeadCells defs={defs} />
                </tr>
              </thead>

              <tbody>
                {users.map((u) => {
                  const who = displayName(u);
                  const isSelf = me?.id === u.id;
                  const busy = busyId === u.id;
                  const error = rowErrors[u.id];
                  // Both role buttons are dead ends for an env-floor admin —
                  // the server refuses either until ADMIN_EMAILS changes.
                  const envLocked = u.is_env_admin;
                  const locked = outranksMe(u);
                  const rowLockReason = locked ? OUTRANKED_HINT : undefined;
                  const expanded = expandedId === u.id;
                  const portfolioCount = (u.portfolios ?? []).length;
                  const pendingHere = new Set(
                    defs
                      .map((d) => d.name)
                      .filter((n) => pending.has(`${u.id}:${n}`)),
                  );
                  return (
                    <Fragment key={u.id}>
                      <tr
                        className={clsx(
                          "border-t border-surface-page align-middle",
                          u.is_active
                            ? // Selected rows hold the hover tint rather than
                              // stacking a second background on it: two
                              // competing `bg-` utilities resolve by stylesheet
                              // order, not by class order, so the winner would
                              // be whichever Tailwind happened to emit last.
                              selected.has(u.id)
                              ? "bg-surface-rowhover"
                              : "hover:bg-surface-rowhover transition"
                            : // Deactivated rows recede: dimmed, on the muted
                              // surface, and carrying a dashed avatar plus an
                              // explicit tag so the state reads without colour.
                              "bg-surface-mute/50 opacity-75",
                        )}
                      >
                        <Td className="px-[9px]">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-brand-red align-middle disabled:cursor-not-allowed disabled:opacity-40"
                            checked={selected.has(u.id)}
                            disabled={locked}
                            title={locked ? OUTRANKED_HINT : undefined}
                            aria-label={`Select ${who}`}
                            onChange={(e) =>
                              toggleSelected(u.id, e.target.checked)
                            }
                          />
                        </Td>

                        <Td className="pl-3 pr-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Avatar name={who} muted={!u.is_active} />
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-1">
                                <span
                                  className="min-w-0 truncate font-semibold text-brand-black"
                                  title={who}
                                >
                                  {who}
                                </span>
                                {u.is_admin && (
                                  <Tag
                                    tone="admin"
                                    title={
                                      envLocked
                                        ? "Administrator, and listed in ADMIN_EMAILS — the permanent admin floor."
                                        : "Administrator — implicitly holds every permission, and can edit other admins."
                                    }
                                  >
                                    admin
                                  </Tag>
                                )}
                                {!u.is_active && (
                                  <Tag tone="off" title="Deactivated — refused on their next request. Nothing they authored is deleted.">
                                    off
                                  </Tag>
                                )}
                                {isSelf && <Tag tone="quiet">you</Tag>}
                              </div>
                              {/* Second line doubles as the row's save
                                  acknowledgement: it is the only text that is
                                  guaranteed on screen next to the box that
                                  just moved. Refusals are longer than 150px,
                                  so those get their own row below. */}
                              {savedIds[u.id] ? (
                                <div className="truncate text-[10.5px] font-semibold leading-tight text-brand-green">
                                  ✓ Saved
                                </div>
                              ) : (
                                <div
                                  className="truncate text-[10.5px] leading-tight text-brand-gray"
                                  title={u.email || undefined}
                                >
                                  {u.email || "no email on file"}
                                </div>
                              )}
                            </div>
                          </div>
                        </Td>

                        <AccessCells
                          defs={defs}
                          user={u}
                          pending={pendingHere}
                          disabled={busy || locked}
                          disabledReason={rowLockReason}
                          onToggle={(name, next) =>
                            togglePermission(u, name, next)
                          }
                        />

                        <Td className="px-1 text-center">
                          <button
                            type="button"
                            onClick={() => openAssign([u.id])}
                            disabled={busy}
                            aria-label={`Portfolios for ${who} — ${portfolioCount} assigned. Edit.`}
                            title={`On ${portfolioCount} ${
                              portfolioCount === 1 ? "portfolio" : "portfolios"
                            }. Assignment decides whose Mine filter and dashboard a portfolio shows up on, and who appears on its Manage Team roster — never who may edit it.${
                              u.is_admin
                                ? " An admin's Mine view shows every portfolio regardless; assign them to put them on the roster."
                                : ""
                            } Click to add or remove.`}
                            // No warning state. There is no combination of
                            // count and permissions that means anything about
                            // access — the count is a visibility setting.
                            className="inline-flex min-w-[2.25rem] items-center justify-center rounded-full border border-surface-border bg-surface-card px-2 py-0.5 text-[11px] font-semibold text-brand-black transition hover:border-brand-red hover:text-brand-red disabled:opacity-40"
                          >
                            {portfolioCount}
                          </button>
                        </Td>

                        <Td className="px-1 text-center">
                          {/* One disclosure instead of two permanent buttons.
                              Make admin and Deactivate are rare and heavy; a
                              pair of them in every row was more furniture than
                              the eight permissions it sat beside. One click
                              still reaches them, and the chevron is in every
                              row rather than hidden behind a hover. */}
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedId(expanded ? null : u.id)
                            }
                            aria-expanded={expanded}
                            aria-label={`Manage ${who}`}
                            title={`Title, department, admin and deactivate for ${who}`}
                            className="rounded-md p-1 text-brand-lightgray transition hover:bg-surface-ghost hover:text-brand-red"
                          >
                            <svg
                              viewBox="0 0 20 20"
                              className={clsx(
                                "h-4 w-4 transition-transform",
                                expanded && "rotate-180",
                              )}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              aria-hidden="true"
                            >
                              <path
                                d="M5 8l5 5 5-5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        </Td>
                      </tr>

                      {expanded && (
                        <tr className={clsx(!u.is_active && "opacity-75")}>
                          <td
                            colSpan={totalCols}
                            className="border-t border-surface-hairline bg-surface-mute px-5 py-3"
                          >
                            <div className="space-y-3">
                              <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                                <Field label="Title">
                                  <TextCell
                                    value={u.title}
                                    placeholder="e.g. Project Manager"
                                    ariaLabel={`Job title for ${who}`}
                                    disabled={busy || locked}
                                    disabledReason={rowLockReason}
                                    saving={pending.has(`${u.id}:title`)}
                                    onCommit={(v) => saveTitle(u, v)}
                                  />
                                </Field>
                                <Field label="Department">
                                  <TextCell
                                    value={u.department}
                                    placeholder="e.g. Electrical"
                                    ariaLabel={`Department for ${who}`}
                                    disabled={busy || locked}
                                    disabledReason={rowLockReason}
                                    saving={pending.has(`${u.id}:department`)}
                                    onCommit={(v) => saveDepartment(u, v)}
                                  />
                                </Field>
                                <div className="flex-1" />
                                <div className="flex items-center gap-1.5">
                                  <RowButton
                                    onClick={() => void toggleAdmin(u)}
                                    disabled={
                                      busy || !iAmAdmin || (envLocked && u.is_admin)
                                    }
                                    title={
                                      !iAmAdmin
                                        ? ADMIN_ONLY_HINT
                                        : ENV_LOCK_HINT(envLocked && u.is_admin)
                                    }
                                  >
                                    {u.is_admin ? "Remove admin" : "Make admin"}
                                  </RowButton>
                                  <RowButton
                                    onClick={() => void toggleActive(u)}
                                    disabled={
                                      busy || locked || (envLocked && u.is_active)
                                    }
                                    danger={u.is_active}
                                    title={
                                      locked
                                        ? OUTRANKED_HINT
                                        : ENV_LOCK_HINT(envLocked && u.is_active)
                                    }
                                  >
                                    {u.is_active ? "Deactivate" : "Reactivate"}
                                  </RowButton>
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-brand-gray">
                                <span>{u.email || "no email on file"}</span>
                                <span className="text-brand-lightgray">·</span>
                                <span>Last seen {formatDay(u.last_seen_at)}</span>
                                {u.is_env_admin && (
                                  <>
                                    <span className="text-brand-lightgray">·</span>
                                    <span title="Listed in ADMIN_EMAILS — admin here is permanent until that env var changes">
                                      env floor admin
                                    </span>
                                  </>
                                )}
                              </div>

                              <div className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className="text-[11px] text-brand-gray"
                                  title="Where this person's Mine filter and dashboard look, and whose Manage Team roster they appear on. Not a limit on what they may edit."
                                >
                                  Portfolios:
                                </span>
                                {portfolioCount === 0 ? (
                                  <span className="text-[11px] text-brand-lightgray">
                                    none
                                  </span>
                                ) : (
                                  (u.portfolios ?? []).map((m) => (
                                    <span
                                      key={m.member_id}
                                      className="rounded-full border border-surface-border bg-surface-card px-2 py-px text-[11px] text-brand-black"
                                    >
                                      {m.client_name
                                        ? `${m.client_name} · ${m.project_name}`
                                        : m.project_name}
                                    </span>
                                  ))
                                )}
                                <button
                                  type="button"
                                  onClick={() => openAssign([u.id])}
                                  className="rounded-md border border-dashed border-surface-border px-2 py-px text-[11px] text-brand-gray transition hover:border-brand-red hover:text-brand-red"
                                >
                                  Edit portfolios
                                </button>
                              </div>

                              {u.is_admin && (
                                <p className="text-[11px] text-brand-lightgray">
                                  Admin — implicitly holds every permission. The
                                  ticks above come from the role, not from
                                  stored grants.
                                </p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}

                      {/* Refusals get their own full-width row rather than the
                          identity cell: the server's sentences name the rule
                          and the fix, and 150px would truncate both. */}
                      {error && (
                        <tr>
                          <td colSpan={totalCols} className="px-5 pb-2.5 pt-0">
                            <RowMessage>{error}</RowMessage>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="space-y-1 border-t border-surface-hairline px-5 py-3 text-xs text-brand-lightgray">
        <p>
          Access controls <strong>edits</strong> only — everyone can read
          everything the app holds, so unticking a box never hides a screen or a
          nav tab. The two groups say what a box unlocks, not where: a ticked
          box applies <strong>everywhere</strong>.
        </p>
        {/* This paragraph is the console's statement of the access model, so it
            has to track auth/permissions.py::is_portfolio_member — which is
            disabled and returns true for anyone signed in. The console said the
            opposite for one release; an admin who learns the model here and
            staffs portfolios accordingly is the person that misleads. */}
        <p>
          Every permission is <strong>company-wide</strong>. A PM reaches every
          portfolio, so the eight boxes are the whole rule — there is no second,
          per-portfolio half. <strong>Assigning portfolios</strong> decides
          whose <em>Mine</em> filter and dashboard a portfolio appears on, and
          who shows up under Manage Team. It grants and revokes nothing, so
          leaving somebody on no portfolios does not restrict them.
        </p>
        <p>
          CO Creation and CO Approval are separate on purpose: whoever raises a
          change order cannot approve it. Deactivating locks a person out on
          their next request but keeps everything they authored.
        </p>
      </div>

      <AddPersonDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          void refresh();
        }}
      />
      <PortfolioAssignPanel
        open={assignFor !== null}
        userIds={assignFor ?? []}
        onClose={() => setAssignFor(null)}
        onDone={() => {
          void refresh();
          // A bulk staffing pass is finished business; leaving the group ticked
          // is how the next click lands on people you thought you were done
          // with. One person at a time never had a selection to clear.
          if ((assignFor?.length ?? 0) > 1) setSelected(new Set());
        }}
      />
    </AdminSection>
  );
}

function displayName(u: AdminUser): string {
  return u.name || u.email || `User #${u.id}`;
}

/** "1 person" / "7 people" — the bulk bar's count has to be unambiguous, and
 *  a bare number beside a permission name reads as a permission count. */
function peopleCount(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/** Tooltip for the two buttons an ADMIN_EMAILS floor admin can't be the
 *  target of. Points at the same fix the server's own 409 does. */
const ENV_LOCK_HINT = (locked: boolean): string | undefined =>
  locked
    ? "Listed in the ADMIN_EMAILS environment variable — the permanent admin floor. Remove them there and redeploy first."
    : undefined;

/** Shown to a `user_mgmt` holder who is not a full admin. Mirrors the server's
 *  own 403 rather than inventing a different rule. */
const OUTRANKED_HINT =
  "This person is an administrator. Only another administrator can change an admin's access.";

const ADMIN_ONLY_HINT =
  "Only an administrator can grant or revoke admin. You can still edit permissions, title and department.";

/** Why the bulk Grant/Revoke pair is greyed out. Names the fix, not just the
 *  fact, because the fix is one click away in the bar itself. */
const BULK_BLOCKED_HINT =
  "The selection includes an administrator or your own row. The permission batch is all-or-nothing, so it would write nothing for anybody — deselect them and press again.";

/** `last_seen_at` is an ISO timestamp; anything unparseable degrades to a
 *  dash rather than throwing inside the row. */
function formatDay(value?: string | null): string {
  if (!value) return "Never";
  try {
    return format(parseISO(value), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

/** Row-level state marker. Smaller than `.pill`, which is sized for a status
 *  column and would push the name into truncation on every admin's row. */
function Tag({
  tone,
  title,
  children,
}: {
  tone: "admin" | "off" | "quiet";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "shrink-0 rounded border px-1 py-px text-[9px] font-semibold uppercase leading-none tracking-wide",
        tone === "admin" && "border-brand-red text-brand-red",
        tone === "off" && "border-brand-lightgray text-brand-gray",
        tone === "quiet" && "border-surface-border text-brand-lightgray",
      )}
    >
      {children}
    </span>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-brand-gray">
        {label}
      </span>
      <div className="w-[11rem]">{children}</div>
    </label>
  );
}

/**
 * An inline text cell that commits on blur or Enter and reverts on Escape.
 *
 * Keystroke-by-keystroke saving is wrong for a field an admin is retyping —
 * every intermediate string would be persisted, and a mid-word server trim
 * would fight the cursor. Blur is the moment the intent is complete.
 */
function TextCell({
  value,
  placeholder,
  ariaLabel,
  disabled,
  disabledReason,
  saving,
  onCommit,
}: {
  value?: string | null;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  disabledReason?: string;
  saving?: boolean;
  onCommit: (value: string) => void;
}) {
  const committed = value ?? "";
  const [draft, setDraft] = useState(committed);
  // Re-sync when the server's answer lands (it trims), or when another change
  // to this row refreshes the list underneath us.
  useEffect(() => setDraft(committed), [committed]);
  // Set by Escape so the blur it triggers doesn't save the reverted value back.
  const reverting = useRef(false);

  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (reverting.current) {
          reverting.current = false;
          return;
        }
        if (draft.trim() !== committed.trim()) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          reverting.current = true;
          setDraft(committed);
          e.currentTarget.blur();
        }
      }}
      className={clsx(
        "w-full rounded-md border border-surface-border bg-surface-card px-1.5 py-1 text-[12.5px] text-brand-black",
        "placeholder:text-brand-lightgray",
        "focus:outline-none focus:border-brand-red",
        "disabled:cursor-not-allowed disabled:opacity-60",
        saving && "opacity-50",
      )}
    />
  );
}

function RowButton({
  onClick,
  disabled,
  danger,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        "whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed",
        danger
          ? "border-surface-ghost bg-surface-card text-brand-gray hover:border-brand-brightred hover:text-brand-brightred"
          : "border-surface-ghost bg-surface-card text-brand-gray hover:border-brand-red hover:text-brand-red",
      )}
    >
      {children}
    </button>
  );
}

/** Bulk-bar control. Slightly larger than RowButton because these act on a
 *  group and a mis-click costs more than one row. */
function BarButton({
  onClick,
  disabled,
  danger,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        "whitespace-nowrap rounded-md border bg-surface-card px-2.5 py-1 text-[12px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed",
        danger
          ? "border-surface-border text-brand-gray hover:border-brand-brightred hover:text-brand-brightred"
          : "border-surface-border text-brand-black hover:border-brand-red hover:text-brand-red",
      )}
    >
      {children}
    </button>
  );
}

/* Body cells. Padding is passed in per column rather than baked in: the
   identity cell takes the card's gutter, the narrow ones sit tight, and the
   Access band sets its own (see PermissionGrid). */
function Td({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={clsx("py-1.5 align-middle", className)}>{children}</td>;
}
