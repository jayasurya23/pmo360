/**
 * User Management — the people half of the admin console on Settings.
 *
 * One row per person: First name, Last name, Title, Department, then the eight
 * permission checkboxes under a spanning "Access" header, then role/status and
 * the role buttons. A slim second line under each person carries their
 * portfolios, last-seen and any server message.
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
 * Width. Settings renders at max-w-narrow, and a fourteen-column grid does not
 * fit in it. Rather than widen the page or shrink the header into codes, the
 * table declares its own column budget (see the colgroup) and scrolls inside
 * the card — the Settings page itself never scrolls sideways — with the two
 * name columns pinned, so you can never be ticking a box against a row whose
 * owner has scrolled out of sight. The moment the page gets wider the budget
 * simply fits and the scroll disappears.
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
  hasDeadPortfolioGrants,
} from "./PermissionGrid";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  addProjectMember,
  listAdminUsers,
  listAllPortfolios,
  removeProjectMember,
  updateAdminUser,
} from "@/lib/api";
import type {
  AdminUser,
  AdminUserPortfolio,
  PermissionDef,
  PermissionName,
  Project,
  UserPermissionsPatch,
} from "@/lib/types";

/** How long the per-row "Saved" acknowledgement stays up. Long enough to
 *  notice after a click, short enough not to pile up while ticking a row. */
const SAVED_MS = 2400;

export default function AdminUsersCard() {
  const { clients, me } = useApp();
  const confirm = useConfirm();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [permissionDefs, setPermissionDefs] = useState<PermissionDef[]>([]);
  const [portfolios, setPortfolios] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Row currently mid-request for a whole-row change (admin / active /
   *  membership) — disables that user's controls only, so one slow call
   *  doesn't freeze the whole table. */
  const [busyId, setBusyId] = useState<number | null>(null);
  /** `${userId}:${field}` for the field-level saves, so ticking one box
   *  doesn't grey out the other seven. */
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [savedIds, setSavedIds] = useState<Record<number, true>>({});

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
    // Every portfolio across every client — the membership picker has to
    // offer portfolios outside whichever client the header happens to be on.
    listAllPortfolios(false)
      .then(setPortfolios)
      .catch(() => setPortfolios([]));
  }, [refresh]);

  const defs = permissionDefs.length ? permissionDefs : FALLBACK_PERMISSION_DEFS;

  const clientNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of clients) m.set(c.id, c.name);
    return m;
  }, [clients]);

  const portfolioLabel = useCallback(
    (p: Project) => {
      const client = clientNameById.get(p.client_id);
      return client ? `${client} · ${p.name}` : p.name;
    },
    [clientNameById],
  );

  /** Am I a full admin, or a `user_mgmt` holder running the console? The
   *  server enforces the difference; this only decides what to grey out. */
  const iAmAdmin = !!me?.is_admin;

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

  async function addMembership(u: AdminUser, projectId: number) {
    await run(u.id, () => addProjectMember(projectId, { user_id: u.id }));
  }

  async function removeMembership(u: AdminUser, m: AdminUserPortfolio) {
    await run(u.id, () => removeProjectMember(m.member_id));
  }

  return (
    <AdminSection
      title="User Management"
      hint={loading ? "loading…" : `${users.length} in the directory`}
    >
      {loadError ? (
        <p className="px-5 py-4 text-sm text-status-open-text">{loadError}</p>
      ) : loading ? (
        <p className="px-5 py-4 text-sm text-brand-gray">Loading users…</p>
      ) : users.length === 0 ? (
        <p className="px-5 py-4 text-sm text-brand-gray">
          Nobody has signed into PMO 360 yet. A user row appears the first time
          someone signs in.
        </p>
      ) : (
        // The scroll lives here, inside the card, so the Settings page never
        // gains a horizontal scrollbar of its own.
        <div className="overflow-x-auto">
          <table className="w-[72rem] min-w-full table-fixed text-[13px]">
            {/* Column budget — declared, not content-derived, because the two
                name columns are position:sticky and their offsets below have to
                match these widths exactly. Sums to 72rem; `min-w-full` lets the
                table use anything more the card is ever given. */}
            <colgroup>
              <col style={{ width: NAME_W }} />
              <col style={{ width: SURNAME_W }} />
              {/* Title / Department: ~13 characters before truncation, which
                  covers "Project Manager" and "Electrical". */}
              <col style={{ width: "7.5rem" }} />
              <col style={{ width: "7rem" }} />
              <AccessCols defs={defs} />
              {/* Account: floor is the "Deactivated" pill. */}
              <col style={{ width: "6.5rem" }} />
              {/* Actions: floor is the "Remove admin" button. Last column, so
                  anything that outgrows this widens the whole table. */}
              <col style={{ width: "6.5rem" }} />
            </colgroup>

            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-brand-gray font-semibold">
                <th
                  scope="col"
                  rowSpan={2}
                  className="sticky left-0 z-10 bg-surface-card px-5 py-2 align-bottom font-semibold"
                >
                  First name
                </th>
                <th
                  scope="col"
                  rowSpan={2}
                  style={{ left: NAME_W }}
                  className="sticky z-10 bg-surface-card border-r border-surface-hairline px-3 py-2 align-bottom font-semibold"
                >
                  Last name
                </th>
                <th scope="col" rowSpan={2} className="px-3 py-2 align-bottom font-semibold">
                  Title
                </th>
                <th scope="col" rowSpan={2} className="px-3 py-2 align-bottom font-semibold">
                  Dept
                </th>
                <AccessGroupHead defs={defs} />
                <th scope="col" rowSpan={2} className="px-3 py-2 align-bottom font-semibold">
                  Account
                </th>
                <th scope="col" rowSpan={2} className="px-5 py-2 align-bottom font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
              <tr>
                <AccessHeadCells defs={defs} />
              </tr>
            </thead>

            <tbody>
              {users.map((u) => {
                const assignments = u.portfolios ?? [];
                const assigned = new Set(assignments.map((m) => m.project_id));
                const addable = portfolios.filter((p) => !assigned.has(p.id));
                const isSelf = me?.id === u.id;
                const busy = busyId === u.id;
                const error = rowErrors[u.id];
                // Both role buttons are dead ends for an env-floor admin —
                // the server refuses either until ADMIN_EMAILS changes.
                const envLocked = u.is_env_admin;
                // A user_mgmt holder who isn't an admin may not touch an admin
                // at all; the server 403s the whole PATCH.
                const outranksMe = u.is_admin && !iAmAdmin;
                const rowLockReason = outranksMe ? OUTRANKED_HINT : undefined;
                const pendingHere = new Set(
                  defs
                    .map((d) => d.name)
                    .filter((n) => pending.has(`${u.id}:${n}`)),
                );
                // A sticky cell scrolls over its neighbours, so it needs its own
                // opaque fill and its own copy of the row's hover — the <tr>
                // background sits behind it and would show through.
                const stickyBg = u.is_active
                  ? "bg-surface-card group-hover/row:bg-surface-rowhover transition"
                  : // Deactivated rows recede: dimmed, on the muted surface,
                    // and carrying a dashed avatar + an explicit "Deactivated"
                    // pill so the state reads without relying on colour.
                    "bg-surface-mute";
                return (
                  <Fragment key={u.id}>
                    <tr
                      className={clsx(
                        "group/row border-t border-surface-page align-middle",
                        u.is_active
                          ? "hover:bg-surface-rowhover transition"
                          : "bg-surface-mute/50 opacity-75",
                      )}
                    >
                      <Td className={clsx("sticky left-0 z-[1] px-5", stickyBg)}>
                        <div className="flex items-center gap-2">
                          <Avatar name={displayName(u)} muted={!u.is_active} />
                          <span
                            className="min-w-0 truncate font-semibold text-brand-black"
                            title={`${displayName(u)}${u.email ? ` · ${u.email}` : ""}`}
                          >
                            {u.first_name || displayName(u)}
                          </span>
                        </div>
                      </Td>
                      <Td
                        style={{ left: NAME_W }}
                        className={clsx(
                          "sticky z-[1] border-r border-surface-hairline px-3",
                          stickyBg,
                        )}
                      >
                        <div className="truncate font-semibold text-brand-black">
                          {u.last_name || "—"}
                        </div>
                        {isSelf && (
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-brand-lightgray">
                            you
                          </div>
                        )}
                      </Td>

                      <Td className="px-3">
                        <TextCell
                          value={u.title}
                          placeholder="—"
                          ariaLabel={`Job title for ${displayName(u)}`}
                          disabled={busy || outranksMe}
                          disabledReason={rowLockReason}
                          saving={pending.has(`${u.id}:title`)}
                          onCommit={(v) => saveTitle(u, v)}
                        />
                      </Td>
                      <Td className="px-3">
                        <TextCell
                          value={u.department}
                          placeholder="—"
                          ariaLabel={`Department for ${displayName(u)}`}
                          disabled={busy || outranksMe}
                          disabledReason={rowLockReason}
                          saving={pending.has(`${u.id}:department`)}
                          onCommit={(v) => saveDepartment(u, v)}
                        />
                      </Td>

                      <AccessCells
                        defs={defs}
                        user={u}
                        pending={pendingHere}
                        disabled={busy || outranksMe}
                        disabledReason={rowLockReason}
                        onToggle={(name, next) => togglePermission(u, name, next)}
                      />

                      <Td className="px-3">
                        {/* Same red-outline "admin" badge the Lead dashboard
                            uses, so the role reads identically in both places. */}
                        {u.is_admin ? (
                          <span className="pill border-brand-red text-brand-red">
                            Admin
                          </span>
                        ) : (
                          <span className="text-[12px] text-brand-gray">PM</span>
                        )}
                        {u.is_env_admin && (
                          <div
                            className="mt-0.5 text-[10px] uppercase tracking-wider text-brand-lightgray"
                            title="Listed in ADMIN_EMAILS — admin here is permanent until that env var changes"
                          >
                            env floor
                          </div>
                        )}
                        <div className="mt-1">
                          {u.is_active ? (
                            <span className="pill-completed">Active</span>
                          ) : (
                            <span className="pill-cancelled">Deactivated</span>
                          )}
                        </div>
                      </Td>

                      <Td className="px-5">
                        <div className="flex flex-col items-stretch gap-1.5">
                          <RowButton
                            onClick={() => void toggleAdmin(u)}
                            disabled={busy || !iAmAdmin || (envLocked && u.is_admin)}
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
                              busy || outranksMe || (envLocked && u.is_active)
                            }
                            danger={u.is_active}
                            title={
                              outranksMe
                                ? OUTRANKED_HINT
                                : ENV_LOCK_HINT(envLocked && u.is_active)
                            }
                          >
                            {u.is_active ? "Deactivate" : "Reactivate"}
                          </RowButton>
                        </div>
                      </Td>
                    </tr>

                    {/* Detail line. Everything here is either reference (email,
                        last seen) or full-width by nature (portfolio chips, a
                        server message), and none of it wants a 3.5rem column.
                        Pinned to the left edge so it stays readable while the
                        Access band is scrolled. */}
                    <tr
                      className={clsx(
                        !u.is_active && "bg-surface-mute/50 opacity-75",
                      )}
                    >
                      <td colSpan={4 + defs.length + 2} className="px-5 pb-3 pt-0">
                        <div className="sticky left-5 w-max max-w-[44rem] space-y-1.5">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-brand-gray">
                            <span className="truncate">
                              {u.email || "no email on file"}
                            </span>
                            <span className="text-brand-lightgray">·</span>
                            <span>Last seen {formatDay(u.last_seen_at)}</span>
                            {savedIds[u.id] && (
                              <span className="font-semibold text-brand-green">
                                ✓ Saved
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5">
                            {assignments.length === 0 && (
                              <span className="text-[11px] text-brand-lightgray">
                                No portfolios
                              </span>
                            )}
                            {assignments.map((m) => (
                              <span
                                key={m.member_id}
                                className="inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface-card px-2 py-px text-[11px] text-brand-black"
                              >
                                {m.client_name
                                  ? `${m.client_name} · ${m.project_name}`
                                  : m.project_name}
                                <button
                                  type="button"
                                  onClick={() => void removeMembership(u, m)}
                                  disabled={busy}
                                  title={`Remove from ${m.project_name}`}
                                  aria-label={`Remove ${displayName(u)} from ${m.project_name}`}
                                  className="text-brand-lightgray hover:text-brand-brightred disabled:opacity-40"
                                >
                                  ✕
                                </button>
                              </span>
                            ))}
                            {addable.length > 0 && (
                              <select
                                aria-label={`Add ${displayName(u)} to a portfolio`}
                                title={
                                  u.is_active
                                    ? undefined
                                    : "Deactivated users cannot be assigned to a portfolio. Reactivate them first."
                                }
                                value=""
                                // Same rule as the env-locked buttons above:
                                // the server refuses this outright, so offer
                                // the reason rather than a guaranteed 409.
                                disabled={busy || !u.is_active}
                                onChange={(e) => {
                                  const id = Number(e.target.value);
                                  if (id) void addMembership(u, id);
                                  e.target.value = "";
                                }}
                                className="rounded-md border border-dashed border-surface-border bg-surface-card px-2 py-px text-[11px] text-brand-gray hover:border-brand-red hover:text-brand-red focus:outline-none focus:border-brand-red disabled:opacity-40"
                              >
                                <option value="">+ portfolio</option>
                                {addable.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {portfolioLabel(p)}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>

                          {u.is_admin && (
                            <p className="text-[11px] text-brand-lightgray">
                              Admin — holds every permission on every portfolio.
                              The ticks above come from the role, not from
                              stored grants.
                            </p>
                          )}

                          {hasDeadPortfolioGrants(u, defs) && (
                            <p className="text-[11px] text-status-pending-text">
                              On no portfolios, so the portfolio permissions
                              ticked above currently do nothing. Add a portfolio
                              to make them apply.
                            </p>
                          )}

                          {error && <RowMessage>{error}</RowMessage>}
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-1 border-t border-surface-hairline px-5 py-3 text-xs text-brand-lightgray">
        <p>
          Access controls <strong>edits</strong> only — everyone can still read
          what their portfolios already show them, so unticking a box never
          hides a screen. The six portfolio permissions apply only where the
          person is a member; <strong>User Mgmt</strong> and{" "}
          <strong>Client Mgmt</strong> are global.
        </p>
        <p>
          CO Creation and CO Approval are separate on purpose: whoever raises a
          change order cannot approve it. Deactivating locks a person out on
          their next request but keeps everything they authored. Users appear
          here after their first sign-in.
        </p>
      </div>
    </AdminSection>
  );
}

/* Width of the two pinned name columns. Declared once because the colgroup and
   the `left` offsets of the sticky cells must agree — if they drift, the
   surname column slides under the first name instead of beside it. */
const NAME_W = "9.5rem";
const SURNAME_W = "7rem";

function displayName(u: AdminUser): string {
  return u.name || u.email || `User #${u.id}`;
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
        "w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12.5px] text-brand-black",
        "placeholder:text-brand-lightgray hover:border-surface-border",
        "focus:outline-none focus:border-brand-red focus:bg-surface-card",
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

/* Body cells. Padding is passed in per column rather than baked in: the two
   pinned columns take the card's 20px gutter, the inner ones sit tighter, and
   the Access band sets its own (see PermissionGrid). */
function Td({
  children,
  className,
  style,
}: {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td className={clsx("py-2.5 align-middle", className)} style={style}>
      {children}
    </td>
  );
}
