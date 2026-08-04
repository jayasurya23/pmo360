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
import { apiClient } from "./api";

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
  // Give the browser a moment to start the download before the URL dies.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

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
