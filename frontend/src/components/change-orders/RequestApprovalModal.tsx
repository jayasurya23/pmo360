/**
 * RequestApprovalModal — ask one or more people to approve a change order.
 *
 * FIRST RESPONDER DECIDES. Everyone picked here gets asked, but the change
 * order only needs ONE of them to act; whoever gets there first closes the
 * others out as "superseded" server-side. So this is a "whoever is around"
 * list, not an approval chain, and the copy says so — a PM who reads it as
 * "all of these people must sign" will chase approvals that were never needed.
 *
 * Three delivery affordances, and the ORDER THEY RUN IN is the point:
 *
 *   1. RECORD FIRST (POST /request-approval). Always, before any email.
 *   2. Email second (the PM's own delegated Graph Mail.Send, same client-side
 *      path CoEmailModal uses), or the mailto: hand-off to Outlook.
 *   3. Copy link, any time — it is just the app URL for this CO.
 *
 * Recording first is not tidiness. The stored row snapshots `co.version` at the
 * moment of asking, and THAT SNAPSHOT IS THE MONEY GUARD: a pending CO is still
 * fully PATCH-editable, so it can be re-priced between the email going out and
 * the approver clicking the link, and the server compares the two versions and
 * refuses a stale approval. Email an approver a link with no row behind it and
 * they arrive at a CO with nothing to compare against — they approve whatever
 * the number happens to be by then. Hence: if the record fails, nothing is sent.
 *
 * The reverse order (email, then record) is also what burned the client-facing
 * send once already — see the note above `clearedToSend` in ChangeOrders.tsx.
 *
 * Deliberately NOT here: sending the change order to the client. Approval only
 * unlocks that; the PM still runs the send step by hand.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import OwnerPicker from "@/components/actions/OwnerPicker";
import {
  listUsers,
  listClientContacts,
  requestChangeOrderApproval,
  type ApprovalRecipientInput,
  type ApprovalRequest,
} from "@/lib/api";
import type { ChangeOrder } from "@/lib/types";
import { useAuth } from "@/auth/useAuth";
import { sendMail } from "@/lib/graph";

/**
 * The absolute URL an approver clicks. Origin + the CO route + the id.
 *
 * Absolute because it goes in an email, where a bare "/change-orders/12" is not
 * a link. There is no token in it and there is no public route behind it: the
 * approver hits the normal MSAL gate, signs in, and lands on this CO because
 * the gate renders in place without touching the URL.
 */
export function changeOrderApprovalLink(coId: number): string {
  return `${window.location.origin}/change-orders/${coId}`;
}

/** Whose side of the table a recipient sits on. See `classify()`. */
type Side = "castillo" | "client" | "unknown";

interface Recipient {
  email: string;
  name: string | null;
  /** Set when the pick resolved to a PMO 360 user row; null for free-form. */
  user_id: number | null;
  side: Side;
}

/** Castillo's own mail domain, mirroring CalendarCard's internal heuristic.
 *  Duplicated rather than shared because the two live in different features and
 *  neither owns a constants module; keep them in step if Castillo rebrands. */
const CASTILLO_EMAIL_DOMAIN = "@castillope.com";

const SIDE_PILL: Record<Side, { label: string; cls: string; title: string }> = {
  castillo: {
    label: "Castillo",
    cls: "pill-completed",
    title: "Castillo Engineering — internal, safe to ask for approval",
  },
  client: {
    label: "Client",
    cls: "pill-open",
    title: "In the client contact directory — this is NOT an internal address",
  },
  unknown: {
    label: "Outside Castillo",
    cls: "pill-pending",
    title: "Not a Castillo address and not a known client contact — check it",
  },
};

/** Readable wording for the CO status machine — `sent_back` is the only one
 *  that reads badly raw, but mapping all four keeps the sentence uniform. */
const CO_STATUS_LABEL: Record<string, string> = {
  draft: "still a draft",
  pending: "pending",
  approved: "already approved",
  sent_back: "sent back",
};

const money = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

interface Props {
  co: ChangeOrder;
  onClose: () => void;
  /** Fired once the requests are recorded, so the page can refresh the panel.
   *  Called on the RECORD, not on the email — the row exists either way. */
  onRequested?: (requests: ApprovalRequest[]) => void;
}

export default function RequestApprovalModal({ co, onClose, onRequested }: Props) {
  const { user, isAuthenticated, getMailSendToken } = useAuth();

  const link = useMemo(() => changeOrderApprovalLink(co.id), [co.id]);
  const coLabel = co.title?.trim() || "Untitled change order";
  const clientName = co.client_name?.trim() || "—";
  const portfolioName = co.project_name?.trim() || "—";

  const [recipients, setRecipients] = useState<Recipient[]>([]);
  // Remount counter for the picker. OwnerPicker mirrors its `value` prop into
  // internal state through an effect keyed on that prop, so a picked name
  // cannot be cleared by re-passing the "" we were already passing — the dep
  // never changes and the name stays in the box. Bumping a `key` gives us a
  // fresh, empty picker per chip without editing a file we don't own; the three
  // people-sources it loads are cached at module level, so it costs nothing.
  const [pickerNonce, setPickerNonce] = useState(0);
  const [pickerHint, setPickerHint] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // WHICH outsiders were acknowledged, not merely THAT some were. A boolean
  // survived the recipient list changing underneath it: tick the box for a
  // vendor, remove them, add a client contact, and the deliberate stop that
  // exists to keep an internal "not approved yet" request off the client's side
  // renders already-ticked for somebody nobody has looked at. Keyed on the
  // outsider set, so a different set is a fresh acknowledgement.
  const [ackedOutsiders, setAckedOutsiders] = useState("");

  // The two directories we classify against. Both degrade to empty on failure,
  // which pushes everyone into "Outside Castillo" — i.e. toward the warning,
  // never toward a silent all-clear.
  const [pmEmails, setPmEmails] = useState<Set<string>>(new Set());
  const [clientEmails, setClientEmails] = useState<Set<string>>(new Set());
  const [castilloPeople, setCastilloPeople] = useState<Recipient[]>([]);

  const [subject, setSubject] = useState(
    `Approval needed: ${coLabel} — ${clientName}`,
  );
  const [body, setBody] = useState(() =>
    defaultBody({ co, coLabel, clientName, portfolioName, link, from: user?.name }),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<ApprovalRequest[] | null>(null);
  const [emailState, setEmailState] = useState<
    "idle" | "sent" | "handed-to-outlook" | "failed"
  >("idle");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Its own state, not folded into `emailError`: that one only renders inside
  // the post-send failure panel, so a clipboard refusal before anything was
  // recorded would have been swallowed entirely.
  const [copyError, setCopyError] = useState<string | null>(null);

  // Load once. Neither call needs a Graph token, so this is safe on mount —
  // the Castillo M365 directory (the only place a job title like "VP" shows) is
  // still behind OwnerPicker's own explicit "Search Castillo directory" button.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listUsers("", 500).catch(() => []),
      listClientContacts().catch(() => []),
    ]).then(([users, contacts]) => {
      if (cancelled) return;
      setPmEmails(new Set(users.map((u) => (u.email || "").toLowerCase()).filter(Boolean)));
      setClientEmails(
        new Set(contacts.map((c) => (c.email || "").toLowerCase()).filter(Boolean)),
      );
      setCastilloPeople(
        users
          .filter((u) => u.email)
          .map((u) => ({
            email: (u.email || "").toLowerCase(),
            name: u.name || u.email,
            user_id: u.id,
            side: "castillo" as Side,
          }))
          .sort((a, b) => (a.name || "").localeCompare(b.name || "")),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Which side of the table an address sits on.
   *
   * The client directory wins over the domain check on purpose. Being filed as
   * a client contact is a fact somebody typed; a mail domain is a guess. If the
   * two disagree we want the answer that produces the warning, because the
   * failure this whole block exists to prevent is emailing an INTERNAL approval
   * request — one that says the change order is not approved yet — to somebody
   * on the client's side. That is the mis-click the CO recipient chips make easy
   * (they are the whole meeting roster with no separation at all), and it is why
   * this picker does not reuse them.
   */
  const classify = useCallback(
    (email: string): Side => {
      const e = email.toLowerCase().trim();
      if (!e) return "unknown";
      if (clientEmails.has(e)) return "client";
      if (e.endsWith(CASTILLO_EMAIL_DOMAIN)) return "castillo";
      // A PMO 360 user row means they sign in to this app, which only Castillo
      // staff do — so it is an internal address even on a non-Castillo domain.
      if (pmEmails.has(e)) return "castillo";
      return "unknown";
    },
    [clientEmails, pmEmails],
  );

  // Re-classify whenever a directory lands, so chips added in the first second
  // don't stay stuck on "Outside Castillo" once we know better.
  useEffect(() => {
    setRecipients((prev) =>
      prev.map((r) => ({ ...r, side: classify(r.email) })),
    );
  }, [classify]);

  const addRecipient = useCallback(
    (email: string, name: string | null, userId: number | null) => {
      const clean = email.toLowerCase().trim();
      if (!clean) return;
      setPickerHint(null);
      setRecipients((prev) =>
        prev.some((r) => r.email === clean)
          ? prev
          : [...prev, { email: clean, name, user_id: userId, side: classify(clean) }],
      );
    },
    [classify],
  );

  const removeRecipient = (email: string) =>
    setRecipients((prev) => prev.filter((r) => r.email !== email));

  const outsiders = recipients.filter((r) => r.side !== "castillo");
  // Sorted so the key depends on WHO is outside, not on the order they were
  // added — re-ordering the chips must not demand a second acknowledgement.
  const outsiderKey = outsiders.map((r) => r.email).sort().join(",");
  const ackExternal = outsiders.length > 0 && ackedOutsiders === outsiderKey;
  const needsAck = outsiders.length > 0 && !ackExternal;
  // A CO that isn't pending can't take a request — the server 409s — so say so
  // here rather than letting the PM compose an email into a refusal.
  const notPending = co.status !== "pending";
  const canAct = recipients.length > 0 && !needsAck && !notPending && !busy;

  /**
   * Record the requests. Returns true only when the rows exist.
   *
   * Idempotent from this dialog's point of view: once `recorded` is set we do
   * not post again, so "record, then also email" cannot double-file anyone.
   * (The server dedupes per CO + lowercased email anyway — asking the same
   * person again closes their outstanding row as "superseded" and files a fresh
   * one at the current version and price, so they are never outstanding twice.
   * The old row keeps the figure they were first asked about, which is the only
   * thing that can say afterwards what they were originally shown.)
   */
  async function record(): Promise<boolean> {
    if (recorded) return true;
    setError(null);
    try {
      const payload: ApprovalRecipientInput[] = recipients.map((r) => ({
        email: r.email,
        name: r.name,
        user_id: r.user_id,
      }));
      const res = await requestChangeOrderApproval(co.id, {
        recipients: payload,
        note: note.trim() || null,
      });
      setRecorded(res.requests);
      onRequested?.(res.requests);
      return true;
    } catch (e: any) {
      setError(
        e?.message ||
          "Could not record the approval request — nothing was sent.",
      );
      return false;
    }
  }

  /** Record only. They will see it in their pending approvals; no email. */
  async function recordOnly() {
    setBusy(true);
    await record();
    setBusy(false);
  }

  /** Record, then send from the PM's own mailbox via delegated Graph. */
  async function recordAndEmail() {
    setBusy(true);
    setEmailError(null);
    // Hard stop: no row, no email. See the file header — the row carries the
    // version snapshot the approval is checked against.
    if (!(await record())) {
      setBusy(false);
      return;
    }
    try {
      const token = await getMailSendToken();
      await sendMail(
        { to: recipients.map((r) => r.email).join(", "), subject, body },
        token,
      );
      setEmailState("sent");
    } catch (e: any) {
      // The request IS recorded at this point — that is the half that matters,
      // and it is why this reads as "the email didn't go" rather than as a
      // total failure. The PM still has the link to send by hand.
      setEmailState("failed");
      setEmailError(e?.message || "Microsoft Graph refused the message.");
    } finally {
      setBusy(false);
    }
  }

  /** Record, then hand the draft to the OS mail client. */
  async function recordAndOutlook() {
    setBusy(true);
    setEmailError(null);
    if (!(await record())) {
      setBusy(false);
      return;
    }
    const q = [
      `subject=${encodeURIComponent(subject)}`,
      `body=${encodeURIComponent(body)}`,
    ];
    window.location.href = `mailto:${encodeURIComponent(
      recipients.map((r) => r.email).join(","),
    )}?${q.join("&")}`;
    // Outlook never tells us whether the PM actually hit send, so this claims
    // only what we know: the draft was handed over.
    setEmailState("handed-to-outlook");
    setBusy(false);
  }

  async function copyLink() {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked on insecure origins and in some mobile browsers.
      // The link sits in a selectable field for exactly this case, so say so
      // rather than letting the button silently do nothing.
      setCopied(false);
      setCopyError(
        "Couldn't reach the clipboard — tap the link field above and copy it by hand.",
      );
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-brand-black/40 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="card flex max-h-[95dvh] w-full max-w-2xl flex-col overflow-y-auto rounded-b-none p-4 shadow-xl sm:max-h-[90vh] sm:rounded-b-[10px] sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* No "CO-3" anywhere in this dialog or the email it composes:
                co_number is per-portfolio and assigned without a unique
                constraint, so two change orders can wear the same one and an
                approver would have no way to tell which they were sent. Title +
                client + portfolio + version identifies it unambiguously. */}
            <h3 className="section-title">Request approval</h3>
            <p className="mt-0.5 truncate text-sm text-brand-gray">
              {coLabel} · {clientName} · {portfolioName}
            </p>
          </div>
          <button
            className="shrink-0 text-sm text-brand-lightgray transition hover:text-brand-red"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* What the approver is being asked to sign off, and what it does. */}
        <div className="mt-3 rounded-[10px] border border-surface-border bg-surface-mute p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-brand-gray">
              Total the approver will see
            </span>
            <span className="text-lg font-bold text-brand-black">
              {money(co.total_amount)}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-brand-gray">
            Version {co.co_version || "V1"} (internal revision {co.version ?? 1}).
            Approving <strong className="font-semibold">unlocks</strong> sending
            this to the client — it does not send anything to the client by
            itself. Only one of the people you pick needs to act; the rest are
            closed out automatically.
          </p>
        </div>

        {notPending && (
          <div className="mt-3 rounded-lg border border-status-pending-border bg-status-pending-bg px-3 py-2 text-sm text-status-pending-text">
            This change order is <strong>{CO_STATUS_LABEL[co.status] || co.status}</strong>.
            Approval can only be requested once it has been submitted and is
            pending.
          </div>
        )}

        {/* ---- who to ask ---- */}
        <div className="mt-4">
          <span className="label">Ask for approval from</span>

          {recipients.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {recipients.map((r) => {
                const pill = SIDE_PILL[r.side];
                return (
                  <li
                    key={r.email}
                    className="flex max-w-full items-center gap-1.5 rounded-full bg-surface-mute py-1 pl-1.5 pr-1"
                  >
                    <span className={`${pill.cls} shrink-0`} title={pill.title}>
                      {pill.label}
                    </span>
                    <span className="min-w-0 truncate text-xs text-brand-black">
                      {r.name || r.email}
                      <span className="ml-1 text-brand-gray">{r.email}</span>
                    </span>
                    <button
                      type="button"
                      className="shrink-0 px-1 text-brand-lightgray transition hover:text-brand-brightred"
                      onClick={() => removeRecipient(r.email)}
                      aria-label={`Remove ${r.name || r.email}`}
                      disabled={!!recorded}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {!recorded && (
            <>
              <OwnerPicker
                key={pickerNonce}
                value=""
                ownerUserId={null}
                placeholder="Search Castillo people, contacts or type an email…"
                onChange={({ owner, owner_user_id, email }) => {
                  // OwnerPicker is single-select, so we compose it: every commit
                  // becomes a chip and the field resets, which is why we don't
                  // edit that file to add multi-select.
                  const picked = (email || "").trim();
                  if (picked) {
                    addRecipient(picked, owner || null, owner_user_id);
                  } else if (looksLikeEmail(owner)) {
                    // Typed straight in — nobody we know, but a valid address.
                    addRecipient(owner.trim(), null, null);
                  } else if (owner.trim()) {
                    setPickerHint(
                      `${owner.trim()} has no email on file. An approval request is delivered by email, so pick someone with an address or type one.`,
                    );
                  }
                  setPickerNonce((n) => n + 1);
                }}
              />
              {pickerHint && (
                <p className="mt-1 text-xs text-status-pending-text">
                  {pickerHint}
                </p>
              )}

              {/* Castillo colleagues, one tap. This is the DEFAULT path on
                  purpose — an approval request is an internal document, and
                  every person listed here signs in to PMO 360. */}
              {castilloPeople.length > 0 && (
                <div className="mt-2">
                  <span className="micro-label">Castillo people</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {castilloPeople
                      .filter((p) => !recipients.some((r) => r.email === p.email))
                      .slice(0, 12)
                      .map((p) => (
                        <button
                          key={p.email}
                          type="button"
                          className="rounded-full border border-surface-border px-2.5 py-0.5 text-xs text-brand-gray transition hover:border-brand-red hover:text-brand-red"
                          onClick={() => addRecipient(p.email, p.name, p.user_id)}
                          title={p.email}
                        >
                          + {p.name}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* The guard. Loud, and it blocks the buttons until acknowledged. */}
        {outsiders.length > 0 && (
          <div className="mt-3 rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2.5 text-sm text-status-open-text">
            <div className="font-semibold">
              {outsiders.length === 1
                ? "1 recipient is not a Castillo address"
                : `${outsiders.length} recipients are not Castillo addresses`}
            </div>
            <div className="mt-1">
              {outsiders.map((r) => r.email).join(", ")} —{" "}
              {outsiders.some((r) => r.side === "client")
                ? "at least one is in the client contact directory. "
                : ""}
              This is an <strong>internal</strong> request. It says the change
              order is not approved yet and links into PMO 360, which people
              outside Castillo cannot sign in to.
            </div>
            <label className="mt-2 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={ackExternal}
                onChange={(e) =>
                  setAckedOutsiders(e.target.checked ? outsiderKey : "")
                }
              />
              <span>
                I checked the addresses — ask them anyway.
              </span>
            </label>
          </div>
        )}

        {/* ---- the message ---- */}
        <label className="mt-4 block">
          <span className="label">Note on the request (in-app, optional)</span>
          <input
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Client wants this signed before Friday"
            disabled={!!recorded}
          />
        </label>

        <label className="mt-3 block">
          <span className="label">Email subject</span>
          <input
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
        <label className="mt-3 block">
          <span className="label">Email body</span>
          <textarea
            className="textarea font-sans"
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        {/* ---- the link, always visible and always selectable ---- */}
        <div className="mt-3">
          <span className="label">Approval link</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="input font-mono text-xs"
              value={link}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="btn-ghost shrink-0"
              onClick={() => void copyLink()}
            >
              {copied ? "✓ Copied" : "Copy link"}
            </button>
          </div>
          <p className="mt-1 text-xs text-brand-gray">
            Opens this change order after a normal Microsoft sign-in. There is no
            token in the link and it grants nobody anything they don't already
            have.
          </p>
          {copyError && (
            <p className="mt-1 text-xs text-status-pending-text">{copyError}</p>
          )}
        </div>

        {/* ---- outcomes ---- */}
        {error && (
          <div className="mt-3 rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
            {error}
          </div>
        )}

        {recorded && emailState === "failed" && (
          <div className="mt-3 rounded-lg border border-status-pending-border bg-status-pending-bg px-3 py-2.5 text-sm text-status-pending-text">
            <div className="font-semibold">
              Recorded — but the email did not go out.
            </div>
            <div className="mt-1">
              {recorded.length === 1 ? "The person" : "Everyone"} you picked will
              still see this in their pending approvals. Nobody was emailed, so
              send them the link yourself or try again.
            </div>
            {emailError && (
              <div className="mt-1 text-xs opacity-80">Reason: {emailError}</div>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="btn-primary px-3 py-1.5 text-xs"
                onClick={() => void recordAndEmail()}
                disabled={busy}
              >
                {busy ? "Sending…" : "Try the email again"}
              </button>
              <button
                className="btn-ghost px-3 py-1.5 text-xs"
                onClick={() => void copyLink()}
              >
                {copied ? "✓ Copied" : "Copy link instead"}
              </button>
            </div>
          </div>
        )}

        {recorded && emailState !== "failed" && (
          <div className="mt-3 rounded-lg border border-status-completed-border bg-status-completed-bg px-3 py-2.5 text-sm text-status-completed-text">
            <div className="font-semibold">
              ✓ Requested from{" "}
              {recorded.length === 1
                ? "1 person"
                : `${recorded.length} people`}
              {emailState === "sent" && " — email sent"}
              {emailState === "handed-to-outlook" && " — draft opened in Outlook"}
              .
            </div>
            <div className="mt-1">
              It is on their pending approvals now. The first one to approve or
              send back decides it; the rest are closed out automatically.
              {emailState === "idle" &&
                " No email was sent — share the link above if they need a nudge."}
            </div>
          </div>
        )}

        {/* ---- actions ---- */}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          {recorded ? (
            <button className="btn-primary" onClick={onClose} disabled={busy}>
              Done
            </button>
          ) : (
            <>
              <button
                className="btn-ghost"
                onClick={() => void recordOnly()}
                disabled={!canAct}
                title="Files the request in-app without emailing anyone."
              >
                Record without emailing
              </button>
              <button
                className="btn-ghost"
                onClick={() => void recordAndOutlook()}
                disabled={!canAct}
                title="Records the request, then opens the draft in your mail client."
              >
                ✉ Open in Outlook
              </button>
              <button
                className="btn-primary"
                onClick={() => void recordAndEmail()}
                disabled={!canAct || !isAuthenticated}
                title={
                  isAuthenticated
                    ? "Records the request, then emails it from your mailbox."
                    : "Sign in to send via Graph."
                }
              >
                {busy ? "Working…" : "🚀 Send request"}
              </button>
            </>
          )}
        </div>
        {!recorded && !isAuthenticated && (
          <p className="mt-2 text-xs text-brand-gray">
            One-click send needs sign-in; the Outlook draft and the link both
            work without it.
          </p>
        )}
      </div>
    </div>
  );
}

/** Anything with an @ and a dot after it. Deliberately loose — the server and
 *  Graph both validate properly, and a stricter regex here only rejects the
 *  addresses people actually have. */
function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** The default message. Identifies the CO by title/client/portfolio/version —
 *  never by co_number, which is per-portfolio and not unique. */
function defaultBody(args: {
  co: ChangeOrder;
  coLabel: string;
  clientName: string;
  portfolioName: string;
  link: string;
  from?: string | null;
}): string {
  const { co, coLabel, clientName, portfolioName, link, from } = args;
  return (
    `Hi,\n\n` +
    `Please review and approve this change order in PMO 360.\n\n` +
    `  Change order: ${coLabel}\n` +
    `  Client:       ${clientName}\n` +
    `  Portfolio:    ${portfolioName}\n` +
    `  Version:      ${co.co_version || "V1"} (internal revision ${co.version ?? 1})\n` +
    `  Total:        ${money(co.total_amount)}\n\n` +
    `Open it here and sign in with your Microsoft account:\n${link}\n\n` +
    `Approving unlocks sending the change order to the client — it does not ` +
    `send anything to the client by itself. You can also send it back with a ` +
    `note if something needs changing.\n\n` +
    `If several people were asked, only one of us needs to act.\n\n` +
    `Thanks,\n${from || ""}`
  );
}
