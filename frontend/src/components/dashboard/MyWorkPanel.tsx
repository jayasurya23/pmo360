/**
 * "Assigned to you" — the signed-in person's own queue, on the Dashboard.
 *
 * Two placements, one component, told apart by `projectId`:
 *   - no portfolio picked (the All-clients state) → the whole Dashboard
 *   - a portfolio picked                          → the same panel narrowed to
 *                                                   it, under the portfolio
 *                                                   metrics
 *
 * This is the signed-in PERSON, not the org — /lead is the bird's-eye page.
 * It is also not membership: portfolio scoping is off app-wide, so "assigned
 * to you" means action OWNERSHIP and nothing else.
 *
 * SCOPING IS CLIENT-SIDE, AND ONLY GOES AS FAR AS THE PAYLOAD HONESTLY CAN.
 * GET /api/dashboard/my-work takes no portfolio argument, so the narrowed card
 * shows the two figures the response breaks down per portfolio (`open`,
 * `overdue` from `by_portfolio`) plus the queue rows, which carry a
 * `project_id`. The date-window counts are whole-plate totals; relabelling
 * them "in this portfolio" would be a wrong number, so the card says where to
 * go and see them instead.
 *
 * Three states stay visually distinct, because a PM who reads a failure as an
 * empty queue stops looking for work that is really there: loading shows
 * dashes, an error says so in the loud slot, and only a genuine empty result
 * renders zeros.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

import { fetchMyWork } from "@/lib/api";
import type { MyWork, MyWorkItem, MyWorkPortfolio, MyWorkQueue } from "@/lib/types";
import { money } from "@/components/home/useHomeData";
import { nameToSlug } from "@/lib/slugs";
import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";

const QUEUE_KEYS = [
  "co_approvals",
  "co_to_send",
  "agendas",
  "meeting_drafts",
] as const;

type QueueKey = (typeof QUEUE_KEYS)[number];

const GROUP_TITLE: Record<QueueKey, string> = {
  co_approvals: "Change orders awaiting your approval",
  co_to_send: "Approved change orders not yet sent",
  // Deliberately NOT "unsent": Agenda has no sent_at and the send path runs
  // through Graph in the browser, so the server cannot know. Upcoming is what
  // it can actually vouch for.
  agendas: "Upcoming agendas you created",
  meeting_drafts: "Unfinished meeting drafts",
};

const GROUP_HAS_MONEY: Record<QueueKey, boolean> = {
  co_approvals: true,
  co_to_send: true,
  agendas: false,
  meeting_drafts: false,
};

export default function MyWorkPanel({
  projectId = null,
}: {
  /** Portfolio to narrow to, or null for the cross-portfolio view. */
  projectId?: number | null;
}) {
  const { isAuthenticated } = useAuth();
  const { clients, projects, setSelectedClientId } = useApp();
  const nav = useNavigate();

  const [data, setData] = useState<MyWork | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!isAuthenticated) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchMyWork()
      .then((d) => {
        // A payload we don't recognise belongs in the error state, not the
        // empty one. Reading a missing bucket as "nothing here" is the same lie
        // as a failed request rendering as zero, and harder to notice.
        if (!isWellFormed(d)) {
          setData(null);
          setError("Unexpected response shape from /api/dashboard/my-work");
          return;
        }
        setData(d);
        setError(null);
      })
      .catch((e) => {
        // Drop the stale payload too — a half-refreshed panel showing the last
        // request's numbers is its own wrong answer.
        setData(null);
        setError(e?.message || "Request failed");
      })
      .finally(() => setLoading(false));
  }, [isAuthenticated]);

  useEffect(() => {
    load();
  }, [load]);

  const scoped = projectId != null;

  /** The one `by_portfolio` row for the narrowed card. Absent means the user
   *  has no open actions here — a real zero, not a missing lookup. */
  const scopedRow: MyWorkPortfolio | null = useMemo(() => {
    if (!scoped || !data) return null;
    return data.by_portfolio.find((r) => r.project_id === projectId) ?? null;
  }, [scoped, data, projectId]);

  /** Queue rows filtered to the portfolio, with the two dollar totals recomputed
   *  from what survives — the server's precomputed sums cover the whole plate. */
  const queue: MyWorkQueue | null = useMemo(() => {
    if (!data) return null;
    if (!scoped) return data.waiting_on_me;
    const q = data.waiting_on_me;
    const keep = (rows: MyWorkItem[]) =>
      rows.filter((r) => r.project_id === projectId);
    const co_approvals = keep(q.co_approvals);
    const co_to_send = keep(q.co_to_send);
    const agendas = keep(q.agendas);
    const meeting_drafts = keep(q.meeting_drafts);
    const sum = (rows: MyWorkItem[]) =>
      rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return {
      co_approvals,
      co_to_send,
      agendas,
      meeting_drafts,
      co_approval_amount: sum(co_approvals),
      co_to_send_amount: sum(co_to_send),
      total:
        co_approvals.length +
        co_to_send.length +
        agendas.length +
        meeting_drafts.length,
    };
  }, [data, scoped, projectId]);

  /**
   * Portfolio context travels as ?client=&portfolio= because that is the
   * context switcher's own mechanism — state.tsx resolves both slugs when the
   * lists arrive, so a linked page opens with the header already pointing at
   * the right place. Resolving the client from `projects[].client_id` beats
   * matching on the row's client_name, which two clients could share.
   */
  const contextQuery = useCallback(
    (
      rowProjectId: number | null,
      rowProjectName: string | null,
      rowClientName: string | null,
    ) => {
      const proj = projects.find((p) => p.id === rowProjectId) ?? null;
      const client = proj
        ? (clients.find((c) => c.id === proj.client_id) ?? null)
        : null;
      const clientSlug = nameToSlug(client?.name ?? rowClientName ?? "");
      const projectSlug = nameToSlug(proj?.name ?? rowProjectName ?? "");
      const parts: string[] = [];
      if (clientSlug) parts.push(`client=${clientSlug}`);
      if (projectSlug) parts.push(`portfolio=${projectSlug}`);
      return parts.length ? `?${parts.join("&")}` : "";
    },
    [projects, clients],
  );

  const openRow = useCallback(
    (item: MyWorkItem) => {
      const q = contextQuery(item.project_id, item.project_name, item.client_name);
      switch (item.kind) {
        case "agenda":
          // NextAgenda reads ?agenda=<id>, so this one opens the record itself.
          nav(`/next-agenda${q ? `${q}&` : "?"}agenda=${item.id}`);
          break;
        case "meeting_draft":
          // Review only edits the wizard's in-progress draft; History is where a
          // saved draft gets picked up, and it badges drafts on arrival.
          nav(`/history${q}`);
          break;
        default:
          // Change Orders has no per-record route yet, so this lands on the page
          // with the row's client + portfolio already selected.
          nav(`/change-orders${q}`);
      }
    },
    [contextQuery, nav],
  );

  const actionsHref = useMemo(() => {
    const base = "/actions?owner=mine&status=open_pending";
    if (!scoped) return base;
    const q = contextQuery(projectId, null, null);
    return q ? `${base}&${q.slice(1)}` : base;
  }, [scoped, projectId, contextQuery]);

  const head = (
    <div className="flex items-baseline gap-2.5 flex-wrap">
      <h2 className="section-title">Assigned to you</h2>
      <span className="text-xs text-brand-gray">
        {scoped ? "in this portfolio" : "across every client and portfolio"}
      </span>
      {data && (
        <button
          type="button"
          onClick={() => nav(actionsHref)}
          className="ml-auto text-xs font-semibold text-brand-red hover:text-brand-darkred hover:underline"
        >
          Open in Actions →
        </button>
      )}
    </div>
  );

  if (!isAuthenticated) {
    return (
      <section className="card px-5 py-4">
        {head}
        <p className="text-sm text-brand-gray mt-3">
          Sign in to see the actions, change orders and drafts that are yours.
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="card border-l-[3px] border-l-brand-red px-5 py-4">
        {head}
        <p className="text-sm font-semibold text-brand-black mt-3">
          We could not load what is assigned to you.
        </p>
        <p className="text-xs text-brand-gray mt-1">
          {error} — this is a failed request, not an empty queue. Your work is
          still there.
        </p>
        <button type="button" className="btn-ghost text-xs mt-3" onClick={load}>
          Try again
        </button>
      </section>
    );
  }

  if (!data || !queue) {
    return (
      <div className="space-y-[22px]">
        <section className="card px-5 py-4">
          {head}
          <p className="text-sm text-brand-gray mt-3 italic">
            Loading your work…
          </p>
        </section>
        <MetricsRow scoped={scoped} />
      </div>
    );
  }

  return (
    <div className="space-y-[22px]">
      <section className="card px-5 py-4">
        {head}
        <p className="text-xs text-brand-gray mt-1.5">
          Ownership follows the name written on an action as well as the linked
          user, so items assigned before the people-picker was fixed still
          count. Dated against {safeDate(data.as_of, "EEE, MMM d")} (
          {data.timezone}).
        </p>
      </section>

      <MetricsRow
        actions={data.actions}
        scopedRow={scopedRow}
        scoped={scoped}
        loading={loading}
      />

      {scoped ? (
        <>
          <p className="text-xs text-brand-gray">
            Due-this-week and recently-closed counts are whole-plate figures, so
            they are not shown here.{" "}
            {/* Clearing the client is what actually reaches the All-clients
                dashboard — this page is already /portfolio, so navigating to it
                again would change nothing. */}
            <button
              type="button"
              onClick={() => setSelectedClientId(null)}
              className="font-semibold text-brand-red hover:underline"
            >
              Switch to All clients
            </button>{" "}
            to see everything assigned to you.
          </p>
          <WaitingOnMeCard queue={queue} onOpen={openRow} scoped />
        </>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.25fr] gap-[22px] items-start">
          <ConcentrationCard
            rows={data.by_portfolio}
            onOpen={(row) =>
              nav(
                `/portfolio${contextQuery(
                  row.project_id,
                  row.project_name,
                  row.client_name,
                )}`,
              )
            }
          />
          <WaitingOnMeCard queue={queue} onOpen={openRow} />
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Metrics row
   ============================================================ */
/**
 * Unscoped: open / overdue / due this week / closed recently.
 * Scoped: only the two figures the payload breaks down per portfolio.
 * Omit `actions` entirely for the loading row — tiles render "—", never 0.
 */
function MetricsRow({
  actions,
  scopedRow,
  scoped,
  loading,
}: {
  actions?: MyWork["actions"];
  scopedRow?: MyWorkPortfolio | null;
  scoped: boolean;
  loading?: boolean;
}) {
  const pending = !actions;
  const open = scoped ? (scopedRow?.open ?? 0) : (actions?.open ?? 0);
  const overdue = scoped ? (scopedRow?.overdue ?? 0) : (actions?.overdue ?? 0);

  const openFoot = (() => {
    if (pending) return "Loading…";
    if (scoped) return "assigned to you here";
    const authored = actions!.open_authored_only;
    const undated = actions!.no_due_date;
    const bits: string[] = [];
    if (undated > 0) bits.push(`${undated} with no due date`);
    // Naming the weakest ownership rung keeps the headline honest rather than
    // quietly inflating it with rows nobody actually assigned.
    if (authored > 0) bits.push(`${authored} yours only as author`);
    return bits.length ? bits.join(" · ") : "assigned to you";
  })();

  return (
    <div
      className={clsx(
        "grid grid-cols-1 gap-3.5",
        scoped ? "sm:grid-cols-2" : "md:grid-cols-2 lg:grid-cols-4",
        // Refreshing in place: dim rather than blank, so numbers on screen are
        // visibly stale instead of silently so.
        loading && !pending && "opacity-60",
      )}
    >
      <WorkTile
        label="Open actions"
        value={pending ? "—" : open}
        foot={openFoot}
      />
      <WorkTile
        label="Overdue"
        value={pending ? "—" : overdue}
        alert={!pending && overdue > 0}
        foot={
          pending
            ? "Loading…"
            : overdue > 0
              ? "past their due date"
              : "nothing overdue"
        }
      />
      {!scoped && (
        <>
          <WorkTile
            label="Due this week"
            value={pending ? "—" : actions!.due_this_week}
            foot={
              pending
                ? "Loading…"
                : `in the next ${actions!.due_window_days} days`
            }
          />
          <WorkTile
            label="Closed recently"
            value={pending ? "—" : actions!.closed_recently}
            tone="green"
            foot={
              pending
                ? "Loading…"
                : `completed in the last ${actions!.closed_window_days} days${
                    actions!.cancelled_recently > 0
                      ? ` · ${actions!.cancelled_recently} cancelled`
                      : ""
                  }`
            }
          />
        </>
      )}
    </div>
  );
}

function WorkTile({
  label,
  value,
  foot,
  tone = "default",
  alert = false,
}: {
  label: string;
  value: number | string;
  foot?: ReactNode;
  tone?: "default" | "green";
  /** Overdue-with-work: borrow the open-status tint so the one number that
   *  should catch the eye does, without introducing a colour of its own. */
  alert?: boolean;
}) {
  return (
    <div
      className={clsx(
        "card px-[18px] py-4",
        alert && "border-status-open-border bg-status-open-bg",
      )}
    >
      <div
        className={clsx(
          "text-[11px] uppercase tracking-[0.1em] font-semibold",
          alert ? "text-status-open-text" : "text-brand-gray",
        )}
      >
        {label}
      </div>
      <div
        className={clsx(
          "text-[34px] font-bold mt-1.5 leading-tight tabular-nums",
          alert
            ? "text-status-open-text"
            : tone === "green"
              ? "text-brand-green"
              : "text-brand-black",
        )}
      >
        {value}
      </div>
      {foot && (
        <div
          className={clsx(
            "text-xs mt-0.5",
            alert ? "text-status-open-text" : "text-brand-gray",
          )}
        >
          {foot}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Shared card furniture — mirrors PortfolioDashboard's own
   ============================================================ */
function CardHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <h2 className="section-title">{title}</h2>
      {hint && <span className="text-xs text-brand-gray">{hint}</span>}
    </div>
  );
}

/* ============================================================
   Where the open work sits — client + portfolio + counts
   ============================================================ */
function ConcentrationCard({
  rows,
  onOpen,
}: {
  rows: MyWorkPortfolio[];
  onOpen: (row: MyWorkPortfolio) => void;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="px-5 py-3.5 border-b border-surface-hairline">
        <CardHead
          title="Where your open work is"
          hint={
            rows.length > 0
              ? `${rows.length} ${rows.length === 1 ? "portfolio" : "portfolios"}`
              : undefined
          }
        />
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-brand-gray">
          No open actions are assigned to you right now.
        </p>
      ) : (
        rows.map((row) => (
          <button
            key={row.project_id}
            type="button"
            onClick={() => onOpen(row)}
            className="w-full text-left px-5 py-3 grid grid-cols-[1fr_auto_auto] gap-3.5 items-center
              border-b border-surface-page last:border-b-0 hover:bg-surface-rowhover transition"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium text-brand-black truncate">
                {row.project_name}
              </span>
              <span className="block text-xs text-brand-gray mt-px truncate">
                {row.client_name || "No client"}
              </span>
            </span>
            <span className="text-xs tabular-nums text-brand-gray whitespace-nowrap">
              {row.open} open
              {row.overdue > 0 && (
                <>
                  {" · "}
                  <b className="font-semibold text-status-open-text">
                    {row.overdue} overdue
                  </b>
                </>
              )}
            </span>
            <span className="text-brand-lightgray">›</span>
          </button>
        ))
      )}
    </section>
  );
}

/* ============================================================
   Waiting on me — COs, agendas, drafts
   ============================================================ */
function WaitingOnMeCard({
  queue,
  onOpen,
  scoped = false,
}: {
  queue: MyWorkQueue;
  onOpen: (item: MyWorkItem) => void;
  scoped?: boolean;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="px-5 py-3.5 border-b border-surface-hairline">
        <CardHead
          title="Waiting on you"
          hint={
            queue.total > 0
              ? `${queue.total} item${queue.total === 1 ? "" : "s"}`
              : undefined
          }
        />
      </div>
      {queue.total === 0 ? (
        // One calm line, not four empty cards.
        <p className="px-5 py-6 text-center text-sm text-brand-gray">
          Nothing is waiting on you{scoped ? " in this portfolio" : ""} — no
          change orders to approve or send, no upcoming agendas, no unfinished
          drafts.
        </p>
      ) : (
        QUEUE_KEYS.map((key) => (
          <QueueGroup
            key={key}
            title={GROUP_TITLE[key]}
            withMoney={GROUP_HAS_MONEY[key]}
            total={
              key === "co_approvals"
                ? queue.co_approval_amount
                : key === "co_to_send"
                  ? queue.co_to_send_amount
                  : 0
            }
            items={queue[key]}
            onOpen={onOpen}
          />
        ))
      )}
    </section>
  );
}

/** Renders nothing when its bucket is empty — an empty heading is noise. */
function QueueGroup({
  title,
  items,
  withMoney,
  total,
  onOpen,
}: {
  title: string;
  items: MyWorkItem[];
  withMoney: boolean;
  total: number;
  onOpen: (item: MyWorkItem) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="border-b border-surface-hairline last:border-b-0">
      <div className="flex items-baseline gap-2 px-5 pt-3 pb-1">
        <span className="text-[11px] uppercase tracking-[0.1em] font-semibold text-brand-gray">
          {title}
        </span>
        <span className="text-[11px] text-brand-lightgray tabular-nums">
          {items.length}
        </span>
        {withMoney && total > 0 && (
          <span className="ml-auto text-[11px] font-semibold tabular-nums text-brand-black">
            {money(total)}
          </span>
        )}
      </div>
      {items.map((item) => (
        <button
          key={`${item.kind}-${item.id}`}
          type="button"
          onClick={() => onOpen(item)}
          className="w-full text-left px-5 py-2.5 grid grid-cols-[1fr_auto] gap-3 items-center
            border-t border-surface-page hover:bg-surface-rowhover transition"
        >
          <span className="min-w-0">
            <span className="block text-sm text-brand-black truncate">
              {item.label || "(untitled)"}
            </span>
            <span className="block text-xs text-brand-gray mt-px truncate">
              {item.client_name && (
                <>
                  {item.client_name}
                  <span className="px-1">/</span>
                </>
              )}
              {item.project_name || "Portfolio"}
              {item.event_date && ` · ${safeDate(item.event_date)}`}
              {item.detail && ` · ${item.detail}`}
            </span>
          </span>
          {item.amount != null && (
            <span className="text-sm font-semibold tabular-nums text-brand-black whitespace-nowrap">
              {money(item.amount)}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Every field the panel indexes into, checked once at the boundary so contract
 *  drift fails loudly here instead of white-screening the Dashboard or, worse,
 *  quietly rendering a short queue. */
function isWellFormed(d: MyWork | null | undefined): d is MyWork {
  if (!d || typeof d !== "object") return false;
  const a = d.actions;
  if (!a || typeof a.open !== "number" || typeof a.overdue !== "number") {
    return false;
  }
  if (!Array.isArray(d.by_portfolio)) return false;
  const q = d.waiting_on_me;
  if (!q || typeof q.total !== "number") return false;
  return QUEUE_KEYS.every((k) => Array.isArray(q[k]));
}

/** Dates arrive from four different tables; one malformed string must not take
 *  the whole panel down with a render throw. */
function safeDate(iso: string, pattern = "MMM d"): string {
  try {
    return format(parseISO(iso), pattern);
  } catch {
    return iso;
  }
}
