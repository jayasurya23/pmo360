/**
 * Add a Castillo colleague to PMO 360 before their first sign-in.
 *
 * Until now a person only existed here once they had signed in themselves, so
 * a new hire could not be set up in advance and could not be put on a
 * portfolio: `POST /projects/{id}/members` 404s with "they need to sign in
 * once first". This dialog closes that gap — pick them out of the Castillo
 * directory, and their row exists from that moment.
 *
 * ---- WHY IT IS A DIRECTORY PICKER AND NOT AN EMAIL BOX ----
 *
 * The row is keyed on the Entra object id. The sign-in path
 * (auth/dependencies.py::_upsert_user_row) looks a user up by `oid` and
 * nothing else, so a row created under any other key is a ghost: the person
 * signs in, no row matches, a SECOND one is inserted with default grants, and
 * everything the admin set up sits on a row that will never authenticate —
 * with nothing on screen to say so. Only Microsoft holds that id, so only the
 * directory can supply it. A typed email cannot.
 *
 * ---- THE GRAPH CALL ----
 *
 * Same path DirectoryBrowser uses: a delegated User.Read.All token from the
 * signed-in admin, straight from the browser to Graph — there is no backend
 * proxy. That fetch is what can raise a consent prompt, which is why it is
 * never speculative: it only runs once someone has explicitly opened this
 * dialog from the Add-person button.
 *
 * ---- WHAT IT DOES NOT DO ----
 *
 * Provisioning creates a PMO 360 row. It does not create a Microsoft account,
 * it does not assign a licence, and it does not notify anybody. The copy says
 * all three, because "Add" on a screen full of people is otherwise read as
 * "invite".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useAuth } from "@/auth/useAuth";
import { listOrgDirectory, sendMail, type DirectoryUser } from "@/lib/graph";
import { listAdminUsers, provisionUser, ApiError } from "@/lib/api";
import type { AdminUser } from "@/lib/types";

/** Subject + body of the invite. Plain text, because Graph sends text/plain
 *  here and every other mail this app sends is plain too.
 *
 *  It says what the app is, who added them, and what to do — an invite that
 *  only says "you've been added to PMO 360" reads like spam from an internal
 *  tool nobody has heard of. It also sets expectations about permissions:
 *  change-order rights are OFF for new accounts, so somebody invited purely to
 *  approve a change order would otherwise sign in, find nothing they can do,
 *  and assume the link was broken. */
function inviteText(person: AdminUser, invitedBy: string): { subject: string; body: string } {
  const appUrl = window.location.origin;
  const first = (person.name || "").trim().split(/\s+/)[0] || "there";
  return {
    subject: "You've been added to PMO 360",
    body:
      `Hi ${first},\n\n` +
      `${invitedBy} has set you up with an account on PMO 360, Castillo ` +
      `Engineering's project management workspace. It's where we run meeting ` +
      `minutes, agendas, rolling action items, proposals and change orders.\n\n` +
      `Sign in here with your Castillo account — no separate password:\n` +
      `${appUrl}\n\n` +
      `You'll land with access to meetings, agendas, proposals and the ` +
      `timeline. Change-order permissions are granted separately, so if you've ` +
      `been asked to approve a change order and can't yet, reply to this email ` +
      `and we'll switch it on.\n\n` +
      `— ${invitedBy}`,
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fires with the rows that were created, so the grid can refetch. */
  onAdded: (created: AdminUser[]) => void;
}

/** How an existing PMO 360 row relates to a directory entry. */
type Existing = { user: AdminUser; matchedOn: "oid" | "email" };

export default function AddPersonDialog({ open, onClose, onAdded }: Props) {
  const { isAuthenticated, user, getDirectoryToken, getMailSendToken } = useAuth();

  const [directory, setDirectory] = useState<DirectoryUser[] | null>(null);
  const [appUsers, setAppUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  /** Per-person failures from the last submit, keyed by Graph id. Kept
   *  alongside the list rather than collapsed into one banner: with several
   *  people selected, "2 failed" without saying which two is unusable. */
  const [failures, setFailures] = useState<Record<string, string>>({});
  // Same default as DirectoryBrowser: real employees with a licence. Off shows
  // the whole tenant, which is how you find someone whose account is still
  // being set up.
  const [activeOnly, setActiveOnly] = useState(true);
  // Invite on by default: adding someone who is never told is how an account
  // sits unused for a month. Still a toggle, because setting up a team in
  // advance of a launch is a real thing and mailing them all six weeks early
  // is not helpful.
  const [sendInvite, setSendInvite] = useState(true);
  /** Per-person invite outcome from the last submit, keyed by Graph id.
   *  Separate from `failures`: a failed invite is NOT a failed add — the
   *  account exists either way, and conflating them would have the admin
   *  retrying a provisioning that already succeeded. */
  const [inviteResults, setInviteResults] = useState<Record<string, string>>({});
  const [inviting, setInviting] = useState(false);

  const fetchDirectory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getDirectoryToken();
      const list = await listOrgDirectory(token, { activeOnly });
      list.sort((a, b) =>
        (a.displayName || "").localeCompare(b.displayName || ""),
      );
      setDirectory(list);
    } catch (e: any) {
      const msg = e?.message || "Failed to load the Castillo directory";
      // The one failure with a fix the admin can act on themselves, worded the
      // same way DirectoryBrowser words it.
      if (/insufficient privileges|admin consent|AADSTS65001|AADSTS650056/i.test(msg)) {
        setError(
          "Reading the full Castillo directory requires admin consent for the " +
            "User.Read.All permission. Ask your M365 admin to grant consent on " +
            "the PMO 360 app registration (Azure Portal → App registrations → " +
            "PMO 360 → API permissions → Grant admin consent).",
        );
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [getDirectoryToken, activeOnly]);

  // Opening and closing the dialog. Keyed on `open` ALONE, deliberately.
  //
  // This used to also depend on `fetchDirectory` and do the fetch itself. That
  // conflation is what made the search box impossible to type in: any churn in
  // the fetch identity re-ran this effect, and this effect calls setQuery(""),
  // so a keystroke could erase itself. The root cause was an unstable
  // getDirectoryToken (fixed in auth/useAuth.ts), but resetting typed input from
  // an effect that tracks a *function* is fragile whatever the dep does, so the
  // reset and the fetch are now separate concerns.
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setFailures({});
      return;
    }
    setQuery("");
    setError(null);
    // Who is already here, so a name that cannot be added says so in the list
    // instead of on submit. Cheap, and the endpoint is the same one the grid
    // behind this dialog already called.
    listAdminUsers()
      .then((grid) => setAppUsers(grid.users ?? []))
      .catch(() => setAppUsers([]));
  }, [open]);

  // Reading the directory. Re-runs when the dialog opens, when sign-in lands,
  // or when the active-only filter flips — never because someone typed.
  useEffect(() => {
    if (!open || !isAuthenticated) return;
    void fetchDirectory();
  }, [open, isAuthenticated, fetchDirectory]);

  const byOid = useMemo(() => {
    const m = new Map<string, AdminUser>();
    for (const u of appUsers) if (u.oid) m.set(u.oid.toLowerCase(), u);
    return m;
  }, [appUsers]);

  const byEmail = useMemo(() => {
    const m = new Map<string, AdminUser>();
    for (const u of appUsers) {
      const e = (u.email || "").trim().toLowerCase();
      if (e) m.set(e, u);
    }
    return m;
  }, [appUsers]);

  /** The oid match is the real one — it is the key the server refuses a
   *  duplicate on. The email match catches the same human arriving under a
   *  second directory entry, which the server also refuses, and which is worth
   *  surfacing differently because it usually means something is wrong in the
   *  directory rather than in the admin's head. */
  const existingFor = useCallback(
    (u: DirectoryUser): Existing | null => {
      const oidHit = byOid.get(u.id.toLowerCase());
      if (oidHit) return { user: oidHit, matchedOn: "oid" };
      const email = (u.mail || u.userPrincipalName || "").trim().toLowerCase();
      const mailHit = email ? byEmail.get(email) : undefined;
      if (mailHit) return { user: mailHit, matchedOn: "email" };
      return null;
    },
    [byOid, byEmail],
  );

  const filtered = useMemo(() => {
    if (!directory) return [];
    const q = query.trim().toLowerCase();
    if (!q) return directory;
    return directory.filter((u) =>
      `${u.displayName} ${u.userPrincipalName} ${u.mail || ""} ${u.jobTitle || ""} ${u.department || ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [directory, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAdd() {
    if (!directory || selected.size === 0) return;
    const picks = directory.filter((u) => selected.has(u.id));
    setSaving(true);
    setError(null);
    setFailures({});
    const results = await Promise.allSettled(
      picks.map((u) =>
        provisionUser({
          // Graph's `id` IS the Entra object id the sign-in path matches on.
          oid: u.id,
          email: (u.mail || u.userPrincipalName || "").trim(),
          name: u.displayName,
          title: u.jobTitle || undefined,
          department: u.department || undefined,
        }),
      ),
    );

    const created: AdminUser[] = [];
    const failed: Record<string, string> = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") created.push(r.value);
      else {
        const e = r.reason;
        failed[picks[i].id] =
          e instanceof ApiError
            ? e.message
            : e?.message || "Could not add this person.";
      }
    });

    if (created.length) {
      // Fold them into the "already here" maps so their rows flip immediately,
      // even when part of the batch failed and the dialog stays open.
      setAppUsers((prev) => [...prev, ...created]);
      onAdded(created);
    }
    setFailures(failed);
    setSelected(new Set(Object.keys(failed)));
    setSaving(false);

    // ---- Invites, AFTER provisioning and deliberately decoupled from it ----
    //
    // The accounts already exist and the grid has already been told. Mail is
    // best-effort on top: Graph can fail, the admin can dismiss the Mail.Send
    // consent popup, or a mailbox can bounce, and none of that should undo or
    // cast doubt on a provisioning that succeeded. So a send failure is
    // REPORTED, per person, and never rolled into `failures`.
    //
    // It also must not silently no-op. "I ticked invite and nobody got one" is
    // the failure mode worth engineering against, which is why the dialog stays
    // open and names whoever was not reached instead of closing on success.
    let inviteFailed = false;
    if (sendInvite && created.length) {
      setInviting(true);
      const invitedBy = user?.name || user?.email || "A PMO 360 admin";
      const results: Record<string, string> = {};
      let token: string | null = null;
      try {
        token = await getMailSendToken();
      } catch (e: any) {
        // One failure for the whole batch — no point asking N times.
        inviteFailed = true;
        setError(
          /consent|AADSTS/i.test(e?.message || "")
            ? "The accounts were created, but Microsoft didn't approve sending " +
              "mail on this sign-in, so no invites went out. Reopen this dialog " +
              "to retry, or email them yourself."
            : `The accounts were created, but the invites could not be sent: ${
                e?.message || "couldn't get permission to send mail"
              }`,
        );
      }
      if (token) {
        for (const person of created) {
          const gid = picks.find(
            (p) => (p.mail || p.userPrincipalName || "").trim().toLowerCase()
              === (person.email || "").toLowerCase(),
          )?.id;
          if (!person.email) {
            if (gid) results[gid] = "No email address — not invited.";
            inviteFailed = true;
            continue;
          }
          try {
            const { subject, body } = inviteText(person, invitedBy);
            await sendMail({ to: person.email, subject, body }, token);
            if (gid) results[gid] = "Invite sent.";
          } catch (e: any) {
            inviteFailed = true;
            if (gid) results[gid] = `Added, but the invite failed: ${e?.message || "send error"}`;
          }
        }
      }
      setInviteResults(results);
      setInviting(false);
    }

    // Stay open if anything at all needs the admin's attention.
    if (Object.keys(failed).length === 0 && !inviteFailed) onClose();
  }

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-person-title"
    >
      <div
        className="absolute inset-0 bg-brand-black/40 backdrop-blur-sm"
        onClick={() => !saving && onClose()}
      />
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3
              id="add-person-title"
              className="text-base font-semibold text-brand-black"
            >
              Add a person to PMO 360
            </h3>
            <p className="mt-0.5 text-xs text-brand-gray">
              Pick them out of the Castillo directory — they do not need to
              have signed in yet.
            </p>
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

        {!isAuthenticated ? (
          <p className="rounded-md border border-status-pending-border bg-status-pending-bg px-3 py-2 text-sm text-status-pending-text">
            Sign in to search the Castillo directory.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input
                type="text"
                className="input flex-1"
                placeholder="Search by name, email, title…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="shrink-0 text-xs text-brand-gray hover:text-brand-red disabled:opacity-40"
                onClick={() => void fetchDirectory()}
                disabled={loading}
                title="Re-read the directory from Microsoft"
              >
                ↻ Refresh
              </button>
            </div>

            <label
              className="flex select-none items-center gap-2 text-xs text-brand-gray"
              title="Hide disabled accounts, guests, shared mailboxes and unlicensed entries"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand-red"
                checked={activeOnly}
                onChange={(e) => setActiveOnly(e.target.checked)}
              />
              Only active employees with an M365 licence
            </label>

            <label
              className="flex select-none items-center gap-2 text-xs text-brand-gray"
              title="Sends from your own mailbox, so it arrives from you rather than a service account"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand-red"
                checked={sendInvite}
                onChange={(e) => setSendInvite(e.target.checked)}
              />
              Email them an invite from your mailbox
            </label>

            {error && (
              <div className="rounded-md border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
                {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto rounded-[10px] border border-surface-border">
              {loading ? (
                <p className="p-4 text-sm text-brand-gray">
                  Reading the Castillo directory…
                </p>
              ) : filtered.length === 0 ? (
                <p className="p-4 text-sm text-brand-gray">
                  {directory === null
                    ? "Directory not loaded."
                    : query
                      ? "Nobody in the directory matches that."
                      : "The directory came back empty."}
                </p>
              ) : (
                <ul>
                  {filtered.map((u) => (
                    <DirectoryRow
                      key={u.id}
                      person={u}
                      existing={existingFor(u)}
                      selected={selected.has(u.id)}
                      failure={failures[u.id]}
                      inviteResult={inviteResults[u.id]}
                      onToggle={() => toggle(u.id)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {/* Says exactly what "Add" does and does not do. It used to end
                "...or email them", which stopped being true when the invite
                was added — copy that contradicts the behaviour is worse than
                no copy, because an admin reads it and trusts it. */}
            <p className="text-[11px] leading-relaxed text-brand-gray">
              Adding someone creates their PMO 360 account with the standard
              starting permissions — the same ones they would get by signing in
              themselves — so you can set up their access and portfolios now.
              Change-order permissions are <strong>not</strong> included; grant
              those here afterwards if they need them. It does{" "}
              <strong>not</strong> create a Microsoft account or assign a
              licence. They sign in with their Castillo account.
              {sendInvite
                ? " They'll get an invite from your mailbox with the sign-in link."
                : " Nobody will be emailed."}
            </p>

            <div className="flex items-center justify-between gap-2 border-t border-surface-hairline pt-3">
              <div className="text-xs text-brand-gray">
                {selected.size > 0
                  ? `${selected.size} selected`
                  : "Click a name to select"}
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
                  onClick={() => void handleAdd()}
                  disabled={saving || inviting || selected.size === 0}
                >
                  {saving
                    ? "Adding…"
                    : inviting
                      ? "Sending invites…"
                      : addLabel(selected.size, sendInvite)}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function DirectoryRow({
  person,
  existing,
  selected,
  failure,
  inviteResult,
  onToggle,
}: {
  person: DirectoryUser;
  existing: Existing | null;
  selected: boolean;
  failure?: string;
  /** Outcome of the invite email, if one was attempted. Rendered separately
   *  from `failure` because "added but not emailed" is a different situation
   *  from "not added", and needs a different action from the admin. */
  inviteResult?: string;
  onToggle: () => void;
}) {
  const email = person.mail || person.userPrincipalName || "";
  // A row with no address cannot be provisioned — the server requires one, and
  // it is what every later lookup (roster, action owner, CO signatory) joins
  // on. Refused here rather than at submit.
  const noEmail = !email.trim();
  const blocked = !!existing || noEmail;

  return (
    <li
      className={clsx(
        "flex items-center gap-3 border-b border-surface-hairline px-3 py-2 last:border-0 transition",
        blocked
          ? "opacity-60"
          : selected
            ? "cursor-pointer bg-surface-mute"
            : "cursor-pointer hover:bg-surface-rowhover",
      )}
      onClick={() => !blocked && onToggle()}
    >
      <input
        type="checkbox"
        className="h-3.5 w-3.5 shrink-0 accent-brand-red"
        checked={selected}
        disabled={blocked}
        readOnly
        aria-label={`Add ${person.displayName}`}
      />
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-red text-xs font-semibold text-white">
        {initialsFor(person.displayName)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-brand-black">
          {person.displayName}
          {existing && <ExistingTag existing={existing} />}
          {noEmail && !existing && (
            <span className="ml-2 text-[11px] text-brand-lightgray">
              · no email in the directory
            </span>
          )}
        </div>
        <div className="truncate text-xs text-brand-gray">
          {email || "—"}
          {person.jobTitle ? ` · ${person.jobTitle}` : ""}
          {person.department ? ` · ${person.department}` : ""}
        </div>
        {failure && (
          <div className="mt-1 text-[11px] text-status-open-text">{failure}</div>
        )}
        {inviteResult && !failure && (
          <div
            className={clsx(
              "mt-1 text-[11px]",
              inviteResult.startsWith("Invite sent")
                ? "text-status-completed-text"
                : "text-status-pending-text",
            )}
          >
            {inviteResult}
          </div>
        )}
      </div>
    </li>
  );
}

/** Why this row can't be picked. Deactivated is called out separately because
 *  the fix is different — reactivate the existing row, don't add a second. */
function ExistingTag({ existing }: { existing: Existing }) {
  if (!existing.user.is_active) {
    return (
      <span className="ml-2 text-[11px] text-status-pending-text">
        · already in PMO 360, deactivated — reactivate their row instead
      </span>
    );
  }
  if (existing.matchedOn === "email") {
    return (
      <span className="ml-2 text-[11px] text-status-pending-text">
        · this email is already in PMO 360 under a different directory entry
      </span>
    );
  }
  return (
    <span className="ml-2 text-[11px] text-brand-lightgray">
      · already in PMO 360
    </span>
  );
}

/** The button says whether mail is about to leave. "Add 3 people" and
 *  "Add 3 people + invite" are different acts and the admin should not have to
 *  re-check a tickbox above to know which one they are about to perform. */
function addLabel(count: number, willInvite: boolean): string {
  if (count === 0) return "Add";
  const who = count === 1 ? "1 person" : `${count} people`;
  return willInvite ? `Add ${who} + invite` : `Add ${who}`;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
