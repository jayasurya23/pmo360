/**
 * Authed access to generated meeting documents.
 *
 * `meetingDocUrl()` in api.ts returns a bare URL for the browser to load
 * directly — an `<a href>`, an `<iframe>`, `window.open`, pdf.js. That worked
 * until PR #53 put `require_db_user` on `GET /api/documents/meeting/{id}`:
 * none of those carry the MSAL bearer token, so every one of them started
 * answering 401 and meeting minutes became un-previewable and un-downloadable
 * in production. The endpoint was correctly protected the whole time; it was
 * simply unreachable from the app.
 *
 * The fix is the pattern the proposal PDF already uses (`fetchProposalPdfBlob`)
 * — pull the bytes through the axios client, which attaches the token, and
 * hand back a Blob the caller turns into an object URL. An object URL is
 * same-origin and needs no header, so `<iframe>`, pdf.js and a download anchor
 * all work again unchanged.
 *
 * `meetingDocUrl` deliberately still exists: it is the right thing for a
 * caller that genuinely has cookie auth, and deleting it would only push
 * somebody to rebuild the string by hand. Anything rendering in THIS app
 * should use the helpers here.
 */
import { useEffect, useState } from "react";
import { actionScopeParams, apiClient } from "./api";
import type { ActionScope } from "./types";

export type MeetingDocKind = "pdf" | "docx" | "xlsx" | "zip";

/** Pull `Content-Disposition: attachment; filename="…"` off the response so a
 *  saved file keeps the name the backend generated (which leads with the
 *  project name). A blob download otherwise lands as "download". */
function filenameFrom(disposition: unknown, fallback: string): string {
  if (typeof disposition !== "string") return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1]?.trim() || fallback;
}

/** The document bytes plus the filename the server chose for them. */
export async function fetchMeetingDoc(
  meetingId: number,
  kind: MeetingDocKind,
): Promise<{ blob: Blob; filename: string }> {
  const res = await apiClient.get(`/documents/meeting/${meetingId}`, {
    params: { kind },
    responseType: "blob",
  });
  return {
    blob: res.data as Blob,
    filename: filenameFrom(
      res.headers?.["content-disposition"],
      `meeting-${meetingId}.${kind}`,
    ),
  };
}

/** Just the bytes, for callers that re-encode them (the Graph send attaches
 *  the PDF as base64 rather than showing it). */
export async function fetchMeetingDocBlob(
  meetingId: number,
  kind: MeetingDocKind,
): Promise<Blob> {
  return (await fetchMeetingDoc(meetingId, kind)).blob;
}

/**
 * Fetch any authed endpoint and save the bytes as a file.
 *
 * THE GENERAL CASE, because the meeting-documents 401 was not a one-off. Four
 * places in this app built an `${API_BASE}/...` string and handed it to an
 * `<a href>`; every one of those routes requires a bearer token an anchor
 * cannot send, so every one of them answered 401. PR #67 fixed the first and
 * left three — meeting attachments, the Actions CSV export and the agenda
 * .ics — which had been quietly broken since the auth sweep on 2026-07-29.
 *
 * Everything that downloads should come through here so there is one place to
 * be wrong instead of five.
 */
export async function saveFromApi(
  path: string,
  fallbackName: string,
  params?: Record<string, string | number | undefined>,
): Promise<void> {
  const res = await apiClient.get(path, { params, responseType: "blob" });
  const filename = filenameFrom(
    res.headers?.["content-disposition"],
    fallbackName,
  );
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL dies.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Fetch and save. Replaces `<a href={meetingDocUrl(...)} download>`, which
 *  cannot send the token. */
export async function saveMeetingDoc(
  meetingId: number,
  kind: MeetingDocKind,
): Promise<void> {
  const { blob, filename } = await fetchMeetingDoc(meetingId, kind);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A meeting attachment. Worst of the three that PR #67 missed: the prod
 *  import filed every original meeting-minutes PDF through this API, so every
 *  imported meeting had an original nobody could open. */
export const saveAttachment = (id: number, name?: string) =>
  saveFromApi(`/attachments/${id}/download`, name || `attachment-${id}`);

/**
 * The Actions page CSV export.
 *
 * MUST be handed the scope the table is currently showing, not the header's
 * selection: an export that ignores scope hands a PM reviewing one portfolio
 * either a different portfolio or every client in the company, and the file
 * looks entirely plausible either way. `actionScopeParams` is the same builder
 * the list call uses, so the two cannot drift.
 *
 * Whichever id the scope doesn't need is omitted entirely rather than sent as
 * null — the backend reads absence, not a null. The fallback filename here is
 * only ever used if the response arrives without a Content-Disposition; the
 * server names the file after the scope so the download is self-identifying.
 *
 * The owner filter has to travel by the SAME key the table filtered on.
 * `ownerUserId` is the canonical User link, which is what the page's "Mine"
 * filter matches; `owner` is the free-text string. Sending the name for a
 * screen filtered by link swaps rows in both directions — a row reading
 * "D. Wraga" linked to Dylan drops out, a stale "Dylan Wraga" with no link
 * appears — and the row counts can match, so nothing on screen or in the file
 * gives the substitution away.
 */
export const saveActionsCsv = (
  scope: number | ActionScope | null,
  status = "all",
  owner = "",
  ownerUserId: number | null = null,
) =>
  saveFromApi("/actions/export.csv", "actions.csv", {
    status,
    ...actionScopeParams(scope),
    ...(ownerUserId != null
      ? { owner_user_id: ownerUserId }
      : owner
        ? { owner }
        : {}),
  });

/** The pre-meeting agenda .ics. */
export const saveAgendaIcs = (agendaId: number) =>
  saveFromApi(`/agendas/${agendaId}/ics`, `agenda-${agendaId}.ics`);

/**
 * An object URL for previewing a document inline, or null while it loads.
 *
 * Revoked when the meeting changes or the component unmounts — an object URL
 * pins its blob in memory until revoked, and a 1 MB PDF re-fetched on every
 * navigation adds up over a working day.
 */
export function useMeetingDocUrl(
  meetingId: number | null | undefined,
  kind: MeetingDocKind,
): { url: string | null; error: string | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!meetingId) {
      setUrl(null);
      setError(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setError(null);
    fetchMeetingDocBlob(meetingId, kind)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setUrl(null);
        setError(e?.message || "Could not load the document.");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [meetingId, kind]);

  return { url, error };
}
