/**
 * SendAgendaDialog — email the pre-meeting agenda PDF to attendees.
 *
 * Triggered from NextAgenda's action row. Mirrors the meeting-minutes Send
 * flow but inline as a modal so PMs don't lose the agenda draft they're
 * still editing.
 *
 * Two send paths, picked by the PM:
 *   1. "Send via Outlook" — Graph Mail.Send (Mail.Send scope, popup consent
 *      first time). PDF is attached automatically. Email lands in their
 *      Sent Items, same as if they'd sent from Outlook by hand.
 *   2. "Open in mail client" — mailto: fallback. Cannot carry attachments
 *      (RFC 6068), so we download the PDF in a side tab and the PM drags
 *      it onto the draft. Works even when MSAL is broken.
 *
 * Recipient picker: pulls attendee emails from the project roster + global
 * roster by name (case-insensitive). Attendees without a known email show
 * up greyed-out with a "no email on file" hint; PM can still type their
 * address into the "Extra recipients" textarea.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { format, parseISO } from "date-fns";

import { generateAgendaDoc, fetchMyPreferences } from "@/lib/api";
import { sendMail, blobToBase64 } from "@/lib/graph";
import { useAuth } from "@/auth/useAuth";
import type {
  Attendee,
  GlobalAttendee,
  AgendaDocRequest,
} from "@/lib/types";

/** Subset of NextAgenda's state passed in — everything we need to render
 *  the email composer + regenerate the PDF on send. */
export interface SendAgendaPayload {
  /** The Pydantic payload for /api/agendas/generate?fmt=pdf. We always
   *  re-fetch the PDF on send to make sure the version emailed matches
   *  whatever's in the editor right now (PM may have unsaved tweaks). */
  docPayload: AgendaDocRequest;
  /** Display names: shown in the subject + body templates. */
  clientName: string;
  projectName: string;
  /** ISO date for filename + the email body's "meeting date" reference. */
  upcomingDate: string;
  /** ISO date for filename, e.g. "2026-05-28". */
  title?: string | null;
  /** Editable attendee list straight from NextAgenda's state. We pair these
   *  by full_name against the rosters to resolve emails. */
  attendees: { full_name: string; initials: string; organization: string }[];
  /** Project + global rosters carry the emails. */
  projectRoster: Attendee[];
  globalRoster: GlobalAttendee[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  payload: SendAgendaPayload;
}

/** Pairs an attendee with their resolved email (if any) so the picker can
 *  surface both checked/unchecked rows and "no email on file" warnings. */
interface ResolvedAttendee {
  full_name: string;
  initials: string;
  organization: string;
  /** Lower-cased, trimmed email. null when neither roster had a hit. */
  email: string | null;
}


export default function SendAgendaDialog({ open, onClose, payload }: Props) {
  const { isAuthenticated, getMailSendToken } = useAuth();

  // Resolve each attendee against project + global rosters by full_name.
  // Case-insensitive trim so "Arun Patel " matches "Arun Patel".
  const resolved: ResolvedAttendee[] = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of payload.projectRoster) {
      const key = (a.full_name || "").trim().toLowerCase();
      if (key && a.email) map.set(key, a.email.trim().toLowerCase());
    }
    for (const g of payload.globalRoster) {
      const key = (g.full_name || "").trim().toLowerCase();
      // project roster wins — same precedence as the iCal export endpoint
      if (key && g.email && !map.has(key)) {
        map.set(key, g.email.trim().toLowerCase());
      }
    }
    return payload.attendees.map((a) => ({
      full_name: a.full_name,
      initials: a.initials,
      organization: a.organization,
      email: map.get((a.full_name || "").trim().toLowerCase()) || null,
    }));
  }, [payload.attendees, payload.projectRoster, payload.globalRoster]);

  const [toIdx, setToIdx] = useState<Set<number>>(new Set());
  const [ccIdx, setCcIdx] = useState<Set<number>>(new Set());
  const [toExtra, setToExtra] = useState("");
  const [ccExtra, setCcExtra] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(false);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendOk, setSendOk] = useState(false);

  // Pull email signature for the body template.
  const [signature, setSignature] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    fetchMyPreferences()
      .then((p) => setSignature(p?.email_signature || null))
      .catch(() => setSignature(null));
  }, [open]);

  // Build defaults whenever the dialog (re)opens, or the inputs that flow
  // into the template change. We DON'T overwrite the PM's edits — the
  // `edited` flag locks them.
  const defaults = useMemo(
    () =>
      buildEmailDefaults({
        clientName: payload.clientName,
        projectName: payload.projectName,
        upcomingDate: payload.upcomingDate,
        title: payload.title || null,
        signature,
      }),
    [
      payload.clientName,
      payload.projectName,
      payload.upcomingDate,
      payload.title,
      signature,
    ],
  );

  // Reset state every time the dialog re-opens. Pre-checks attendees with
  // known emails — by default, agenda goes to everyone we have an address
  // for. PM unchecks anyone they don't want.
  useEffect(() => {
    if (!open) return;
    setSubject(defaults.subject);
    setBody(defaults.body);
    setEdited(false);
    setSendError(null);
    setSendOk(false);
    const initialTo = new Set<number>();
    resolved.forEach((r, i) => {
      if (r.email) initialTo.add(i);
    });
    setToIdx(initialTo);
    setCcIdx(new Set());
    setToExtra("");
    setCcExtra("");
  }, [open, defaults.subject, defaults.body, resolved]);

  // Esc to close (but not during a send — avoid losing in-flight state)
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !sending) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, sending, onClose]);

  if (!open) return null;

  // ---- Compose the actual recipient strings ----
  const composedTo = useMemo(() => composeAddresses(resolved, toIdx, toExtra), [
    resolved,
    toIdx,
    toExtra,
  ]);
  const composedCc = useMemo(() => composeAddresses(resolved, ccIdx, ccExtra), [
    resolved,
    ccIdx,
    ccExtra,
  ]);

  function toggleTo(i: number) {
    setEdited(true);
    setToIdx((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }
  function toggleCc(i: number) {
    setEdited(true);
    setCcIdx((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }
  function selectAllTo() {
    setEdited(true);
    setToIdx(new Set(resolved.map((_, i) => i).filter((i) => resolved[i].email)));
  }
  function clearAll() {
    setEdited(true);
    setToIdx(new Set());
    setCcIdx(new Set());
  }
  function resetDefaults() {
    setSubject(defaults.subject);
    setBody(defaults.body);
    setEdited(false);
  }

  // ---- mailto: fallback ----
  function buildMailtoHref() {
    // RFC 6068: mailto headers + body must be PERCENT-encoded. URLSearchParams
    // form-encodes spaces as "+", which mail clients render as a literal "+",
    // so the email arrives "like+this". Build the query with encodeURIComponent.
    const parts: string[] = [];
    if (composedCc.trim()) parts.push(`cc=${encodeURIComponent(composedCc.trim())}`);
    if (subject) parts.push(`subject=${encodeURIComponent(subject)}`);
    if (body) parts.push(`body=${encodeURIComponent(body)}`);
    const toPart = composedTo.trim();
    const query = parts.join("&");
    return `mailto:${encodeURIComponent(toPart)}${query ? `?${query}` : ""}`;
  }

  async function handleOpenMail() {
    setSendError(null);
    if (!composedTo.trim()) {
      setSendError("Add at least one recipient before opening your mail client.");
      return;
    }
    try {
      // Download the PDF to a side tab so the PM can drag it onto the draft.
      const blob = await generateAgendaDoc(payload.docPayload, "pdf");
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      // mailto: can't carry attachments; open it 250ms later so the PDF
      // download tab grabs focus first.
      setTimeout(() => {
        window.location.href = buildMailtoHref();
        // Revoke after a delay so the new tab has time to start the download.
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }, 250);
    } catch (e: any) {
      setSendError(`Couldn't download the PDF: ${e?.message || e}`);
    }
  }

  // ---- Graph Mail.Send ----
  async function handleGraphSend() {
    setSendError(null);
    setSendOk(false);
    if (!composedTo.trim()) {
      setSendError("Add at least one recipient before sending.");
      return;
    }
    setSending(true);
    try {
      // 1. Regenerate the PDF so the email reflects the PM's latest tweaks
      //    (auto-save runs on a debounce — the agenda in the DB might be a
      //    few seconds behind what's on screen).
      const pdfBlob = await generateAgendaDoc(payload.docPayload, "pdf");
      const contentBytesBase64 = await blobToBase64(pdfBlob);

      // 2. Acquire Mail.Send token (pops consent first time only).
      const token = await getMailSendToken();

      // 3. Build a filename matching the existing meeting-minutes pattern.
      const slug = payload.projectName.replace(/[^A-Za-z0-9]+/g, "_");
      const filename = `${slug}_Pre_Meeting_Agenda_${payload.upcomingDate}.pdf`;

      await sendMail(
        {
          to: composedTo,
          cc: composedCc || undefined,
          subject,
          body,
          attachments: [
            { name: filename, contentType: "application/pdf", contentBytesBase64 },
          ],
        },
        token,
      );

      setSendOk(true);
    } catch (e: any) {
      // Friendly hints for the common MSAL failure modes — same playbook
      // the calendar card uses.
      const message: string = e?.message || String(e);
      if (/AADSTS500011/i.test(message)) {
        setSendError(
          "Outlook can't talk to PMO 360 yet — an Azure admin needs to grant " +
            "API consent (Azure portal → App registrations → PMO 360 → " +
            "Expose an API + API permissions → Grant admin consent).",
        );
      } else if (/Mail\.Send|consent/i.test(message)) {
        setSendError(
          "Mail.Send wasn't approved on this sign-in. Try again — Microsoft " +
            "should pop a one-time consent dialog. If it doesn't, use the " +
            "\"Open in mail client\" fallback.",
        );
      } else {
        setSendError(message);
      }
    } finally {
      setSending(false);
    }
  }

  const ready =
    subject.trim().length > 0 && composedTo.trim().length > 0 && !sending;
  const withEmail = resolved.filter((r) => r.email).length;
  const withoutEmail = resolved.length - withEmail;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="send-agenda-title"
    >
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={() => !sending && onClose()}
      />
      <div className="relative w-full max-w-3xl card p-5 space-y-4 shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3
            id="send-agenda-title"
            className="text-base font-semibold text-slate-900"
          >
            📧 Send pre-meeting agenda
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="text-slate-400 hover:text-slate-700 text-xl leading-none px-2 disabled:opacity-40"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* ---- Recipients picker ---- */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="label">Recipients</label>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={selectAllTo}
                className="text-brand-gray hover:text-brand-black underline"
              >
                Select all with email
              </button>
              <span className="text-brand-lightgray">·</span>
              <button
                type="button"
                onClick={clearAll}
                className="text-brand-gray hover:text-brand-black underline"
              >
                Clear
              </button>
            </div>
          </div>
          {resolved.length === 0 ? (
            <div className="text-xs text-brand-gray italic px-1">
              No attendees on this agenda yet — add some on the agenda editor
              before sending.
            </div>
          ) : (
            <div className="rounded border border-slate-200 divide-y divide-slate-100 text-xs">
              {resolved.map((r, i) => (
                <div
                  key={`${r.full_name}-${i}`}
                  className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 px-2 py-1.5"
                >
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={!r.email}
                      checked={toIdx.has(i)}
                      onChange={() => toggleTo(i)}
                    />
                    <span className="text-[10px] uppercase tracking-wide text-brand-gray">
                      To
                    </span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={!r.email}
                      checked={ccIdx.has(i)}
                      onChange={() => toggleCc(i)}
                    />
                    <span className="text-[10px] uppercase tracking-wide text-brand-gray">
                      Cc
                    </span>
                  </label>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-brand-black truncate">
                      {r.full_name}
                    </div>
                    <div className="text-[11px] text-brand-gray truncate">
                      {r.email
                        ? r.email
                        : "no email on file — add to roster or type below"}
                      {r.organization && ` · ${r.organization}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {withoutEmail > 0 && (
            <div className="text-[11px] text-amber-700 mt-1">
              {withoutEmail} attendee{withoutEmail === 1 ? "" : "s"} ha
              {withoutEmail === 1 ? "s" : "ve"} no email on file. Add their
              address to the project roster (Capture page) so they auto-fill
              next time.
            </div>
          )}
        </div>

        {/* ---- Extra recipients ---- */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Extra To (comma-separated)</label>
            <input
              type="text"
              className="input"
              placeholder="e.g. cc.engineer@vendor.com"
              value={toExtra}
              onChange={(e) => setToExtra(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Extra Cc</label>
            <input
              type="text"
              className="input"
              placeholder=""
              value={ccExtra}
              onChange={(e) => setCcExtra(e.target.value)}
            />
          </div>
        </div>

        {/* ---- Subject + Body ---- */}
        <div>
          <label className="label">Subject</label>
          <input
            type="text"
            className="input"
            value={subject}
            onChange={(e) => {
              setEdited(true);
              setSubject(e.target.value);
            }}
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label className="label">Body</label>
            {edited && (
              <button
                type="button"
                onClick={resetDefaults}
                className="text-xs text-brand-gray hover:text-brand-black underline"
              >
                Reset to defaults
              </button>
            )}
          </div>
          <textarea
            className="input min-h-[140px] font-[inherit]"
            value={body}
            onChange={(e) => {
              setEdited(true);
              setBody(e.target.value);
            }}
          />
        </div>

        {/* ---- Status row ---- */}
        {sendOk && (
          <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
            ✓ Sent. Check your Outlook Sent Items to confirm.
          </div>
        )}
        {sendError && (
          <div className="text-sm text-rose-800 bg-rose-50 border border-rose-200 rounded px-3 py-2">
            {sendError}
          </div>
        )}

        {/* ---- Footer actions ---- */}
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
          <div className="text-[11px] text-brand-gray">
            {composedTo.split(",").filter((s) => s.trim()).length} To ·{" "}
            {composedCc.split(",").filter((s) => s.trim()).length} Cc · PDF
            attached automatically
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="btn-ghost text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleOpenMail}
              disabled={!ready}
              className="btn-ghost text-xs"
              title="Opens your default mail client (Outlook, etc.) and downloads the PDF in a side tab for you to drag onto the message."
            >
              Open in mail client
            </button>
            <button
              type="button"
              onClick={handleGraphSend}
              disabled={!ready || !isAuthenticated}
              className="btn-primary text-xs"
              title={
                isAuthenticated
                  ? "Send via Microsoft Graph — PDF is attached automatically and the email lands in your Sent Items."
                  : "Sign in to send via Outlook directly."
              }
            >
              {sending ? "Sending…" : "Send via Outlook"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}


/* ============================================================
 * Helpers
 * ============================================================ */

/** Build "a@b.com, c@d.com" from checked rows + free-text extras. */
function composeAddresses(
  resolved: ResolvedAttendee[],
  picked: Set<number>,
  extras: string,
): string {
  const fromCheckboxes = resolved
    .filter((_, i) => picked.has(i))
    .map((r) => r.email)
    .filter((e): e is string => Boolean(e));
  const extraList = extras
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Dedupe — PM might toggle checkbox + also type the same address.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of [...fromCheckboxes, ...extraList]) {
    const k = e.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out.join(", ");
}


function buildEmailDefaults(args: {
  clientName: string;
  projectName: string;
  upcomingDate: string;
  title: string | null;
  signature: string | null;
}): { subject: string; body: string } {
  const niceDate = (() => {
    try {
      return format(parseISO(args.upcomingDate), "EEEE, MMMM d, yyyy");
    } catch {
      return args.upcomingDate;
    }
  })();
  const projectLabel = args.clientName
    ? `${args.clientName} / ${args.projectName}`
    : args.projectName;
  const subject =
    args.title?.trim() ||
    `Pre-meeting agenda — ${projectLabel} — ${niceDate}`;

  const sig = (args.signature || "").trim();
  const sigBlock = sig ? `\n\n${sig}` : "";

  const body =
    `Hi all,\n\n` +
    `Please find attached the agenda for our upcoming ` +
    `${projectLabel} coordination meeting on ${niceDate}.\n\n` +
    `Let me know ahead of time if you'd like to add anything or if ` +
    `there are blockers we should sequence first.\n\n` +
    `Thanks,${sigBlock}`;

  return { subject, body };
}
