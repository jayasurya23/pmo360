import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import {
  finalizeMeeting,
  finalizedFileUrl,
  meetingDocUrl,
  getMeeting,
  fetchMyPreferences,
  type UserPreferences,
} from "@/lib/api";
import type { MeetingDetail } from "@/lib/types";
import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";
import { sendMail, blobToBase64 } from "@/lib/graph";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

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

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Send meeting minutes"
        subtitle="Generate final, client-ready PDF + Word + Excel action log."
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

      <section className="card p-6">
        <h3 className="section-title mb-2">Finalize</h3>
        <p className="text-sm text-brand-gray mb-4">
          This will mark the meeting as <b>final</b>, regenerate all three
          deliverables, and save them under the project folder in storage.
        </p>
        <button
          className="btn-primary"
          disabled={busy || !!paths}
          onClick={handleFinalize}
        >
          {busy ? "Generating…" : paths ? "Generated" : "Generate final docs"}
        </button>
        {error && (
          <div className="mt-3 text-sm text-brand-red">{error}</div>
        )}
      </section>

      {paths && (
        <section className="card p-6">
          <h3 className="section-title mb-3">Downloads</h3>
          <div className="space-y-2">
            {Object.entries(paths).map(([kind, p]) => (
              <div
                key={kind}
                className="flex items-center justify-between py-2 border-b border-brand-lightgray/60 last:border-0"
              >
                <div>
                  <div className="text-sm font-medium">{kind.toUpperCase()}</div>
                  <div className="text-xs text-brand-gray break-all">{p}</div>
                </div>
                <a
                  className="btn-ghost"
                  href={finalizedFileUrl(p)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download
                </a>
              </div>
            ))}
          </div>
          <div className="mt-4 text-xs text-brand-gray">
            Or grab a fresh in-memory copy:{" "}
            <a
              className="text-brand-red font-semibold"
              href={meetingDocUrl(draftMeetingId!, "pdf")}
              target="_blank"
              rel="noreferrer"
            >
              PDF
            </a>{" "}
            ·{" "}
            <a
              className="text-brand-red font-semibold"
              href={meetingDocUrl(draftMeetingId!, "docx")}
              target="_blank"
              rel="noreferrer"
            >
              DOCX
            </a>{" "}
            ·{" "}
            <a
              className="text-brand-red font-semibold"
              href={meetingDocUrl(draftMeetingId!, "xlsx")}
              target="_blank"
              rel="noreferrer"
            >
              XLSX
            </a>
          </div>
        </section>
      )}

      {/* -------- Compose email (mailto: fallback) -------- */}
      <ComposeEmailSection
        meeting={meeting}
        clientName={currentClient?.name || ""}
        projectName={currentProject.name}
        pdfPath={paths?.pdf || null}
        meetingId={draftMeetingId}
      />
    </div>
  );
}


/* ============================================================
 * Compose email — mailto: fallback until Microsoft Graph email
 * lands in Phase 6. Pre-fills Subject + Body from the meeting,
 * opens the user's default mail client. They attach the PDF
 * themselves — mailto: cannot carry attachments (RFC 6068).
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
    const params = new URLSearchParams();
    if (composedCc.trim()) params.set("cc", composedCc.trim());
    if (subject) params.set("subject", subject);
    if (body) params.set("body", body);
    // Use comma between recipient list + ? before params (RFC 6068).
    const toPart = composedTo.trim();
    const query = params.toString();
    return `mailto:${encodeURIComponent(toPart)}${query ? `?${query}` : ""}`;
  }, [composedTo, composedCc, subject, body]);

  function handleResetDefaults() {
    setSubject(defaults.subject);
    setBody(defaults.body);
    setEdited(false);
  }

  function handleOpenMail() {
    // Download the PDF first so the user has it ready to attach. We open
    // the doc endpoint in a new tab — the browser will trigger the
    // Content-Disposition download. Then in the SAME click handler we
    // open the mailto: URL so the user's default mail client launches.
    if (pdfPath) {
      // finalized — use the saved file URL
      window.open(finalizedFileUrl(pdfPath), "_blank");
    } else if (meetingId) {
      // not finalized yet — pull a fresh in-memory copy
      window.open(meetingDocUrl(meetingId, "pdf"), "_blank");
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
      // 1. Pull the PDF bytes.
      const pdfUrl = pdfPath ? finalizedFileUrl(pdfPath) : meetingDocUrl(meetingId, "pdf");
      const pdfResp = await fetch(pdfUrl);
      if (!pdfResp.ok) throw new Error(`Couldn't fetch PDF: ${pdfResp.status}`);
      const pdfBlob = await pdfResp.blob();
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
    <section className="card p-6 space-y-3">
      <h3 className="section-title mb-1">Compose email</h3>
      {userPrefs?.auto_send_minutes_on_finalize && !sendOk && (
        <div className="text-xs rounded border border-sky-200 bg-sky-50 px-3 py-2 text-sky-900">
          ⚡ Auto-send is on — once you finalize above, the minutes will be
          emailed to all attendees with an address on file. Turn this off in
          Settings → Automation.
        </div>
      )}
      <p className="text-sm text-brand-gray">
        Tick the attendees you want to send to (only those with an email on
        file are checkable — add missing emails on the Capture page). Use the
        Additional fields for external recipients. Send via Microsoft Graph or
        open in Outlook as a fallback.
      </p>

      {/* Recipient picker — pulled from this meeting's attendees */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-brand-gray uppercase tracking-wider">
            Meeting attendees
          </div>
          <button
            type="button"
            className="text-xs underline underline-offset-2 text-brand-red hover:text-brand-darkred"
            onClick={replyAllAttendees}
            disabled={!attendees.some((a) => a.email)}
            title="Check every attendee who has an email on file"
          >
            ✉ Reply All to attendees
          </button>
        </div>
        {attendees.length === 0 ? (
          <div className="text-xs italic text-brand-gray">
            (No attendees on this meeting yet.)
          </div>
        ) : (
          <div className="card divide-y divide-brand-lightgray/60 max-h-64 overflow-y-auto">
            {attendees.map((a) => {
              const hasEmail = !!a.email;
              const inTo = toIds.has(a.id);
              const inCc = ccIds.has(a.id);
              return (
                <div
                  key={a.id}
                  className={clsx(
                    "px-3 py-2 grid grid-cols-[auto_auto_1fr] gap-3 items-center text-sm",
                    !hasEmail && "opacity-60"
                  )}
                  title={!hasEmail ? "No email on file" : undefined}
                >
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={inTo}
                      disabled={!hasEmail}
                      onChange={() => toggleTo(a.id)}
                    />
                    To
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={inCc}
                      disabled={!hasEmail}
                      onChange={() => toggleCc(a.id)}
                    />
                    Cc
                  </label>
                  <div className="text-sm">
                    <span className="font-medium text-brand-black">
                      {a.full_name}
                    </span>
                    <span className="text-brand-gray">
                      {" "}
                      ({a.initials})
                      {a.organization ? ` — ${a.organization}` : ""}
                    </span>
                    {hasEmail ? (
                      <span className="text-xs text-brand-gray">
                        {" · "}
                        {a.email}
                      </span>
                    ) : (
                      <span className="text-[11px] italic text-brand-gray ml-1">
                        (no email on file)
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-x-3 gap-y-2 items-center pt-2">
        <label className="text-xs font-semibold text-brand-gray sm:text-right">
          Additional To
        </label>
        <input
          className="input"
          placeholder="extra@example.com, other@example.com"
          value={toExtra}
          onChange={(e) => {
            setToExtra(e.target.value);
            setEdited(true);
          }}
        />

        <label className="text-xs font-semibold text-brand-gray sm:text-right">
          Additional Cc
        </label>
        <input
          className="input"
          placeholder="carol@example.com"
          value={ccExtra}
          onChange={(e) => {
            setCcExtra(e.target.value);
            setEdited(true);
          }}
        />

        <label className="text-xs font-semibold text-brand-gray sm:text-right">
          Subject
        </label>
        <input
          className="input"
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            setEdited(true);
          }}
        />

        <label className="text-xs font-semibold text-brand-gray sm:text-right pt-1">
          Body
        </label>
        <textarea
          className="textarea font-sans"
          rows={9}
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
          <div>
            <b>To:</b> {composedTo || <span className="italic">(none)</span>}
          </div>
          {composedCc && (
            <div>
              <b>Cc:</b> {composedCc}
            </div>
          )}
        </div>
      )}

      {sendError && (
        <div className="text-sm text-brand-red bg-rose-50 border border-rose-200 rounded px-3 py-2">
          {sendError}
        </div>
      )}
      {sendOk && (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
          ✓ Sent. Check your Sent Items folder in Outlook.
        </div>
      )}

      <div className="flex items-center justify-between pt-2 gap-2 flex-wrap">
        <button
          type="button"
          className="text-xs text-brand-gray underline underline-offset-2 hover:text-brand-red"
          onClick={handleResetDefaults}
          disabled={!edited}
        >
          Reset to defaults
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={handleOpenMail}
            disabled={!ready}
            title="Opens your default mail client with subject + body pre-filled; PDF downloads in a separate tab to attach manually."
          >
            ✉ Open in Outlook (mailto)
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
      </div>
      {!isAuthenticated && (
        <p className="text-xs text-brand-gray">
          One-click send requires sign-in. Use <b>Sign in</b> in the top right,
          then come back. The mailto fallback works without signing in.
        </p>
      )}
    </section>
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
