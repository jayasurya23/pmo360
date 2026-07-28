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
import clsx from "clsx";
import {
  format,
  parseISO,
  isToday,
  isTomorrow,
  startOfDay,
  addDays,
  isWeekend,
} from "date-fns";

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


/** How far forward the card looks: one week (7 days from today). Weekend
 *  days are filtered out of the rendered list (groupByDay) so only workdays
 *  show. Used for both the Graph query window and the day list so they stay
 *  in sync. */
const HORIZON_DAYS = 7;

/** localStorage key for the persisted minimized state of the card. */
const MINIMIZED_KEY = "pmo360.calendarCard.minimized";


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

  // Card collapse + day-range. `minimized` hides the body and persists across
  // sessions (a PM who keeps it collapsed shouldn't have to re-collapse every
  // visit). `expandedWeek` switches the body between today-only (default) and
  // the full Mon–Fri week; it's per-view, not persisted.
  const [minimized, setMinimized] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MINIMIZED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [expandedWeek, setExpandedWeek] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(MINIMIZED_KEY, minimized ? "1" : "0");
    } catch {
      /* private mode / quota — non-fatal, just don't persist */
    }
  }, [minimized]);

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
          daysAhead: HORIZON_DAYS,
        });
        if (events.length === 0) {
          setRows([]);
          setPhase("empty");
          return;
        }
        const matches = await matchCalendarEvents(
          events.map((ev) => ({
            key: ev.id,
            series_key: ev.linkKey, // series master id for recurring meetings
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

  // Handlers for the per-row manual override flow. We operate on the
  // event's LINK KEY (series master id for recurring meetings, else the
  // event id) so linking one occurrence of a weekly meeting links the whole
  // series — and we update every visible occurrence at once.
  const onPickPortfolio = useCallback(
    async (linkKey: string, projectId: number) => {
      try {
        const link = await linkCalendarEvent(linkKey, projectId);
        // Splice the new match onto EVERY row that shares this link key
        // (all occurrences of the series), no full reload.
        setRows((rs) =>
          rs.map((r) =>
            r.event.linkKey === linkKey
              ? {
                  ...r,
                  match: {
                    key: r.event.id,
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

  const onUnlink = useCallback(async (linkKey: string) => {
    try {
      await unlinkCalendarEvent(linkKey);
      // Unlinking clears the whole series. We don't know what the heuristic
      // match would be for each occurrence without a fresh /match call, so
      // re-run the whole load (cheap — 14 days × ~50 events).
      void load();
    } catch (err: any) {
      // eslint-disable-next-line no-alert
      alert(`Couldn't remove link: ${err?.message || err}`);
    }
  }, [load]);

  const groups = useMemo(() => groupByDay(rows), [rows]);
  // Today-only by default (groups[0] is today, or the next workday on a
  // weekend); the toggle reveals the rest of the week.
  const visibleGroups = expandedWeek ? groups : groups.slice(0, 1);
  const laterMeetingCount = expandedWeek
    ? 0
    : groups.slice(1).reduce((n, g) => n + g.rows.length, 0);
  const todayCount = groups[0]?.rows.length ?? 0;
  const weekCount = groups.reduce((n, g) => n + g.rows.length, 0);

  // ============================================================
  // Render
  // ============================================================
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-surface-hairline">
        <h2 className="section-title">Today's meetings</h2>
        <span className="text-xs text-brand-gray truncate">
          {minimized && phase === "loaded"
            ? `${todayCount} today${
                weekCount > todayCount ? ` · ${weekCount} this week` : ""
              }`
            : "from Outlook"}
        </span>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {phase !== "signed-out" && !minimized && (
            <button
              type="button"
              onClick={() => load()}
              disabled={phase === "loading"}
              className="text-xs font-semibold text-brand-gray hover:text-brand-red disabled:opacity-40"
              title="Refresh from Outlook"
            >
              {phase === "loading" ? "Loading…" : "↻ Refresh"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMinimized((v) => !v)}
            className="text-brand-gray hover:text-brand-red text-sm leading-none"
            title={minimized ? "Expand" : "Minimize"}
            aria-label={minimized ? "Expand upcoming meetings" : "Minimize upcoming meetings"}
            aria-expanded={!minimized}
          >
            {minimized ? "▸" : "▾"}
          </button>
        </div>
      </div>

      {!minimized && (
      <div className="px-5 py-3 space-y-3">
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
            Nothing on your calendar in the week ahead. Try adding
            attendees from a portfolio's roster to your Outlook meetings
            so we can auto-link them next time.
          </div>
        )}

        {(phase === "loaded" || (phase === "loading" && rows.length > 0)) && (
          // Negative inset so the rows run edge-to-edge inside the card while
          // the surrounding states keep the body padding.
          <div className="-mx-5 space-y-3">
            {visibleGroups.map((g) => (
              <div key={g.key}>
                <div className="micro-label px-5 mb-1">{g.label}</div>
                {g.rows.length === 0 ? (
                  <div className="text-xs text-brand-lightgray italic px-5 py-0.5">
                    No meetings
                  </div>
                ) : (
                  <div>
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
                          onPickPortfolio(event.linkKey, pid)
                        }
                        onUnlink={() => onUnlink(event.linkKey)}
                        onBuildAgenda={() =>
                          nav(buildAgendaHref(event, match, clients))
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
            {groups.length > 1 && (
              <button
                type="button"
                onClick={() => setExpandedWeek((v) => !v)}
                className="w-full text-center text-xs font-semibold text-brand-gray hover:text-brand-red py-1.5"
              >
                {expandedWeek
                  ? "▴ Show today only"
                  : `▾ Show rest of week${
                      laterMeetingCount
                        ? ` · ${laterMeetingCount} more meeting${
                            laterMeetingCount === 1 ? "" : "s"
                          }`
                        : ""
                    }`}
              </button>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}


/* ============================================================
 * Sub-states
 * ============================================================ */

function SignedOutCta() {
  return (
    <div className="flex items-center justify-between gap-3 bg-[#f4fafc] border border-[#cfe6ee] rounded-lg px-3 py-2">
      <div className="text-sm text-brand-deepblue">
        Sign in with your Castillo account to see upcoming Outlook meetings
        and pre-fill agendas from them.
      </div>
    </div>
  );
}


function ConsentCta({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-[#f4fafc] border border-[#cfe6ee] rounded-lg px-3 py-2">
      <div className="text-sm text-brand-deepblue">
        Connect your Outlook calendar so we can list your week ahead and
        link those meetings to portfolios.
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
    <div className="rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
      <div className="font-semibold">{detail.message}</div>
      {detail.hint && (
        <div className="mt-1 text-xs leading-relaxed">{detail.hint}</div>
      )}
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="text-xs font-semibold underline hover:no-underline"
        >
          {detail.actionLabel || "Try again"}
        </button>
        {detail.azure && (
          <span className="text-[11px] opacity-80">
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
      <div className="h-3 w-24 bg-surface-mute rounded animate-pulse" />
      {[0, 1].map((i) => (
        <div key={i} className="py-2 space-y-2">
          <div className="h-4 w-3/4 bg-surface-mute rounded animate-pulse" />
          <div className="h-3 w-1/2 bg-surface-hairline rounded animate-pulse" />
        </div>
      ))}
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
  const durationMin =
    start && end ? Math.round((end.getTime() - start.getTime()) / 60000) : null;

  const matchedTo =
    match.project_id && match.project_name
      ? `${match.client_name ? match.client_name + " / " : ""}${
          match.project_name
        }`
      : null;

  // The rail carries the match state at a glance: red = bound to a portfolio,
  // gold = still needs one, grey = internal sync we deliberately left alone.
  const rail = matchedTo
    ? "bg-brand-red"
    : isInternal
    ? "bg-brand-lightgray"
    : "bg-brand-gold";

  return (
    <div className="px-5 py-3 border-b border-b-surface-page last:border-b-0 hover:bg-surface-rowhover transition">
      <div className="flex items-center gap-4">
        <div className="w-[70px] shrink-0 text-right">
          {event.isAllDay || !start ? (
            <div className="text-sm font-semibold text-brand-black">All day</div>
          ) : (
            <>
              <div className="text-sm font-semibold tabular-nums text-brand-black">
                {format(start, "h:mm")}
                <span className="ml-0.5 text-[10px] font-semibold text-brand-gray">
                  {format(start, "a")}
                </span>
              </div>
              {durationMin !== null && (
                <div className="text-[11px] text-brand-gray">
                  {durationMin} min
                </div>
              )}
            </>
          )}
        </div>

        <div className={clsx("w-[3px] self-stretch rounded-sm", rail)} />

        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-brand-black truncate">
            {event.subject || "(no subject)"}
          </div>
          <div className="text-xs text-brand-gray mt-px truncate">
            {matchedTo || (isInternal ? "Internal" : "No portfolio yet")}
            {event.organizerName ? ` · ${event.organizerName}` : ""}
            {event.onlineProvider && (
              <>
                {" · "}
                <span
                  className="font-semibold text-brand-blue"
                  title={`Online meeting (${event.onlineProvider})`}
                >
                  Online
                </span>
              </>
            )}
          </div>

          {/* Match status + manual override toggle */}
          <div className="text-xs mt-1 flex items-center gap-2 flex-wrap">
            {event.isRecurring && (
              <span
                className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-surface-mute text-brand-gray"
                title="Recurring meeting — linking/unlinking applies to the whole series"
              >
                🔁 Recurring
              </span>
            )}
            {matchedTo ? (
              <>
                <MatchBadge match={match} />
                <button
                  type="button"
                  onClick={onTogglePicker}
                  className="text-[11px] font-semibold text-brand-gray hover:text-brand-red"
                >
                  {pickerOpen ? "Cancel" : "Change"}
                </button>
                {match.is_manual && (
                  <button
                    type="button"
                    onClick={onUnlink}
                    className="text-[11px] font-semibold text-brand-gray hover:text-brand-red"
                    title={
                      event.isRecurring
                        ? "Remove the link from the whole recurring series — falls back to auto-match"
                        : "Remove the manual link — falls back to auto-match"
                    }
                  >
                    {event.isRecurring ? "Remove series link" : "Remove link"}
                  </button>
                )}
              </>
            ) : isInternal ? (
              // Internal-only meeting: skip the "Unmatched" pill + "Pick a
              // portfolio" prompt — almost always wrong to bind an internal
              // sync to a client portfolio. PM can still click "Link to
              // portfolio" to override if this one really is portfolio-related.
              <>
                <span
                  className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-surface-mute text-brand-gray"
                  title="All attendees are on the Castillo domain — treated as an internal sync, not a client meeting."
                >
                  🏢 Internal
                </span>
                <button
                  type="button"
                  onClick={onTogglePicker}
                  className="text-[11px] font-semibold text-brand-gray hover:text-brand-red"
                >
                  {pickerOpen ? "Cancel" : "Link to portfolio"}
                </button>
              </>
            ) : (
              <>
                <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-status-pending-bg text-status-pending-text">
                  Unmatched
                </span>
                <button
                  type="button"
                  onClick={onTogglePicker}
                  className="text-[11px] font-semibold text-brand-deepgold hover:text-brand-red"
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
          className="btn-ghost text-xs px-3.5 py-1.5 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
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
        <>
          {event.isRecurring && (
            <div className="mt-2 text-[11px] text-brand-deepblue bg-[#f4fafc] border border-[#cfe6ee] rounded px-2 py-1">
              🔁 This is a recurring meeting — your choice links{" "}
              <strong>every occurrence</strong> in the series (and future ones).
            </div>
          )}
          <ManualPortfolioPicker
            portfolios={portfolios}
            onPick={onPickPortfolio}
          />
        </>
      )}
    </div>
  );
}


function MatchBadge({ match }: { match: CalendarMatchOut }) {
  if (match.is_manual) {
    return (
      <span
        className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-status-completed-bg text-status-completed-text"
        title="You manually linked this event to a portfolio."
      >
        ✓ Linked
      </span>
    );
  }
  if (match.match_reason === "email") {
    return (
      <span
        className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-[#d9f0f7] text-brand-deepblue"
        title="Matched by an attendee email in the portfolio's roster."
      >
        Auto · email
      </span>
    );
  }
  if (match.match_reason === "subject") {
    return (
      <span
        className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-status-pending-bg text-status-pending-text"
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
    <div className="mt-2 rounded-lg border border-surface-border bg-white p-2 space-y-2">
      <input
        type="text"
        autoFocus
        placeholder="Search portfolios…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="input px-2 py-1 text-xs"
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
              className="block w-full text-left px-2 py-1 rounded hover:bg-surface-rowhover text-xs"
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
  /** Local calendar day, yyyy-MM-dd — stable React key. */
  key: string;
  /** Human label, e.g. "Today · Wed, Jun 10" / "Tomorrow · Thu, Jun 11" /
   *  "Fri, Jun 12". */
  label: string;
  /** Events that day (sorted by start). Empty array on a free day. */
  rows: EventRow[];
}

/**
 * Build one bucket per local WORKDAY from today through the next week
 * (HORIZON_DAYS), INCLUDING workdays with no meetings — so the column reads
 * as a continuous Mon–Fri planner instead of silently skipping free days.
 * Weekends (Sat/Sun) are omitted entirely.
 *
 * Events are bucketed by their LOCAL day, and each label is derived from a
 * real local `Date` (via date-fns, which formats in local time) rather than
 * re-parsing the day key as UTC midnight — the old approach drifted the
 * weekday/date by a day for anyone east/west of UTC.
 */
function groupByDay(rows: EventRow[]): DayGroup[] {
  const map = new Map<string, EventRow[]>();
  for (const r of rows) {
    if (!r.event.startUtc) continue;
    const key = format(parseISO(r.event.startUtc), "yyyy-MM-dd"); // local day
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  for (const list of map.values()) {
    list.sort((a, b) =>
      (a.event.startUtc || "").localeCompare(b.event.startUtc || ""),
    );
  }

  const out: DayGroup[] = [];
  const today = startOfDay(new Date());
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = addDays(today, i);
    if (isWeekend(d)) continue; // workdays only — skip Sat/Sun
    const key = format(d, "yyyy-MM-dd");
    const prefix = isToday(d) ? "Today · " : isTomorrow(d) ? "Tomorrow · " : "";
    out.push({
      key,
      label: `${prefix}${format(d, "EEE, MMM d")}`,
      rows: map.get(key) ?? [],
    });
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
