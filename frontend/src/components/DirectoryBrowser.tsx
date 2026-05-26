/**
 * "Browse Castillo directory" panel — drop-in component for the Capture
 * page (and anywhere else we want to add coworkers without typing).
 *
 * On first open: acquires a Graph User.ReadBasic.All token, calls /users,
 * caches the result in component state. Subsequent opens reuse the cache
 * unless the user hits the small "↻ refresh" link.
 *
 * Selection: clicking a row toggles it. The Add buttons fire one POST per
 * selected entry against either the portfolio roster or the global roster.
 * After a successful add: the row is hidden (the parent page's roster
 * refresh will surface it as a regular chip) and the modal closes if no
 * rows remain selected.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth/useAuth";
import { listOrgDirectory, type DirectoryUser } from "@/lib/graph";
import { addProjectRoster, addGlobalRoster } from "@/lib/api";
import type { Attendee, GlobalAttendee } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Project id for "Add to portfolio roster" — required for that button. */
  projectId: number | null;
  /** Existing roster names + emails — used to dim already-added entries. */
  existingNames: string[];
  existingEmails: string[];
  /** Fires after at least one person has been added, so the parent can
   *  refetch its roster lists. */
  onAdded: (added: { full_name: string; email: string }[]) => void;
}

export default function DirectoryBrowser({
  open,
  onClose,
  projectId,
  existingNames,
  existingEmails,
  onAdded,
}: Props) {
  const { isAuthenticated, getDirectoryToken } = useAuth();
  const [users, setUsers] = useState<DirectoryUser[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  // Default: only show real active employees with M365 licenses (i.e. Teams).
  // Toggle off to see every entry in the tenant — useful when looking for
  // resource accounts or sanity-checking the filter.
  const [activeOnly, setActiveOnly] = useState(true);

  // ---- Fetch (on first open + when the filter toggle flips) ----
  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getDirectoryToken();
      const list = await listOrgDirectory(token, { activeOnly });
      list.sort((a, b) =>
        (a.displayName || "").localeCompare(b.displayName || ""),
      );
      setUsers(list);
    } catch (e: any) {
      const msg = e?.message || "Failed to load directory";
      if (/insufficient privileges|admin consent|AADSTS65001|AADSTS650056/i.test(msg)) {
        setError(
          "Reading the full Castillo directory requires admin consent for " +
            "the User.Read.All permission. Ask your M365 admin to grant " +
            "consent on the 'PMO 360 (Dev)' app registration (Azure Portal → " +
            "App registrations → PMO 360 (Dev) → API permissions → 'Grant " +
            "admin consent for Castillo Engineering').",
        );
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [getDirectoryToken, activeOnly]);

  useEffect(() => {
    if (open && users === null && isAuthenticated) {
      void fetchUsers();
    }
    if (!open) {
      // Clear selection on close so the next open starts fresh.
      setSelected(new Set());
    }
  }, [open, users, isAuthenticated, fetchUsers]);

  // Re-fetch whenever the activeOnly toggle changes (and we're open).
  useEffect(() => {
    if (open && isAuthenticated) {
      setUsers(null); // invalidate cache so the loading state shows
      void fetchUsers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOnly]);

  // ---- Filtering ----
  const lowerExistingNames = useMemo(
    () => new Set(existingNames.map((n) => n.toLowerCase().trim())),
    [existingNames],
  );
  const lowerExistingEmails = useMemo(
    () => new Set(existingEmails.map((e) => e.toLowerCase().trim())),
    [existingEmails],
  );
  const filtered = useMemo(() => {
    if (!users) return [];
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const hay = `${u.displayName} ${u.userPrincipalName} ${u.mail || ""} ${u.jobTitle || ""} ${u.department || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [users, query]);

  function isAlreadyOnRoster(u: DirectoryUser): boolean {
    const email = (u.mail || u.userPrincipalName || "").toLowerCase().trim();
    return (
      lowerExistingNames.has(u.displayName.toLowerCase().trim()) ||
      (!!email && lowerExistingEmails.has(email))
    );
  }

  // ---- Selection ----
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function initialsFor(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function toAttendeePayload(u: DirectoryUser) {
    return {
      full_name: u.displayName,
      initials: initialsFor(u.displayName),
      organization: "Castillo Engineering",
      email: u.mail || u.userPrincipalName || "",
    };
  }

  // ---- Add buttons ----
  async function handleAdd(target: "portfolio" | "global") {
    if (!users || selected.size === 0) return;
    if (target === "portfolio" && !projectId) {
      setError("Pick a portfolio first.");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const payloads = users
        .filter((u) => selected.has(u.id))
        .map(toAttendeePayload);
      const results = await Promise.allSettled(
        payloads.map((p) =>
          target === "portfolio"
            ? addProjectRoster(projectId!, p) as Promise<Attendee | GlobalAttendee>
            : addGlobalRoster(p) as Promise<Attendee | GlobalAttendee>,
        ),
      );
      const succeeded = payloads.filter((_, i) => results[i].status === "fulfilled");
      if (succeeded.length) {
        onAdded(
          succeeded.map((p) => ({ full_name: p.full_name, email: p.email || "" })),
        );
      }
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed) {
        setError(`${failed} of ${results.length} adds failed.`);
      }
      // Drop added rows from selection and close if everything went.
      setSelected(new Set());
      if (!failed) onClose();
    } catch (e: any) {
      setError(e?.message || "Add failed");
    } finally {
      setAdding(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl card p-5 space-y-3 shadow-xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between">
          <h3 className="section-title">🏢 Browse Castillo directory</h3>
          <button
            type="button"
            className="text-xs text-slate-400 hover:text-slate-600"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {!isAuthenticated && (
          <div className="card p-3 text-sm border-l-4 border-l-brand-gold">
            Sign in to browse the Castillo directory.
          </div>
        )}

        {isAuthenticated && (
          <>
            <div className="flex items-center gap-2">
              <input
                className="input flex-1"
                placeholder="Filter by name, email, title…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="text-xs text-slate-500 hover:text-brand-red"
                onClick={() => {
                  setUsers(null);
                  void fetchUsers();
                }}
                disabled={loading}
                title="Refresh from Microsoft Graph"
              >
                ↻ Refresh
              </button>
            </div>

            <label
              className="flex items-center gap-2 text-xs text-slate-600 select-none"
              title="Hide disabled accounts, guests, shared mailboxes, and unlicensed entries"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand-red"
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
              />
              Only active employees with M365 / Teams license
            </label>

            {error && (
              <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto -mx-1 px-1 border border-slate-200 rounded-lg">
              {loading && (
                <div className="text-sm text-slate-500 p-4">Loading directory…</div>
              )}
              {!loading && filtered.length === 0 && users !== null && (
                <div className="text-sm text-slate-500 p-4">
                  {query
                    ? "No matches. Try a different search."
                    : "Directory is empty."}
                </div>
              )}
              <ul>
                {filtered.map((u) => {
                  const already = isAlreadyOnRoster(u);
                  const isSelected = selected.has(u.id);
                  const email = u.mail || u.userPrincipalName;
                  return (
                    <li
                      key={u.id}
                      className={
                        "flex items-center gap-3 px-3 py-2 border-b border-slate-100 last:border-0 cursor-pointer transition " +
                        (already
                          ? "opacity-50 cursor-not-allowed"
                          : isSelected
                            ? "bg-brand-red/5"
                            : "hover:bg-slate-50")
                      }
                      onClick={() => !already && toggle(u.id)}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        disabled={already}
                        className="h-4 w-4 accent-brand-red"
                      />
                      <div className="h-8 w-8 rounded-full bg-brand-red text-white flex items-center justify-center text-xs font-semibold shrink-0">
                        {initialsFor(u.displayName)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">
                          {u.displayName}
                          {already && (
                            <span className="ml-2 text-xs text-slate-400">
                              · already on roster
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          {email}
                          {u.jobTitle ? ` · ${u.jobTitle}` : ""}
                          {u.department ? ` · ${u.department}` : ""}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="flex items-center justify-between pt-2 gap-2 flex-wrap">
              <div className="text-xs text-slate-500">
                {selected.size > 0
                  ? `${selected.size} selected`
                  : "Click rows to select"}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => handleAdd("global")}
                  disabled={selected.size === 0 || adding}
                  title="Add to the company-wide roster (visible on every portfolio)"
                >
                  + Add to company roster
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handleAdd("portfolio")}
                  disabled={selected.size === 0 || adding || !projectId}
                  title={
                    projectId
                      ? "Add to this portfolio's roster"
                      : "Pick a portfolio first"
                  }
                >
                  {adding ? "Adding…" : `+ Add to portfolio (${selected.size})`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
