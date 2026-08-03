/**
 * Users — the people half of the admin console on Settings.
 *
 * Lists every PMO 360 user with role, active state, last seen and portfolio
 * memberships, and lets an admin grant/revoke admin, offboard/reinstate, and
 * move people on and off portfolios.
 *
 * Two things this component deliberately does NOT do:
 *
 *  1. Enforce anything. It renders for admins only, but that is presentation.
 *     Every call below lands on an admin-gated endpoint, so a hand-rolled
 *     request from a non-admin is refused whatever the SPA shows.
 *  2. Re-derive the refusals. The server owns the role rules — an
 *     ADMIN_EMAILS floor admin can't be touched, neither can the last
 *     remaining admin, and nobody can act on themselves. We fire the request
 *     and print the server's own sentence, because a second copy of those
 *     rules here would drift out of step with the real one.
 *
 *     The single exception is `is_env_admin`, which the server itself sends
 *     down per row: those two buttons are disabled, because that refusal is
 *     permanent until someone edits an env var and redeploys, and walking an
 *     admin through a confirm dialog to reach a guaranteed 409 is worse than
 *     telling them up front. It is still the server that enforces it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { format, parseISO } from "date-fns";
import AdminSection, { Avatar, RowMessage } from "./AdminSection";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  addProjectMember,
  listAdminUsers,
  listAllPortfolios,
  removeProjectMember,
  updateAdminUser,
} from "@/lib/api";
import type { AdminUser, AdminUserPortfolio, Project } from "@/lib/types";

export default function AdminUsersCard() {
  const { clients, me } = useApp();
  const confirm = useConfirm();

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [portfolios, setPortfolios] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Row currently mid-request — disables that user's controls only, so one
   *  slow call doesn't freeze the whole table. */
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  const refresh = useCallback(async () => {
    try {
      setUsers(await listAdminUsers());
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

  /** Run a mutation for one user, then re-read the list so the row reflects
   *  what the server actually did rather than what we hoped it would. */
  async function run(userId: number, fn: () => Promise<unknown>) {
    setBusyId(userId);
    setRowErrors((e) => {
      const { [userId]: _drop, ...rest } = e;
      return rest;
    });
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setRowErrors((prev) => ({
        ...prev,
        [userId]: e?.message || "The server rejected that change.",
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleAdmin(u: AdminUser) {
    const who = displayName(u);
    if (u.is_admin) {
      const ok = await confirm({
        title: "Remove admin access?",
        body: `${who} will lose access to user and client management. They keep their portfolios and their history.`,
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
      title="Users"
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
        <div className="overflow-x-auto">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-brand-gray font-semibold">
                <Th edge>User &amp; portfolios</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>Last seen</Th>
                <Th edge>
                  <span className="sr-only">Actions</span>
                </Th>
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
                return (
                  <tr
                    key={u.id}
                    className={clsx(
                      "border-t border-surface-page align-top",
                      u.is_active
                        ? "hover:bg-surface-rowhover transition"
                        : // Deactivated rows recede: dimmed, on the muted
                          // surface, and carrying a dashed avatar + an
                          // explicit "Deactivated" pill so the state reads
                          // without relying on colour.
                          "bg-surface-mute/50 opacity-75",
                    )}
                  >
                    <Td edge>
                      <div className="flex items-start gap-2.5">
                        <Avatar
                          name={displayName(u)}
                          muted={!u.is_active}
                        />
                        <div className="min-w-0">
                          <div className="font-semibold text-brand-black">
                            {displayName(u)}
                            {isSelf && (
                              <span className="ml-1.5 align-middle text-[10px] font-semibold uppercase tracking-wider text-brand-lightgray">
                                you
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-brand-gray truncate">
                            {u.email || "no email on file"}
                          </div>

                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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

                          {error && (
                            <div className="mt-2 max-w-[30rem]">
                              <RowMessage>{error}</RowMessage>
                            </div>
                          )}
                        </div>
                      </div>
                    </Td>

                    <Td>
                      {/* Same red-outline "admin" badge the Lead dashboard
                          uses, so the role reads identically in both places. */}
                      {u.is_admin ? (
                        <span className="pill border-brand-red text-brand-red">
                          Admin
                        </span>
                      ) : (
                        <span className="text-brand-gray">PM</span>
                      )}
                      {u.is_env_admin && (
                        <div
                          className="mt-1 text-[10px] uppercase tracking-wider text-brand-lightgray"
                          title="Listed in ADMIN_EMAILS — admin here is permanent until that env var changes"
                        >
                          env floor
                        </div>
                      )}
                    </Td>

                    <Td>
                      {u.is_active ? (
                        <span className="pill-completed">Active</span>
                      ) : (
                        <span className="pill-cancelled">Deactivated</span>
                      )}
                    </Td>

                    <Td className="text-brand-gray whitespace-nowrap">
                      {formatDay(u.last_seen_at)}
                    </Td>

                    <Td edge>
                      <div className="flex flex-col items-stretch gap-1.5">
                        <RowButton
                          onClick={() => void toggleAdmin(u)}
                          disabled={busy || (envLocked && u.is_admin)}
                          title={ENV_LOCK_HINT(envLocked && u.is_admin)}
                        >
                          {u.is_admin ? "Remove admin" : "Make admin"}
                        </RowButton>
                        <RowButton
                          onClick={() => void toggleActive(u)}
                          disabled={busy || (envLocked && u.is_active)}
                          danger={u.is_active}
                          title={ENV_LOCK_HINT(envLocked && u.is_active)}
                        >
                          {u.is_active ? "Deactivate" : "Reactivate"}
                        </RowButton>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-t border-surface-hairline px-5 py-3 text-xs text-brand-lightgray">
        Deactivating locks a person out on their next request but keeps
        everything they authored. Users appear here after their first sign-in.
      </p>
    </AdminSection>
  );
}

function displayName(u: AdminUser): string {
  return u.name || u.email || `User #${u.id}`;
}

/** Tooltip for the two buttons an ADMIN_EMAILS floor admin can't be the
 *  target of. Points at the same fix the server's own 409 does. */
const ENV_LOCK_HINT = (locked: boolean): string | undefined =>
  locked
    ? "Listed in the ADMIN_EMAILS environment variable — the permanent admin floor. Remove them there and redeploy first."
    : undefined;

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
        "whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed",
        danger
          ? "border-surface-ghost bg-surface-card text-brand-gray hover:border-brand-brightred hover:text-brand-brightred"
          : "border-surface-ghost bg-surface-card text-brand-gray hover:border-brand-red hover:text-brand-red",
      )}
    >
      {children}
    </button>
  );
}

/* Cells follow the LeadDashboard rhythm: `edge` columns take the card's 20px
   gutter, inner ones sit tighter. */
function Th({
  children,
  edge,
}: {
  children?: React.ReactNode;
  edge?: boolean;
}) {
  return (
    <th className={clsx("py-2.5 font-semibold", edge ? "px-5" : "px-3")}>
      {children}
    </th>
  );
}

function Td({
  children,
  edge,
  className,
}: {
  children?: React.ReactNode;
  edge?: boolean;
  className?: string;
}) {
  return (
    <td className={clsx("py-3", edge ? "px-5" : "px-3", className)}>
      {children}
    </td>
  );
}
