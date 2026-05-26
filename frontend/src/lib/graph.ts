/**
 * Microsoft Graph helpers — direct browser → Graph calls, authenticated with
 * the MSAL-acquired access token.
 *
 * We hit Graph directly from the SPA rather than proxying through our own
 * backend. Trade-offs:
 *   PRO: simpler — no backend Graph code, no OBO token exchange
 *   PRO: Microsoft auto-throttles per-user, not per-our-app
 *   CON: client gets a Graph-scoped token, so the same UI code can only
 *        talk to Graph (not to other vendors that would need different
 *        token audiences). Fine for our scope.
 *
 * Throws on non-2xx responses with a readable message.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body && !(init.body instanceof Blob)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let message = `Graph ${res.status}`;
    try {
      const body = await res.json();
      const inner = body?.error?.message || body?.error || JSON.stringify(body);
      message = `Graph ${res.status}: ${inner}`;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return res;
}


/* ============================================================
 * /me/sendMail — Mail.Send delegated scope
 * ============================================================ */
export interface SendMailArgs {
  to: string;         // comma-separated email addresses
  cc?: string;
  subject: string;
  body: string;       // plain text — Graph wraps it as text/plain
  attachments?: SendMailAttachment[];
}

export interface SendMailAttachment {
  name: string;          // filename including extension
  contentType: string;   // mime type, e.g. application/pdf
  /** Base64-encoded bytes. NO data: prefix — just the base64 payload. */
  contentBytesBase64: string;
}

function splitRecipients(raw: string): { emailAddress: { address: string } }[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

export async function sendMail(args: SendMailArgs, token: string): Promise<void> {
  const payload = {
    message: {
      subject: args.subject,
      body: { contentType: "Text", content: args.body },
      toRecipients: splitRecipients(args.to),
      ccRecipients: splitRecipients(args.cc || ""),
      attachments: (args.attachments || []).map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.contentBytesBase64,
      })),
    },
    saveToSentItems: true,
  };
  await graphFetch("/me/sendMail", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}


/* ============================================================
 * OneDrive / SharePoint file upload — Files.ReadWrite scope
 * ============================================================ */

/**
 * Upload bytes to a path under the signed-in user's OneDrive root.
 * For files <4MB we use the simple single-shot PUT. Anything larger should
 * use Graph's resumable-upload session, which we haven't needed yet.
 *
 * `path` is the file path relative to the OneDrive root, e.g.
 * `CastilloPMO/Snapdragon/Meeting_Minutes_2026-05-19.pdf`. Subfolders are
 * created automatically.
 */
export async function uploadToOneDrive(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  token: string,
): Promise<{ webUrl: string; id: string }> {
  if (bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error(
      "uploadToOneDrive: payload >4MB requires resumable upload session — not yet implemented.",
    );
  }
  // Path-based upload: PUT /me/drive/root:/<path>:/content
  // Graph wants the path URL-encoded but with `/` preserved as path separator.
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  // Slice to a plain ArrayBuffer so TS's strict BlobPart typing accepts it —
  // Uint8Array's typed-array view is technically `ArrayBufferLike` (could be
  // a SharedArrayBuffer) and lib.dom rejects that.
  const blob = new Blob([bytes.slice().buffer], { type: contentType });
  const res = await graphFetch(
    `/me/drive/root:/${encodedPath}:/content`,
    token,
    {
      method: "PUT",
      body: blob,
      // Don't let graphFetch auto-set JSON content type
      headers: { "Content-Type": contentType },
    },
  );
  const data = await res.json();
  return { webUrl: data.webUrl, id: data.id };
}


/* ============================================================
 * /users — directory browse (User.Read.All scope)
 * ============================================================ */
export interface DirectoryUser {
  /** Microsoft Entra object id — stable across the tenant. */
  id: string;
  displayName: string;
  /** UPN — usually `first.last@company.com`. */
  userPrincipalName: string;
  /** mail might be unset for newly-provisioned accounts; fall back to UPN. */
  mail?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  /** False for disabled accounts. We default the filter to true. */
  accountEnabled?: boolean;
  /** "Member" for employees, "Guest" for external. We filter to Member. */
  userType?: string | null;
  /** Empty array for shared mailboxes / unlicensed accounts. */
  assignedLicenses?: { skuId: string; disabledPlans?: string[] }[];
}

/**
 * Page through `/users` and return the full set.
 *
 * Options:
 *  - `activeOnly` (default true): only return users where
 *    `accountEnabled === true` AND `userType === 'Member'` AND they have
 *    at least one assigned license. This is the right filter for "real
 *    current Castillo employees with M365/Teams" — it excludes:
 *      * disabled accounts (ex-employees not yet purged)
 *      * Guest accounts (external collaborators)
 *      * shared mailboxes (no license)
 *      * room / equipment resources (no license)
 *  - `pageSize` defaults to 100. Graph caps at 999.
 *  - `maxPages` caps the walk at ~5,000 users.
 *
 * We push the `accountEnabled` + `userType` filters server-side via
 * `$filter` so Graph returns less data; the license check has to be
 * client-side because Graph doesn't support `$filter` on
 * `assignedLicenses` in the standard query API.
 *
 * Throws on non-2xx — the UI surfaces an "admin consent required" hint
 * when the response mentions insufficient privileges.
 */
export async function listOrgDirectory(
  token: string,
  options: {
    pageSize?: number;
    maxPages?: number;
    activeOnly?: boolean;
  } = {},
): Promise<DirectoryUser[]> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 5;
  const activeOnly = options.activeOnly ?? true;
  const select =
    "id,displayName,userPrincipalName,mail,jobTitle,department," +
    "accountEnabled,userType,assignedLicenses";

  // Server-side filter on the cheaply-filterable properties. We can't put
  // `assignedLicenses/any(...)` here — Graph rejects $filter on collection
  // properties of complex types in the default query. License check
  // happens client-side below.
  const filterParts: string[] = [];
  if (activeOnly) {
    filterParts.push("accountEnabled eq true");
    filterParts.push("userType eq 'Member'");
  }
  const filterQuery = filterParts.length
    ? `&$filter=${encodeURIComponent(filterParts.join(" and "))}`
    : "";
  // Graph requires ConsistencyLevel=eventual + $count=true for $filter on
  // some properties. Cheap to include even when unused.
  let url: string | null =
    `/users?$top=${pageSize}&$select=${select}&$orderby=displayName&$count=true${filterQuery}`;

  const out: DirectoryUser[] = [];
  let pages = 0;

  while (url && pages < maxPages) {
    const res = await graphFetch(url, token, {
      headers: { ConsistencyLevel: "eventual" },
    });
    const data = await res.json();
    for (const u of data.value || []) {
      out.push(u as DirectoryUser);
    }
    // Graph returns `@odata.nextLink` as a full URL — strip the host so
    // graphFetch can prepend GRAPH_BASE again.
    const next: string | undefined = data["@odata.nextLink"];
    if (next) {
      const m = next.match(/^https?:\/\/[^/]+\/v1\.0(\/.+)$/);
      url = m ? m[1] : null;
    } else {
      url = null;
    }
    pages++;
  }

  // Final client-side filter: drop entries with zero licenses. Empty
  // `assignedLicenses` means unlicensed (shared mailbox, resource account,
  // or an admin-only account). Any license at all is enough — Teams is
  // bundled with every M365 SKU Castillo would issue to a real PM.
  if (activeOnly) {
    return out.filter(
      (u) => (u.assignedLicenses?.length || 0) > 0,
    );
  }
  return out;
}


/* ============================================================
 * Helpers
 * ============================================================ */

/** Convert a Blob (e.g. a fetched PDF) into a base64 string suitable for
 *  passing as a Graph `contentBytes` attachment field. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return uint8ToBase64(new Uint8Array(buf));
}

/** Chunked base64 encode — `btoa(String.fromCharCode(...bytes))` blows the
 *  stack on large payloads. We chunk at 32k bytes per pass. */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bytes.subarray(i, i + CHUNK) as any,
    );
  }
  return btoa(binary);
}
