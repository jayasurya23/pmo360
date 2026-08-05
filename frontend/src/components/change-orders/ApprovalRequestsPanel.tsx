/**
 * ApprovalRequestsPanel — who was asked to approve this change order, and what
 * they did about it.
 *
 * THIS LIST IS THE APPROVAL HISTORY, not a to-do list. `POST /{id}/reject` NULLs
 * `approved_by`, `approved_by_user_id` and `approved_at` straight off the change
 * order, so once a CO has been sent back there is nothing left on it saying
 * anybody ever approved anything. These rows survive that. Rendering the whole
 * list — superseded and rejected rows included — is the only place that record
 * is visible, so do not filter it down to the open ones.
 *
 * The other half of the job is the STALE flag, which is the visible face of a
 * money guard. A pending change order is still fully PATCH-editable
 * (`_assert_editable` only fires for approved/sent), so it can be re-priced
 * between "please approve this" and the approver clicking the link. The request
 * row snapshots `co.version` at the moment of asking; when that no longer
 * matches, the server refuses the approval with 409 `stale_co` and the approver
 * hits a wall. Flagging it here is what lets the PM re-request BEFORE that
 * happens, rather than finding out from a confused colleague.
 *
 * First responder decides: the CO needs only one of the people asked to act, and
 * the server closes the rest out as "superseded". The copy says so, because a PM
 * reading this as an approval chain will chase signatures nobody needs.
 */
import { useCallback, useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  fetchChangeOrderApprovalRequests,
  cancelChangeOrderApprovalRequest,
  type ApprovalRequest,
} from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";

/** Pill class + wording per request status. `superseded` and `cancelled` share
 *  the muted treatment: neither is a failure, both are just closed. */
const STATUS_PILL: Record<string, { cls: string; label: string; title: string }> = {
  pending: {
    cls: "pill-pending",
    label: "Waiting",
    title: "Asked, not yet answered",
  },
  approved: {
    cls: "pill-completed",
    label: "Approved",
    title: "This person approved the change order",
  },
  rejected: {
    cls: "pill-open",
    label: "Sent back",
    title: "This person sent the change order back",
  },
  superseded: {
    cls: "pill-cancelled",
    label: "Superseded",
    title:
      "Closed without an answer — somebody else got there first, or this " +
      "person was asked again at a newer figure",
  },
  cancelled: {
    cls: "pill-cancelled",
    label: "Cancelled",
    title: "Withdrawn before it was answered",
  },
};

const money = (n: number | null | undefined) =>
  n == null
    ? null
    : `$${Number(n).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

interface Props {
  coId: number;
  /** Bump to refetch — e.g. after RequestApprovalModal records new requests, or
   *  after an approve/reject changes every row's status at once. */
  refreshKey?: number;
  /** False hides the withdraw button. The server gates it on CO_CREATION
   *  regardless; this only stops us offering a click that would 403. */
  canCancel?: boolean;
  /** Fired after a successful cancel, so the page can refresh the CO with it. */
  onChanged?: () => void;
  /** Wired to open RequestApprovalModal — gives the empty state a way out. */
  onRequestApproval?: () => void;
}

export default function ApprovalRequestsPanel({
  coId,
  refreshKey = 0,
  canCancel = true,
  onChanged,
  onRequestApproval,
}: Props) {
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const confirm = useConfirm();

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    fetchChangeOrderApprovalRequests(coId)
      .then((rows) => {
        if (cancelled) return;
        setRequests(rows || []);
        setError(null);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message || "Couldn't load approval requests");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [coId]);

  useEffect(load, [load, refreshKey]);

  async function handleCancel(req: ApprovalRequest) {
    const who = req.requested_name || req.requested_email || "this person";
    const ok = await confirm({
      title: `Withdraw the request to ${who}?`,
      body:
        "They stop seeing it in their pending approvals. The request stays on " +
        "this list as part of the history — nothing is deleted, and it still " +
        "records the figure they were shown, so withdrawing it does not let " +
        "them approve a change order that has been re-priced since.",
      confirmLabel: "Withdraw",
      destructive: true,
    });
    if (!ok) return;
    setCancelling(req.id);
    try {
      await cancelChangeOrderApprovalRequest(coId, req.id);
      setRequests((prev) =>
        prev.map((r) =>
          r.id === req.id
            ? { ...r, status: "cancelled", responded_at: new Date().toISOString() }
            : r,
        ),
      );
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || "Couldn't withdraw the request");
    } finally {
      setCancelling(null);
    }
  }

  const pending = requests.filter((r) => r.status === "pending");
  const stalePending = pending.filter((r) => r.stale);

  return (
    <section className="card space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="section-title">
          Approval requests
          {requests.length > 0 && (
            <span className="text-brand-lightgray font-normal">
              ({requests.length})
            </span>
          )}
        </h3>
        {onRequestApproval && (
          <button className="btn-ghost text-sm" onClick={onRequestApproval}>
            + Request approval
          </button>
        )}
      </div>

      {/* The headline warning. Sits above the list because a PM who scrolls past
          it finds out about the 409 from whoever they asked. */}
      {stalePending.length > 0 && (
        <div className="rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2.5 text-sm text-status-open-text">
          <div className="font-semibold">
            {stalePending.length === 1
              ? "1 outstanding request is out of date"
              : `${stalePending.length} outstanding requests are out of date`}
          </div>
          <div className="mt-1">
            This change order was edited after{" "}
            {stalePending.length === 1 ? "that person was" : "those people were"}{" "}
            asked, so approving is now refused — they were asked to sign off on a
            different set of numbers.{" "}
            <strong className="font-semibold">
              Request approval again AND send the email.
            </strong>{" "}
            That files a fresh request at today's figure and closes the old one,
            which clears this warning — but only the email actually puts the new
            number in front of them, and the server cannot tell whether you sent
            one.
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
          {error}
        </div>
      )}

      {loading && requests.length === 0 ? (
        <p className="text-sm italic text-brand-gray">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="text-sm italic text-brand-gray">
          Nobody has been asked to approve this change order yet.
        </p>
      ) : (
        <>
          {pending.length > 1 && (
            <p className="text-xs text-brand-gray">
              {pending.length} people are being asked. Only one needs to act —
              the first answer closes the rest out.
            </p>
          )}
          <ul className="divide-y divide-surface-hairline">
            {requests.map((req) => (
              <RequestRow
                key={req.id}
                req={req}
                busy={cancelling === req.id}
                canCancel={canCancel}
                onCancel={() => void handleCancel(req)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RequestRow({
  req,
  busy,
  canCancel,
  onCancel,
}: {
  req: ApprovalRequest;
  busy: boolean;
  canCancel: boolean;
  onCancel: () => void;
}) {
  const status = (req.status || "pending").toLowerCase();
  const pill = STATUS_PILL[status] || {
    cls: "pill-cancelled",
    label: status,
    title: status,
  };
  const answered = status === "approved" || status === "rejected";
  // Stale only matters while a request is still open — a superseded or already
  // answered row being "stale" is just the CO having moved on since.
  const showStale = !!req.stale && status === "pending";
  const snapshot = money(req.total_at_request);
  const askedWho = req.requested_name || req.requested_email || "(unnamed)";
  /**
   * WHOSE NAME GOES NEXT TO THE OUTCOME.
   *
   * For an answered row it is the RESPONDER, resolved server-side from
   * `responded_by_user_id` — the one identity on this row the server stamped
   * itself. `requested_name` is free text whenever the ask was typed rather
   * than picked, so putting it beside a green "Approved" pill captions a
   * decision with a name nobody verified. Falls back to the requestee only for
   * rows written before responders were resolved.
   */
  const who = answered
    ? req.responded_by_name || askedWho
    : askedWho;
  /** Nobody asked: holding co_approval is enough to decide a CO you were never
   *  named on, and the server records that as one row that is both the ask and
   *  the answer. Saying "Asked …" about it would invent a request. */
  const unsolicited =
    answered &&
    req.requested_by_id == null &&
    req.responded_by_user_id != null &&
    req.responded_by_user_id === req.requested_user_id;

  return (
    <li className="space-y-1.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={pill.cls} title={pill.title}>
              {pill.label}
            </span>
            <span className="font-medium text-brand-black break-all">
              {who}
            </span>
          </div>
          {req.requested_email && req.requested_email !== who && (
            <div className="mt-0.5 break-all text-xs text-brand-gray">
              {req.requested_email}
            </div>
          )}
          <div className="mt-0.5 text-xs text-brand-gray">
            {unsolicited
              ? "Decided without being asked"
              : answered
                ? `Asked of ${askedWho}`
                : "Asked"}
            {!unsolicited && req.requested_by_name
              ? ` by ${req.requested_by_name}`
              : ""}
            {req.requested_at ? ` · ${when(req.requested_at)}` : ""}
            {snapshot ? ` · ${snapshot} at the time` : ""}
          </div>
          {req.responded_at && status !== "pending" && (
            <div className="mt-0.5 text-xs text-brand-gray">
              {status === "superseded"
                ? "Closed out when somebody else answered, or by a fresh request to the same person"
                : status === "cancelled"
                  ? `Withdrawn${req.responded_by_name ? ` by ${req.responded_by_name}` : ""}`
                  : status === "approved"
                    ? `Approved${req.responded_by_name ? ` by ${req.responded_by_name}` : ""}`
                    : `Sent back${req.responded_by_name ? ` by ${req.responded_by_name}` : ""}`}{" "}
              · {when(req.responded_at)}
            </div>
          )}
        </div>

        {status === "pending" && canCancel && (
          <button
            type="button"
            className="btn-danger shrink-0 text-xs"
            onClick={onCancel}
            disabled={busy}
          >
            {busy ? "Withdrawing…" : "Withdraw"}
          </button>
        )}
      </div>

      {req.response_note && (
        <div className="rounded-md border-l-4 border-l-surface-ghost bg-surface-mute px-3 py-1.5 text-xs italic text-brand-black">
          “{req.response_note}”
        </div>
      )}

      {showStale && (
        <div className="rounded-md border border-status-open-border bg-status-open-bg px-3 py-1.5 text-xs text-status-open-text">
          <strong className="font-semibold">Out of date.</strong> Asked at
          revision {req.co_version_at_request}; the change order has been edited
          since, so an approval from{" "}
          {req.requested_name || req.requested_email || "them"} will be refused.
          Request approval again — and email it — to re-ask them at the current
          figure. Withdrawing this request does not unblock them, deliberately.
        </div>
      )}
    </li>
  );
}

function when(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d, yyyy · h:mm a");
  } catch {
    return iso;
  }
}
