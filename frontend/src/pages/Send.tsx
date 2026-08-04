import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import {
  finalizeMeeting,
  getMeeting,
  fetchMyPreferences,
  type UserPreferences,
} from "@/lib/api";
import { fetchMeetingDocBlob, saveMeetingDoc } from "@/lib/documents";
import type { MeetingDetail } from "@/lib/types";
import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";
import { sendMail, blobToBase64 } from "@/lib/graph";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

/** Filetype square + human label per generated deliverable. Colours come from
 *  the redesign's filetype palette; anything the backend adds later falls
 *  back to a neutral square.
 *
 *  Each square is a tint-fill + saturated-label pair. Both halves are tokens
 *  (a translucent brand fill over the card, and a text-weight brand colour) so
 *  the fill darkens and the label lightens together when the theme flips —
 *  a literal pale fill would strand dark text on a dark card. */
const DELIVERABLE_META: Record<string, { label: string; square: string }> = {
  pdf: {
    label: "Client minutes",
    square: "bg-status-open-bg text-brand-red text-[11px]",
  },
  docx: {
    label: "Editable Word copy",
    square: "bg-brand-blue/15 text-brand-deepblue text-[10px]",
  },
  xlsx: {
    label: "Action log",
    square: "bg-brand-green/15 text-brand-green text-[10px]",
  },
};

export default function Send() {
  const nav = useNavigate();
  const { draftMeetingId, currentProject, currentClient, resetDraft } = useApp();
  const [busy, setBusy] = useState(false);
  const [paths, setPaths] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);

  // ---- Load the meeting once we have an id, to seed the email composer ----
  useEffect(() => {
    if (!draftMeetingId) return;
    let cancelled = false;
    getMeeting(draftMeetingId)
      .then((m) => {
        if (!cancelled) setMeeting(m);
      })
      .catch(() => {
        /* keep composer in a usable state even on fetch failure */
      });
    return () => {
      cancelled = true;
    };
  }, [draftMeetingId]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;
  if (!draftMeetingId)
    return (
      <EmptyState
        title="No meeting to finalize"
        action={
          <button className="btn-primary mt-2" onClick={() => nav("/review")}>
            Go to Review
          </button>
        }
      />
    );

  const handleFinalize = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await finalizeMeeting(draftMeetingId);
      setPaths(res.paths);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const meetingLabel = meeting
    ? `${meeting.title?.trim() || currentProject.name} — ${format(
        parseISO(meeting.meeting_date),
        "MMM d",
      )}`
    : null;

  return (
    <div className="max-w-doc mx-auto pb-10">
      <PageHeader
        kicker={`Step 4 of 4${meetingLabel ? ` · ${meetingLabel}` : ""}`}
        title="Finalize & send"
        actions={
          paths ? (
            <button
              className="btn-ghost"
              onClick={() => {
                resetDraft();
                nav("/");
              }}
            >
              Start a new meeting
            </button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.35fr] gap-[22px] items-start">
        <div className="flex flex-col gap-5">
          <section className="card px-5 py-[18px]">
            <div className="flex items-center gap-2.5">
              <h3 className="section-title">Finalize</h3>
              {paths && <span className="pill-completed">✓ Generated</span>}
            </div>
            <p className="mt-2 text-sm text-brand-gray leading-relaxed">
              {paths ? (
                <>
                  Marked <b>final</b> — all three deliverables were regenerated
                  and saved to the project folder in storage.
                </>
              ) : (
                <>
                  This will mark the meeting as <b>final</b>, regenerate all
                  three deliverables, and save them under the project folder in
                  storage.
                </>
              )}
            </p>
            {/* Once generated the pill carries the state; the button would be
                permanently disabled from here on. */}
            {!paths && (
              <button
                className="btn-primary mt-4"
                disabled={busy}
                onClick={handleFinalize}
              >
                {busy ? "Generating…" : "Generate final docs"}
              </button>
            )}
            {error && <div className="mt-3 text-sm text-brand-red">{error}</div>}
          </section>

          {paths && (
            <section className="card overflow-hidden">
              <div className="flex items-baseline gap-2 border-b border-surface-hairline px-5 py-3.5">
                <h3 className="section-title">Deliverables</h3>
                {/* Buttons rather than hrefs throughout this page: the
                    document endpoint requires a bearer token an anchor cannot
                    send. See lib/documents.ts. */}
                <button
                  type="button"
                  className="ml-auto text-xs font-semibold text-brand-red hover:text-brand-darkred"
                  onClick={() => void saveMeetingDoc(draftMeetingId!, "zip")}
                >
                  ZIP (all) ⬇
                </button>
              </div>
              {Object.entries(paths).map(([kind, p]) => {
                const meta = DELIVERABLE_META[kind] ?? {
                  label: kind.toUpperCase(),
                  square: "bg-surface-mute text-brand-gray text-[10px]",
                };
                return (
                  <div
                    key={kind}
                    className="flex items-center gap-3 px-5 py-[11px] border-b border-surface-page last:border-0"
                  >
                    <span
                      className={clsx(
                        "h-[38px] w-[38px] shrink-0 rounded-lg flex items-center justify-center font-bold",
                        meta.square,
                      )}
                    >
                      {kind.toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-brand-black">
                        {meta.label}
                      </div>
                      <div className="truncate text-[11px] text-brand-gray" title={p}>
                        {p}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-xs font-semibold text-brand-red hover:text-brand-darkred"
                      onClick={() =>
                        void saveMeetingDoc(
                          draftMeetingId!,
                          kind as "pdf" | "docx" | "xlsx",
                        )
                      }
                    >
                      Download
                    </button>
                  </div>
                );
              })}
            </section>
          )}

          {/* -------- Bridge to the next cycle -------- */}
          {/* The pre-meeting agenda for next week is the natural next step once
              minutes are out. Auto-draft carries forward this portfolio's open
              actions, latest risks/decisions, and this meeting's recap so the
              PM starts 80% done instead of from a blank page. */}
          <section className="card border-t-[3px] border-t-brand-blue px-5 py-[18px]">
            <h3 className="section-title">📅 Plan the next meeting</h3>
            <p className="mt-2 mb-3 text-sm text-brand-gray leading-relaxed">
              Minutes are done. Start next week's pre-meeting agenda — we'll
              auto-draft it from this portfolio's open actions, latest risks and
              decisions, and this meeting's discussion recap. You review and
              save.
            </p>
            <button
              className="btn-primary"
              onClick={() => nav("/next-agenda?autodraft=1")}
            >
              Plan next agenda →
            </button>
          </section>
        </div>

        {/* -------- Compose email (Graph send + mailto: fallback) -------- */}
        <ComposeEmailSection
          meeting={meeting}
          clientName={currentClient?.name || ""}
          projectName={currentProject.name}
          pdfPath={paths?.pdf || null}
          meetingId={draftMeetingId}
        />
      </div>
    </div>
  );
}


/* ============================================================
 * Compose email — one-click Microsoft Graph send with a mailto:
 * fallback. Pre-fills Subject + Body from the meeting; the mailto
 * path can't carry attachments (RFC 6068) so the PDF downloads in
 * a side tab for the PM to attach by hand.
 * ============================================================ */
function ComposeEmailSection({
  meeting,
  clientName,
  projectName,
  pdfPath,
  meetingId,
}: {
  meeting: MeetingDetail | null;
  clientName: string;
  projectName: string;
  pdfPath: string | null;
  meetingId: number;
}) {
  const { isAuthenticated, getMailSendToken } = useAuth();

  // Pull the user's saved email signature so it gets appended after "Best,"
  // in the default body. Failures (anonymous / network) silently fall back
  // to the un-signed default.
  const [userPrefs, setUserPrefs] = useState<UserPreferences | null>(null);
  useEffect(() => {
    fetchMyPreferences()
      .then(setUserPrefs)
      .catch(() => {
        /* leave defaults un-signed when prefs aren't available */
      });
  }, []);

  // Default subject + body are derived from the meeting once we have it.
  // We stash them in state so the PM can tweak before sending.
  const defaults = useMemo(
    () => buildEmailDefaults(meeting, clientName, projectName, userPrefs?.email_signature || null),
    [meeting, clientName, projectName, userPrefs?.email_signature],
  );

  // Checked attendee ids drive the To/Cc lists. We keep ids (not emails) so
  // that the controls stay in sync even if an attendee email changes server-
  // side mid-session.
  const [toIds, setToIds] = useState<Set<number>>(new Set());
  const [ccIds, setCcIds] = useState<Set<number>>(new Set());
  const [toExtra, setToExtra] = useState("");
  const [ccExtra, setCcExtra] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [edited, setEdited] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendOk, setSendOk] = useState(false);

  // Attendees with usable emails — these are the candidates for the picker.
  const attendees = meeting?.attendees || [];

  // Seed the editable fields once the meeting + defaults are ready, unless
  // the PM has already typed into them (don't clobber unsaved input).
  useEffect(() => {
    if (edited) return;
    setSubject(defaults.subject);
    setBody(defaults.body);
  }, [defaults, edited]);

  // Compose the actual to/cc strings: checked attendees + extra free-text.
  const composedTo = useMemo(() => {
    const fromCheckboxes = attendees
      .filter((a) => toIds.has(a.id) && a.email)
      .map((a) => a.email!.trim())
      .filter(Boolean);
    const extras = toExtra
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return [...fromCheckboxes, ...extras].join(", ");
  }, [attendees, toIds, toExtra]);

  const composedCc = useMemo(() => {
    const fromCheckboxes = attendees
      .filter((a) => ccIds.has(a.id) && a.email)
      .map((a) => a.email!.trim())
      .filter(Boolean);
    const extras = ccExtra
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return [...fromCheckboxes, ...extras].join(", ");
  }, [attendees, ccIds, ccExtra]);

  const toggleTo = (id: number) => {
    setEdited(true);
    setToIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCc = (id: number) => {
    setEdited(true);
    setCcIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const replyAllAttendees = () => {
    setEdited(true);
    setToIds(new Set(attendees.filter((a) => a.email).map((a) => a.id)));
  };

  const mailtoHref = useMemo(() => {
    // RFC 6068: mailto headers + body must be PERCENT-encoded. URLSearchParams
    // form-encodes spaces as "+", which mail clients render as a literal "+"
    // (a space is %20 in a mailto, not "+"), so build the query by hand with
    // encodeURIComponent — otherwise the whole email arrives "like+this".
    const parts: string[] = [];
    if (composedCc.trim()) parts.push(`cc=${encodeURIComponent(composedCc.trim())}`);
    if (subject) parts.push(`subject=${encodeURIComponent(subject)}`);
    if (body) parts.push(`body=${encodeURIComponent(body)}`);
    const toPart = composedTo.trim();
    const query = parts.join("&");
    return `mailto:${encodeURIComponent(toPart)}${query ? `?${query}` : ""}`;
  }, [composedTo, composedCc, subject, body]);

  function handleResetDefaults() {
    setSubject(defaults.subject);
    setBody(defaults.body);
    setEdited(false);
  }

  function handleOpenMail() {
    // Download the PDF first so the user has it ready to attach, then open
    // the mailto: URL in the SAME click handler so their mail client launches.
    // This used to window.open the doc endpoint, which sends no Authorization
    // header and so opened a tab showing 401 instead of saving a file.
    // saveMeetingDoc fetches through the authed client and saves the blob.
    if (meetingId) {
      void saveMeetingDoc(meetingId, "pdf");
    }
    // Slight delay so the download tab opens before the mail client steals
    // focus. Without this some browsers swallow the download.
    setTimeout(() => {
      window.location.href = mailtoHref;
    }, 250);
  }

  /**
   * One-click send via Microsoft Graph. Fetches the PDF, base64-encodes it,
   * acquires a Mail.Send token (prompting for consent the first time),
   * then POSTs /me/sendMail. Email lands in the signed-in user's Sent
   * Items — same as if they'd sent from Outlook by hand.
   */
  async function handleGraphSend(toOverride?: string, ccOverride?: string) {
    setSendError(null);
    setSendOk(false);
    // Recipients can be passed explicitly (auto-send-on-finalize computes
    // them directly from the attendee list, bypassing the checkbox state
    // which hasn't propagated yet) or default to the composed checkboxes.
    const to = (toOverride ?? composedTo).trim();
    const cc = (ccOverride ?? composedCc).trim();
    if (!to) {
      setSendError("Add at least one recipient before sending.");
      return;
    }
    setSending(true);
    try {
      // 1. Pull the PDF bytes. Always regenerate via the same-origin backend
      //    endpoint rather than the stored file URL: in production the stored
      //    "path" is a SharePoint webUrl, which the browser can't fetch
      //    (cross-origin, not a direct download) — finalizedFileUrl would 404.
      //    The regenerate endpoint streams identical bytes and works in every
      //    storage mode.
      //    A bare fetch() sends no Authorization header, so this failed with
      //    "Couldn't fetch PDF: 401" and the minutes never reached the client.
      const pdfBlob = await fetchMeetingDocBlob(meetingId, "pdf");
      const contentBytesBase64 = await blobToBase64(pdfBlob);

      // 2. Get a Graph Mail.Send token. First call pops the consent dialog
      //    if the user hasn't approved Mail.Send yet.
      const token = await getMailSendToken();

      // 3. Build a sensible filename for the attachment.
      const filename = (() => {
        if (!meeting) return "Meeting_Minutes.pdf";
        const d = format(parseISO(meeting.meeting_date), "yyyy-MM-dd");
        const slug = projectName.replace(/[^A-Za-z0-9]+/g, "_");
        return `${slug}_Meeting_Minutes_${d}.pdf`;
      })();

      // 4. Send.
      await sendMail(
        {
          to,
          cc: cc || undefined,
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
      setSendError(e?.message || "Send failed");
    } finally {
      setSending(false);
    }
  }

  // ---- Auto-send on finalize ----
  // When the PM has opted in (Settings → Automation) AND finalize just
  // produced a PDF AND we're signed in with at least one emailable
  // attendee, fire the Graph send exactly once. We compute recipients
  // directly from the attendee list (not the checkbox state, which hasn't
  // settled yet) and gate on `subject` being seeded so the defaults effect
  // has populated the body. Auto-checks the recipients in the UI so the PM
  // sees who it went to.
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (autoSentRef.current) return;
    if (!userPrefs?.auto_send_minutes_on_finalize) return;
    if (!pdfPath) return; // finalize hasn't produced the file yet
    if (!isAuthenticated) return;
    if (!meeting) return; // need attendees + defaults
    if (!subject.trim()) return; // wait until defaults seed the subject/body
    const recipients = attendees.filter((a) => a.email);
    if (recipients.length === 0) return;
    autoSentRef.current = true;
    setEdited(true); // lock defaults so they don't re-seed under us
    setToIds(new Set(recipients.map((a) => a.id)));
    const toStr = recipients
      .map((a) => a.email!.trim())
      .filter(Boolean)
      .join(", ");
    void handleGraphSend(toStr, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userPrefs, pdfPath, isAuthenticated, meeting, subject, attendees]);

  const ready =
    subject.trim().length > 0 && composedTo.trim().length > 0;

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface-hairline px-5 py-3.5">
        <h3 className="section-title">Compose email</h3>
        <span className="text-xs text-brand-gray">PDF attaches automatically</span>
        <button
          type="button"
          className="ml-auto text-xs font-semibold text-brand-red hover:text-brand-darkred disabled:opacity-50"
          onClick={replyAllAttendees}
          disabled={!attendees.some((a) => a.email)}
          title="Check every attendee who has an email on file"
        >
          ✉ Reply-all attendees
        </button>
      </div>

      <div className="px-5 py-4 flex flex-col gap-3">
        {userPrefs?.auto_send_minutes_on_finalize && !sendOk && (
          <div className="text-xs rounded-lg border border-brand-blue/30 bg-brand-blue/10 px-3 py-2 text-brand-deepblue">
            ⚡ Auto-send is on — once you finalize, the minutes will be emailed
            to all attendees with an address on file. Turn this off in Settings
            → Automation.
          </div>
        )}

        {/* Recipient picker — pulled from this meeting's attendees */}
        <div>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-brand-gray">
            Recipients from this meeting
          </div>
          {attendees.length === 0 ? (
            <div className="text-xs italic text-brand-gray">
              (No attendees on this meeting yet.)
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
              {attendees.map((a) => {
                const hasEmail = !!a.email;
                return (
                  <div
                    key={a.id}
                    className={clsx(
                      "grid grid-cols-[auto_auto_1fr] gap-3 items-center rounded-lg border border-surface-hairline px-2.5 py-[7px] text-[13px]",
                      !hasEmail && "opacity-[0.55]",
                    )}
                    title={!hasEmail ? "No email on file" : undefined}
                  >
                    <label className="flex items-center gap-1.5 text-xs text-brand-gray">
                      <input
                        type="checkbox"
                        className="accent-brand-red"
                        checked={toIds.has(a.id)}
                        disabled={!hasEmail}
                        onChange={() => toggleTo(a.id)}
                      />
                      To
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-brand-gray">
                      <input
                        type="checkbox"
                        className="accent-brand-red"
                        checked={ccIds.has(a.id)}
                        disabled={!hasEmail}
                        onChange={() => toggleCc(a.id)}
                      />
                      Cc
                    </label>
                    <div className="min-w-0 truncate">
                      <span className="font-semibold text-brand-black">
                        {a.full_name}
                      </span>
                      <span className="text-brand-gray">
                        {" · "}
                        {a.initials}
                        {a.organization ? ` · ${a.organization}` : ""}
                        {hasEmail
                          ? ` · ${a.email}`
                          : " · no email on file — add it on Capture"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 items-center">
          <FieldLabel>Extra to</FieldLabel>
          <input
            className="input"
            placeholder="extra@example.com, other@example.com"
            value={toExtra}
            onChange={(e) => {
              setToExtra(e.target.value);
              setEdited(true);
            }}
          />

          <FieldLabel>Extra cc</FieldLabel>
          <input
            className="input"
            placeholder="carol@example.com"
            value={ccExtra}
            onChange={(e) => {
              setCcExtra(e.target.value);
              setEdited(true);
            }}
          />

          <FieldLabel>Subject</FieldLabel>
          <input
            className="input"
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setEdited(true);
            }}
          />

          <FieldLabel alignTop>Body</FieldLabel>
          <textarea
            className="textarea font-sans"
            rows={8}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setEdited(true);
            }}
          />
        </div>

        {/* Tiny preview of the actual to/cc that will go out */}
        {(composedTo || composedCc) && (
          <div className="text-[11px] text-brand-gray">
            <b>To:</b> {composedTo || <span className="italic">(none)</span>}
            {composedCc && (
              <>
                {" · "}
                <b>Cc:</b> {composedCc}
              </>
            )}
          </div>
        )}

        {sendError && (
          <div className="text-sm rounded-lg border border-status-open-border/40 bg-status-open-bg px-3 py-2 text-status-open-text">
            {sendError}
          </div>
        )}
        {sendOk && (
          <div className="text-sm rounded-lg border border-status-completed-border/50 bg-status-completed-bg px-3 py-2 text-status-completed-text">
            ✓ Sent. Check your Sent Items folder in Outlook.
          </div>
        )}

        <div className="flex items-center gap-2.5 flex-wrap border-t border-surface-hairline pt-3">
          <button
            type="button"
            className="text-xs text-brand-gray underline underline-offset-2 hover:text-brand-red disabled:opacity-50"
            onClick={handleResetDefaults}
            disabled={!edited}
          >
            Reset to defaults
          </button>
          <div className="flex-1" />
          <button
            type="button"
            className="btn-ghost"
            onClick={handleOpenMail}
            disabled={!ready}
            title="Opens your default mail client (mailto:) with subject + body pre-filled; PDF downloads in a separate tab to attach manually."
          >
            ✉ Open in Outlook
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleGraphSend()}
            disabled={!ready || sending || !isAuthenticated}
            title={
              isAuthenticated
                ? "Sends directly via Microsoft Graph from your mailbox — PDF attached automatically."
                : "Sign in to use one-click send."
            }
          >
            {sending ? "Sending…" : "🚀 Send via Graph"}
          </button>
        </div>

        {!isAuthenticated && (
          <p className="text-xs text-brand-gray">
            One-click send requires sign-in. Use <b>Sign in</b> in the top right,
            then come back. The mailto fallback works without signing in.
          </p>
        )}
      </div>
    </section>
  );
}

/** Right-aligned label for the 96px compose grid. */
function FieldLabel({
  children,
  alignTop,
}: {
  children: ReactNode;
  alignTop?: boolean;
}) {
  return (
    <label
      className={clsx(
        "text-right text-[11px] font-bold uppercase tracking-[0.08em] text-brand-gray",
        alignTop && "self-start pt-2",
      )}
    >
      {children}
    </label>
  );
}


/**
 * Build the default email subject + body from the meeting payload. We pull:
 *  - meeting_date for the subject and the opening line
 *  - first 5 open / pending action items for the "Key action items" bullets
 *  - closing_remarks (if any) as a sign-off line
 *
 * Conservative defaults: never invent content the PM didn't ask for. If a
 * section is empty we just omit it from the body.
 */
function buildEmailDefaults(
  meeting: MeetingDetail | null,
  clientName: string,
  projectName: string,
  emailSignature: string | null,
): { subject: string; body: string } {
  // Per-user email signature is appended after "Best,". When unset, we leave
  // the user's mail client / signature settings to fill it in.
  const sigBlock = emailSignature && emailSignature.trim() ? emailSignature.trimEnd() : "";
  if (!meeting) {
    return {
      subject: `Meeting Minutes — ${projectName}`,
      body:
        "Hello team,\n\n" +
        "Please find attached the meeting minutes from our coordination call.\n\n" +
        "Best,\n" +
        (sigBlock ? `${sigBlock}\n` : ""),
    };
  }

  const dateLabel = format(parseISO(meeting.meeting_date), "MMMM d, yyyy");
  const subject = `Meeting Minutes — ${projectName} — ${dateLabel}`;

  const lines: string[] = [];
  lines.push("Hello team,");
  lines.push("");
  lines.push(
    `Please find attached the meeting minutes from our ${dateLabel} ` +
      `${clientName ? `${clientName} / ` : ""}${projectName} coordination call.`,
  );

  // Prefer the AI executive summary as the body content when available —
  // it's already a polished paragraph that mentions the critical-path items
  // by name. Falls back to the legacy "first 5 open actions" block when
  // the summary is missing (e.g. older meetings, OpenAI hiccup on save).
  const summary = (meeting.executive_summary || "").trim();
  if (summary) {
    lines.push("");
    lines.push(summary);
  } else {
    const openActions = (meeting.raised_actions || [])
      .filter((a) => a.status === "open" || a.status === "pending")
      .slice(0, 5);
    if (openActions.length) {
      lines.push("");
      lines.push("Key open action items:");
      for (const a of openActions) {
        const owner = a.owner ? ` (${a.owner})` : "";
        const due = a.due_date ? ` — due ${format(parseISO(a.due_date), "M/d")}` : "";
        lines.push(`  • ${a.text}${owner}${due}`);
      }
    }
  }

  lines.push("");
  lines.push("Let me know if you have questions or corrections.");
  lines.push("");
  lines.push("Best,");
  if (sigBlock) {
    lines.push(sigBlock);
  }

  return { subject, body: lines.join("\n") };
}
