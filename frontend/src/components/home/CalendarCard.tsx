/**
 * CalendarCard — "📅 Upcoming meetings" on Home, v2.
 *
 * Design goals from the v1 rebuild:
 *   - Always surfaces SOMETHING, even when MSAL/Graph/our backend is misbehaving.
 *     v1 silently degraded to a confusing "Authentication required" with no
 *     path forward. v2 shows a state-appropriate CTA or error every time.
 *   - PM can manually pin an event to any portfolio when our auto-match got
 *     it wrong, and the link sticks across refreshes.
 *   - The signed-out case still shows the card with a "Sign in to connect
 *     your calendar" CTA — discoverability over hiding.
 *   - Errors carry actionable next steps ("AADSTS500011: ask your admin to
 *     grant API consent in Azure"), not just raw exception text.
 *
 * The component owns four state buckets:
 *   1. `phase`               — high-level UI state machine
 *   2. `events` / `matches`  — payload from Graph + our /match endpoint
 *   3. `pendingLinkFor`      — graph event id whose manual picker is open
 *   4. `errorDetail`         — structured error info for friendly rendering
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format, parseISO, isToday, isTomorrow } from "date-fns";

import { useAuth } from "@/auth/useAuth";
import { useApp } from "@/lib/state";
import {
  listUpcomingEvents,
  type CalendarEvent,
} from "@/lib/graph";
import {
  matchCalendarEvents,
  linkCalendarEvent,
  unlinkCalendarEvent,
  listAllPortfolios,
  type CalendarMatchOut,
} from "@/lib/api";
import { nameToSlug } from "@/lib/slugs";
import type { Project } from "@/lib/types";

/** High-level state of the card. Drives which subtree we render. */
type Phase =
  | "signed-out"      // user isn't authenticated → soft CTA
  | "idle"            // signed in, never tried fetching yet
  | "loading"         // fetch in flight
  | "needs-consent"   // MSAL InteractionRequired — pop the popup
  | "loaded"          // events + matches present
  | "empty"           // signed in, fetch ok, but zero events in window
  | "error";          // unrecoverable failure — show friendly message

/** Structured error info so we can show actionable hints, not just raw text. */
interface ErrorDetail {
  message: string;          // headline
  hint?: string;            // longer paragraph rendered below
  actionLabel?: string;     // optional retry button label
  azure?: boolean;          // true when the fix is on the Azure side (we surface a docs hint)
}

interface EventRow {
  event: CalendarEvent;
  match: CalendarMatchOut;
  /** True when every non-organizer attendee is on the Castillo domain —
   *  signals an internal sync, which gets a softer "🏢 Internal" pill and
   *  doesn't show a portfolio-match badge (matching internal syncs to
   *  client portfolios is almost always wrong). PMs can still build an
   *  agenda from one if they want; we just de-emphasise. */
  isInternal: boolean;
}

/** Domain we treat as "Castillo internal" for the internal-event heuristic.
 *  Hardcoded for now — extend to multiple domains if Castillo ever acquires
 *  or rebrands. */
const INTERNAL_EMAIL_DOMAIN = "@castillope.com";

function classifyInternal(emails: string[]): boolean {
  // No attendees at all → it's a personal block (focus time, OOO). Treat
  // as internal so it gets the same de-emphasis.
  if (emails.length === 0) return true;
  return emails.every((e) =>
    e.toLowerCase().trim().endsWith(INTERNAL_EMAIL_DOMAIN),
  );
}


export default function CalendarCard() {
  const { isAuthenticated, user, getCalendarToken } = useAuth();
  const { clients } = useApp();
  const nav = useNavigate();

  const [phase, setPhase] = useState<Phase>(
    isAuthenticated ? "idle" : "signed-out",
  );
  const [rows, setRows] = useState<EventRow[]>([]);
  const [errorDetail, setErrorDetail] = useState<ErrorDetail | null>(null);

  // All portfolios across all clients — populated once for the manual
  // override picker. We don't fetch this until the user actually opens
  // a picker (saves a request on the cold-start render).
  const [portfolios, setPortfolios] = useState<Project[] | null>(null);
  const [pendingLinkFor, setPendingLinkFor] = useState<string | null>(null);

  // Reset to signed-out when the user signs out mid-session
  useEffect(() => {
    if (!isAuthenticated) {
      setPhase("signed-out");
      setRows([]);
      setErrorDetail(null);
    } else if (phase === "signed-out") {
      setPhase("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  const load = useCallback(
    async (opts: { popupOk?: boolean } = {}) => {
      if (!isAuthenticated) return;
      setPhase("loading");
      setErrorDetail(null);
      try {
        const token = await getCalendarToken();
        const events = await listUpcomingEvents(token, {
          signedInEmail: user?.email,
          daysAhead: 14,
        });
        if (events.length === 0) {
          setRows([]);
          setPhase("empty");
          return;
        }
        const matches = await matchCalendarEvents(
          events.map((ev) => ({
            key: ev.id,
            subject: ev.subject,
            attendee_emails: ev.attendeeEmails,
          })),
        );
        const byKey = new Map(matches.map((m) => [m.key, m]));
        setRows(
          events.map((ev) => ({
            event: ev,
            match:
              byKey.get(ev.id) ??
              ({
                key: ev.id,
                project_id: null,
                project_name: null,
                client_name: null,
                match_reason: null,
                is_manual: false,
              } satisfies CalendarMatchOut),
            isInternal: classifyInternal(ev.attendeeEmails),
          })),
        );
        setPhase("loaded");
      } catch (err: any) {
        setErrorDetail(diagnoseError(err));
        const message: string = err?.message || "";
        if (/interaction_required|user_cancelled|consent/i.test(message)) {
          setPhase("needs-consent");
        } else {
          setPhase("error");
        }
        // If popupOk and we got InteractionRequired, the consent prompt
        // should already be triggered downstream — useAuth handles popup.
        // Otherwise we leave the CTA visible for the user to click.
        void opts; // currently unused, kept for future "force popup" calls
      }
    },
    [isAuthenticated, getCalendarToken, user?.email],
  );

  // First load: signed-in users get an immediate auto-load. Failures bubble
  // up into the appropriate phase — we never silently leave the card blank.
  useEffect(() => {
    if (phase === "idle") void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Lazy-load the cross-client portfolio list on first open of any manual
  // picker. Cached for the rest of the session.
  const ensurePortfolios = useCallback(async () => {
    if (portfolios !== null) return portfolios;
    const ps = await listAllPortfolios(false);
    setPortfolios(ps);
    return ps;
  }, [portfolios]);

  // Handlers for the per-row manual override flow
  const onPickPortfolio = useCallback(
    async (graphEventId: string, projectId: number) => {
      try {
        const link = await linkCalendarEvent(graphEventId, projectId);
        // Splice the new match back onto the row in place — no full reload.
        setRows((rs) =>
          rs.map((r) =>
            r.event.id === graphEventId
              ? {
                  ...r,
                  match: {
                    key: graphEventId,
                    project_id: link.project_id,
                    project_name: link.project_name,
                    client_name: link.client_name,
                    match_reason: "manual",
                    is_manual: true,
                  },
                  // PM explicitly linked an internal-looking event to a
                  // portfolio — un-flag the internal heuristic so the row
                  // looks like a normal client meeting now.
                  isInternal: false,
                }
              : r,
          ),
        );
        setPendingLinkFor(null);
      } catch (err: any) {
        // eslint-disable-next-line no-alert
        alert(`Couldn't save link: ${err?.message || err}`);
      }
    },
    [],
  );

  const onUnlink = useCallback(async (graphEventId: string) => {
    try {
      await unlinkCalendarEvent(graphEventId);
      // After unlink we don't know what the heuristic match would be
      // without a fresh /match call; refresh just this row's row by
      // re-running the whole load. Cheap enough since 14 days × ~50
      // events stays small.
      void load();
    } catch (err: any) {
      // eslint-disable-next-line no-alert
      alert(`Couldn't remove link: ${err?.message || err}`);
    }
  }, [load]);

  const groups = useMemo(() => groupByDay(rows), [rows]);

  // ============================================================
  // Render
  // ============================================================
  return (
    <div className="card p-5 border-l-4 border-l-[#185fa5] bg-gradient-to-r from-sky-50/40 to-white">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
            Upcoming meetings
          </div>
          <div className="text-base font-semibold text-brand-black mt-1">
            📅 Next 14 days from Outlook
          </div>
        </div>
        {phase !== "signed-out" && (
          <button
            type="button"
            onClick={() => load()}
            disabled={phase === "loading"}
            className="text-xs text-brand-gray hover:text-brand-black px-2 py-1 rounded hover:bg-brand-nearwhite/60 disabled:opacity-40"
            title="Refresh from Outlook"
          >
            {phase === "loading" ? "Loading…" : "↻ Refresh"}
          </button>
        )}
      </div>

      <div className="mt-3 space-y-3">
        {phase === "signed-out" && <SignedOutCta />}
        {phase === "needs-consent" && (
          <ConsentCta onConnect={() => load({ popupOk: true })} />
        )}
        {phase === "error" && errorDetail && (
          <ErrorBlock detail={errorDetail} onRetry={() => load()} />
        )}
        {phase === "loading" && rows.length === 0 && <SkeletonRow />}
        {phase === "empty" && (
          <div className="text-sm text-brand-gray italic">
            Nothing on your calendar in the next two weeks. Try adding
            attendees from a portfolio's roster to your Outlook meetings
            so we can auto-link them next time.
          </div>
        )}

        {(phase === "loaded" || phase === "loading") && groups.length > 0 && (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="text-[11px] uppercase tracking-wider text-brand-gray font-semibold mb-1">
                  {g.label}
                </div>
                <div className="card divide-y divide-brand-lightgray/60">
                  {g.rows.map(({ event, match, isInternal }) => (
                    <EventRowItem
                      key={event.id}
                      event={event}
                      match={match}
                      isInternal={isInternal}
                      pickerOpen={pendingLinkFor === event.id}
                      onTogglePicker={async () => {
                        const next =
                          pendingLinkFor === event.id ? null : event.id;
                        if (next) {
                          await ensurePortfolios();
                        }
                        setPendingLinkFor(next);
                      }}
                      portfolios={portfolios || []}
                      onPickPortfolio={(pid) =>
                        onPickPortfolio(event.id, pid)
                      }
                      onUnlink={() => onUnlink(event.id)}
                      onBuildAgenda={() =>
                        nav(buildAgendaHref(event, match, clients))
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


/* ============================================================
 * Sub-states
 * ============================================================ */

function SignedOutCta() {
  return (
    <div className="flex items-center justify-between gap-3 bg-sky-50 border border-sky-200 rounded px-3 py-2">
      <div className="text-sm text-sky-900">
        Sign in with your Castillo account to see upcoming Outlook meetings
        and pre-fill agendas from them.
      </div>
    </div>
  );
}


function ConsentCta({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-sky-50 border border-sky-200 rounded px-3 py-2">
      <div className="text-sm text-sky-900">
        Connect your Outlook calendar so we can list your next two weeks of
        meetings and link them to portfolios.
      </div>
      <button
        type="button"
        onClick={onConnect}
        className="btn-primary text-xs px-3 py-1.5 whitespace-nowrap"
      >
        Connect calendar
      </button>
    </div>
  );
}


function ErrorBlock({
  detail,
  onRetry,
}: {
  detail: ErrorDetail;
  onRetry: () => void;
}) {
  return (
    <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
      <div className="font-semibold">{detail.message}</div>
      {detail.hint && (
        <div className="mt-1 text-xs text-rose-800 leading-relaxed">
          {detail.hint}
        </div>
      )}
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="text-xs underline text-rose-900 hover:text-rose-700"
        >
          {detail.actionLabel || "Try again"}
        </button>
        {detail.azure && (
          <span className="text-[11px] text-rose-800/80">
            Azure portal → App registrations → API permissions / Expose an API
          </span>
        )}
      </div>
    </div>
  );
}


function SkeletonRow() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-24 bg-slate-200/70 rounded animate-pulse" />
      <div className="card divide-y divide-brand-lightgray/60">
        {[0, 1].map((i) => (
          <div key={i} className="px-5 py-3 space-y-2">
            <div className="h-4 w-3/4 bg-slate-200/70 rounded animate-pulse" />
            <div className="h-3 w-1/2 bg-slate-100 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}


/* ============================================================
 * Single row + manual override picker
 * ============================================================ */

function EventRowItem({
  event,
  match,
  isInternal,
  pickerOpen,
  onTogglePicker,
  portfolios,
  onPickPortfolio,
  onUnlink,
  onBuildAgenda,
}: {
  event: CalendarEvent;
  match: CalendarMatchOut;
  isInternal: boolean;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  portfolios: Project[];
  onPickPortfolio: (projectId: number) => void;
  onUnlink: () => void;
  onBuildAgenda: () => void;
}) {
  const start = event.startUtc ? parseISO(event.startUtc) : null;
  const end = event.endUtc ? parseISO(event.endUtc) : null;
  const timeText = event.isAllDay
    ? "All day"
    : start && end
    ? `${format(start, "h:mm a")} – ${format(end, "h:mm a")}`
    : start
    ? format(start, "h:mm a")
    : "";

  const matchedTo =
    match.project_id && match.project_name
      ? `${match.client_name ? match.client_name + " / " : ""}${
          match.project_name
        }`
      : null;

  return (
    <div className="px-5 py-3">
      <div className="grid grid-cols-[1fr_auto] gap-3 items-start">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-brand-black truncate">
              {event.subject || "(no subject)"}
            </div>
            {event.onlineProvider && (
              <span
                className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded"
                style={{ background: "#e6effc", color: "#185fa5" }}
                title={`Online meeting (${event.onlineProvider})`}
              >
                Online
              </span>
            )}
          </div>
          <div className="text-xs text-brand-gray mt-0.5 truncate">
            {timeText}
            {event.organizerName ? ` · Organised by ${event.organizerName}` : ""}
          </div>

          {/* Match status + manual override toggle */}
          <div className="text-xs mt-1 flex items-center gap-2 flex-wrap">
            {matchedTo ? (
              <>
                <MatchBadge match={match} />
                <span className="text-brand-black">{matchedTo}</span>
                <button
                  type="button"
                  onClick={onTogglePicker}
                  className="text-[11px] underline text-brand-gray hover:text-brand-black"
                >
                  {pickerOpen ? "Cancel" : "Change"}
                </button>
                {match.is_manual && (
                  <button
                    type="button"
                    onClick={onUnlink}
                    className="text-[11px] underline text-brand-gray hover:text-brand-black"
                    title="Remove the manual link — falls back to auto-match"
                  >
                    Remove link
                  </button>
                )}
              </>
            ) : isInternal ? (
              // Internal-only meeting: skip the "Unmatched" amber pill +
              // "Pick a portfolio" prompt — almost always wrong to bind
              // an internal sync to a client portfolio. PM can still click
              // "Change" to override if this one really is portfolio-related.
              <>
                <span
                  className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600"
                  title="All attendees are on the Castillo domain — treated as an internal sync, not a client meeting."
                >
                  🏢 Internal
                </span>
                <button
                  type="button"
                  onClick={onTogglePicker}
                  className="text-[11px] underline text-brand-gray hover:text-brand-black"
                >
                  {pickerOpen ? "Cancel" : "Link to portfolio"}
                </button>
              </>
            ) : (
              <>
                <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                  Unmatched
                </span>
                <button
                  type="button"
                  onClick={onTogglePicker}
                  className="text-[11px] underline text-amber-900 hover:text-amber-700"
                >
                  {pickerOpen ? "Cancel" : "Pick a portfolio"}
                </button>
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onBuildAgenda}
          disabled={!match.project_id}
          className="btn-ghost text-xs whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
          title={
            match.project_id
              ? "Pre-fill a pre-meeting agenda from this event"
              : "Pick a portfolio first so we know where the agenda belongs"
          }
        >
          Build agenda →
        </button>
      </div>

      {pickerOpen && (
        <ManualPortfolioPicker
          portfolios={portfolios}
          onPick={onPickPortfolio}
        />
      )}
    </div>
  );
}


function MatchBadge({ match }: { match: CalendarMatchOut }) {
  if (match.is_manual) {
    return (
      <span
        className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800"
        title="You manually linked this event to a portfolio."
      >
        ✓ Linked
      </span>
    );
  }
  if (match.match_reason === "email") {
    return (
      <span
        className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-sky-100 text-sky-800"
        title="Matched by an attendee email in the portfolio's roster."
      >
        Auto · email
      </span>
    );
  }
  if (match.match_reason === "subject") {
    return (
      <span
        className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800"
        title="Matched by the portfolio name appearing in the event subject. Lower confidence — review and pin manually if needed."
      >
        Auto · subject
      </span>
    );
  }
  return null;
}


function ManualPortfolioPicker({
  portfolios,
  onPick,
}: {
  portfolios: Project[];
  onPick: (projectId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const { clients } = useApp();
  const clientMap = useMemo(
    () => new Map(clients.map((c) => [c.id, c.name])),
    [clients],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const decorated = portfolios.map((p) => ({
      p,
      clientName: clientMap.get(p.client_id) || "",
    }));
    if (!q) return decorated;
    return decorated.filter(
      (d) =>
        d.p.name.toLowerCase().includes(q) ||
        d.clientName.toLowerCase().includes(q),
    );
  }, [portfolios, query, clientMap]);

  return (
    <div className="mt-2 rounded border border-slate-200 bg-white p-2 space-y-2">
      <input
        type="text"
        autoFocus
        placeholder="Search portfolios…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full px-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-brand-red/30"
      />
      <div className="max-h-48 overflow-y-auto">
        {portfolios.length === 0 ? (
          <div className="text-xs text-brand-gray italic px-2 py-1">
            Loading portfolios…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-brand-gray italic px-2 py-1">
            No portfolios match "{query}".
          </div>
        ) : (
          filtered.slice(0, 20).map(({ p, clientName }) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.id)}
              className="block w-full text-left px-2 py-1 rounded hover:bg-brand-nearwhite/60 text-xs"
            >
              <span className="text-brand-gray">{clientName} / </span>
              <span className="font-medium text-brand-black">{p.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}


/* ============================================================
 * Helpers
 * ============================================================ */

interface DayGroup {
  label: string;
  rows: EventRow[];
}

function groupByDay(rows: EventRow[]): DayGroup[] {
  const map = new Map<string, EventRow[]>();
  for (const r of rows) {
    if (!r.event.startUtc) continue;
    const start = parseISO(r.event.startUtc);
    const key = format(start, "yyyy-MM-dd");
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  const out: DayGroup[] = [];
  for (const [key, list] of map.entries()) {
    const d = parseISO(key + "T00:00:00Z");
    const label = isToday(d)
      ? "Today"
      : isTomorrow(d)
      ? "Tomorrow"
      : format(d, "EEEE, MMM d");
    out.push({ label, rows: list });
  }
  return out;
}


/** Map exceptions from MSAL / our /match call into a friendly ErrorDetail
 *  with actionable next steps. Goal: never make the PM google an AADSTS code. */
function diagnoseError(err: any): ErrorDetail {
  const message: string = err?.message || String(err);
  const status: number | undefined = err?.status;

  // AADSTS500011 — "Expose an API" hasn't been wired up yet (or the
  // app's self-API permission needs admin consent). Surface a clear hint.
  if (/AADSTS500011/i.test(message)) {
    return {
      message: "Outlook can't talk to PMO 360 yet.",
      hint:
        "Your tenant needs the PMO 360 app's own API consented to. Ask an admin: Azure portal → App registrations → PMO 360 dev → Expose an API → Add scope; then API permissions → My APIs → PMO 360 → access_as_user → Grant admin consent.",
      azure: true,
    };
  }
  // AADSTS50058 — silent sign-in failed; cookies blocked or refresh token stale.
  if (/AADSTS50058/i.test(message)) {
    return {
      message: "Sign-in session expired.",
      hint:
        "Sign out and sign back in (gear icon → Sign out). If that doesn't help, your browser may be blocking third-party cookies for login.microsoftonline.com.",
    };
  }
  // Our backend rejecting the JWT.
  if (status === 401 || /Authentication required|Invalid token/i.test(message)) {
    return {
      message: "Backend didn't accept your Outlook sign-in.",
      hint:
        "This usually means MSAL didn't get a valid token. Try signing out and back in. If it persists, an Azure admin needs to grant API consent (Azure portal → App registrations → PMO 360 → API permissions → Grant admin consent).",
      azure: true,
    };
  }
  // Generic
  return {
    message: "Couldn't load your calendar.",
    hint: message,
  };
}


function buildAgendaHref(
  event: CalendarEvent,
  match: CalendarMatchOut,
  clients: { id: number; name: string }[],
): string {
  if (!match.project_id) return "/next-agenda";
  const client = match.client_name
    ? clients.find((c) => c.name === match.client_name)
    : null;
  const clientSlug = client ? nameToSlug(client.name) : "";
  const portfolioSlug = match.project_name ? nameToSlug(match.project_name) : "";
  const date = event.startUtc
    ? format(parseISO(event.startUtc), "yyyy-MM-dd")
    : "";
  const params = new URLSearchParams();
  if (clientSlug) params.set("client", clientSlug);
  if (portfolioSlug) params.set("portfolio", portfolioSlug);
  if (date) params.set("date", date);
  if (event.subject) params.set("title", event.subject);
  // Pass the cross-event attendee emails so NextAgenda can map them to
  // roster entries server-side (Light field detail per the design call).
  if (event.attendeeEmails.length) {
    params.set("attendees", event.attendeeEmails.join(","));
  }
  params.set("source", "calendar");
  return `/next-agenda?${params.toString()}`;
}
