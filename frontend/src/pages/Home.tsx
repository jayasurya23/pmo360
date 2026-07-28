import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import PageHeader from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import CalendarCard from "@/components/home/CalendarCard";
import PlannerCard from "@/components/home/PlannerCard";
import RisksCard from "@/components/home/RisksCard";
import ChangeOrdersCard from "@/components/home/ChangeOrdersCard";
import AtRiskSpotlight from "@/components/home/AtRiskSpotlight";
import ActivityCard from "@/components/home/ActivityCard";
import {
  compactMoney,
  dueLabel,
  useChangeOrders,
  useOpenRisks,
} from "@/components/home/useHomeData";
import DraftResumeBanner from "@/components/DraftResumeBanner";
import {
  fetchBriefing,
  fetchDashboard,
  fetchMyDashboard,
  type Briefing,
} from "@/lib/api";
import type {
  DashboardResponse,
  DashboardAction,
  DashboardAgenda,
  DashboardNote,
} from "@/lib/types";
import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";
import {
  differenceInCalendarDays,
  formatDistanceToNow,
  parseISO,
  format,
} from "date-fns";

/** Actions falling due inside this window count as "soon due" on the KPI tile. */
const SOON_DUE_DAYS = 7;

export default function Home() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [mine, setMine] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // AI briefing card — only fetched when signed in. `null` = either not
  // signed in or the request is still in flight. We track loading separately
  // so the skeleton can stay up during the refresh button flow.
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  // Overdue rollup is collapsed to 5 by default; expandable to the full list.
  const [showAllOverdue, setShowAllOverdue] = useState(false);
  const nav = useNavigate();
  const {
    settings,
    resetDraft,
    scope,
    me,
    clients,
    projects,
    selectedClientId,
    selectedProjectId,
  } = useApp();
  const { isAuthenticated, user } = useAuth();

  // Risks and change orders are fetched once here and shared with the cards
  // that render them — the spotlight + risk board, and the KPI tile + activity
  // feed + change-orders panel respectively.
  const { risks, loading: risksLoading } = useOpenRisks();
  const { cos, loading: cosLoading } = useChangeOrders();

  // ---- Dashboard scope ----
  // Narrow the all-portfolio rollups to the header's Client/Portfolio pick.
  // A specific portfolio filters by project_id; a client (with "All
  // portfolios") filters by client name; "All clients" shows everything.
  const scopeClientName = selectedClientId
    ? clients.find((c) => c.id === selectedClientId)?.name ?? null
    : null;
  const scopeProjectName = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId)?.name ?? null
    : null;
  const inScope = (it: {
    project_id?: number | null;
    client_name?: string | null;
  }) => {
    if (selectedProjectId) return it.project_id === selectedProjectId;
    if (scopeClientName) return (it.client_name || "") === scopeClientName;
    return true;
  };
  const rollupHeader = scopeProjectName
    ? scopeProjectName
    : scopeClientName
      ? `${scopeClientName} — all portfolios`
      : "across all portfolios";
  const scopedActions = (data?.open_actions || []).filter(inScope);
  const scopedAgendas = (data?.upcoming_agendas || []).filter(inScope);
  const scopedNotes = (data?.follow_up_notes || []).filter(inScope);

  // When the user picks "My portfolios" AND they're signed in AND not an
  // admin, the all-portfolios rollup uses /dashboard/mine instead of
  // /dashboard so the top three cards scope to their stuff. Admins +
  // anonymous + explicit "all" still hit /dashboard.
  const useMyScope = scope === "mine" && me !== null && !me.is_admin;

  useEffect(() => {
    setLoading(true);
    const fetcher = useMyScope ? fetchMyDashboard : fetchDashboard;
    fetcher()
      .then(setData)
      .finally(() => setLoading(false));
  }, [useMyScope]);

  useEffect(() => {
    if (!isAuthenticated) {
      setMine(null);
      return;
    }
    fetchMyDashboard()
      .then(setMine)
      .catch(() => {
        // Silently ignore — the personalised section just won't render.
        setMine(null);
      });
  }, [isAuthenticated]);

  // ---- Briefing fetch + refresh ----
  const loadBriefing = useCallback(() => {
    setBriefingLoading(true);
    fetchBriefing()
      .then((b) => setBriefing(b))
      .catch(() => setBriefing(null))
      .finally(() => setBriefingLoading(false));
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setBriefing(null);
      return;
    }
    loadBriefing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // Derive a greeting first-name from the MSAL display name.
  const firstName =
    (user?.name || "").trim().split(/\s+/)[0] || "";

  const today = new Date();
  const openActions = data?.open_actions || [];
  const overdue = openActions.filter(
    (a) => a.due_date && parseISO(a.due_date) < today
  );
  const dueSoon = openActions.filter((a) => {
    if (!a.due_date) return false;
    const days = differenceInCalendarDays(parseISO(a.due_date), today);
    return days >= 0 && days <= SOON_DUE_DAYS;
  });
  // Earliest upcoming agenda, for the KPI foot line.
  const nextAgenda = [...(data?.upcoming_agendas || [])].sort((a, b) =>
    a.upcoming_date.localeCompare(b.upcoming_date)
  )[0];
  const pendingCos = cos.filter((c) => c.status === "pending");
  const approvedCos = cos.filter((c) => c.status === "approved");
  const coTotal = (rows: typeof cos) =>
    rows.reduce((s, c) => s + (Number(c.total_amount) || 0), 0);

  const visibleOverdue = showAllOverdue
    ? scopedActions
    : scopedActions.slice(0, 5);

  return (
    <div className="space-y-[22px]">
      <PageHeader
        kicker={format(today, "EEEE · MMMM d, yyyy")}
        title={
          firstName
            ? `Good morning, ${firstName}`
            : `Welcome to ${settings?.app.title || "PMO 360"}`
        }
        actions={
          <>
            <button
              className="btn-ghost"
              onClick={() => {
                resetDraft();
                nav("/capture");
              }}
            >
              Capture minutes
            </button>
            <button className="btn-primary" onClick={() => nav("/next-agenda")}>
              + New pre-meeting agenda
            </button>
          </>
        }
      />

      {/* ----- Resume in-progress meeting draft ----- */}
      <DraftResumeBanner />

      {/* ----- What's going wrong this week, before any counts ----- */}
      <AtRiskSpotlight
        risks={risks}
        actions={openActions}
        onReviewAll={() => nav("/actions?status=open_pending")}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5">
        <StatTile
          label="Open + pending actions"
          value={openActions.length}
          foot={
            <>
              {overdue.length > 0 ? (
                <b className="text-brand-red">{overdue.length} overdue</b>
              ) : (
                "nothing overdue"
              )}{" "}
              · {dueSoon.length} due this week
            </>
          }
        />
        <StatTile
          label="Overdue actions"
          value={overdue.length}
          foot={
            overdue.length > 0 ? "needs attention today" : "all clear right now"
          }
        />
        <StatTile
          label="Upcoming agendas"
          value={data?.upcoming_agendas.length || 0}
          foot={
            nextAgenda
              ? `Next: ${format(
                  parseISO(nextAgenda.upcoming_date),
                  "EEE MMM d"
                )} · ${nextAgenda.project_name || "Portfolio"}`
              : "none scheduled"
          }
        />
        <StatTile
          label="Change orders in flight"
          value={compactMoney(coTotal(pendingCos))}
          foot={
            <>
              {pendingCos.length} pending ·{" "}
              <span className="text-brand-green font-semibold">
                {compactMoney(coTotal(approvedCos))} approved
              </span>
            </>
          }
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-[22px] items-start">
        {/* ---------- Left: the working column ---------- */}
        <div className="min-w-0 space-y-[22px]">
          {/* Upcoming Outlook meetings + my Microsoft Planner tasks — both are
              personal to the signed-in user. */}
          {isAuthenticated && <CalendarCard />}
          {isAuthenticated && <PlannerCard />}

          <CardShell
            title="Overdue & soon-due actions"
            meta={rollupHeader}
            action={
              scopedActions.length > 5 && (
                <button
                  className="text-xs font-semibold text-brand-red hover:underline"
                  onClick={() => setShowAllOverdue((v) => !v)}
                >
                  {showAllOverdue
                    ? "Show fewer"
                    : `All ${scopedActions.length} →`}
                </button>
              )
            }
          >
            {loading ? (
              <Loader />
            ) : scopedActions.length === 0 ? (
              <CardEmpty
                title="Nothing overdue"
                hint="All clear — no rolling actions need attention right now."
              />
            ) : (
              <ActionsList items={visibleOverdue} />
            )}
          </CardShell>

          {/* ----- Personalised "Your stuff" view ----- */}
          {isAuthenticated && (
            <section className="card px-5 py-4">
              <div className="flex items-baseline gap-2">
                <h2 className="section-title">Your stuff</h2>
                <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-deepgold">
                  ✦ Personal
                </span>
              </div>

              <div className="mt-3 space-y-4">
                <SubSection title="Your open actions">
                  <ActionsList
                    dense
                    items={(mine?.open_actions || []).slice(0, 5)}
                    emptyHint="Nothing assigned to you"
                  />
                  {(mine?.open_actions || []).length > 0 && (
                    <button
                      className="mt-2 text-xs font-semibold text-brand-red hover:underline"
                      onClick={() =>
                        nav("/actions?owner=mine&status=open_pending")
                      }
                    >
                      {(mine?.open_actions || []).length > 5
                        ? `View all ${mine!.open_actions.length} open actions →`
                        : "View all in Actions →"}
                    </button>
                  )}
                </SubSection>

                <SubSection title="Your follow-ups">
                  <NotesList
                    dense
                    items={mine?.follow_up_notes || []}
                    emptyHint="Nothing assigned to you"
                  />
                </SubSection>

                <SubSection title="Your upcoming agendas">
                  <AgendasList
                    dense
                    items={mine?.upcoming_agendas || []}
                    onOpen={(id) => nav(`/next-agenda?agenda=${id}`)}
                    emptyHint="Nothing assigned to you"
                  />
                </SubSection>
              </div>
            </section>
          )}

          <CardShell title="Upcoming pre-meeting agendas" meta={rollupHeader}>
            {loading ? (
              <Loader />
            ) : scopedAgendas.length === 0 ? (
              <CardEmpty
                title="No upcoming agendas"
                hint="Use the Pre Meeting page to plan an upcoming meeting."
                action={
                  <button
                    className="btn-primary mt-3"
                    onClick={() => nav("/next-agenda")}
                  >
                    Build an agenda
                  </button>
                }
              />
            ) : (
              <AgendasList
                items={scopedAgendas}
                onOpen={(id) => nav(`/next-agenda?agenda=${id}`)}
              />
            )}
          </CardShell>

          <CardShell title="Follow-up notes" meta={rollupHeader}>
            {loading ? (
              <Loader />
            ) : scopedNotes.length === 0 ? (
              <CardEmpty
                title="No follow-ups"
                hint="Notes with a follow-up date appear here when their date arrives."
              />
            ) : (
              <NotesList items={scopedNotes} />
            )}
          </CardShell>
        </div>

        {/* ---------- Right: the standing brief ---------- */}
        <div className="min-w-0 space-y-[22px]">
          {isAuthenticated && (
            <BriefingCard
              briefing={briefing}
              loading={briefingLoading}
              onRefresh={loadBriefing}
            />
          )}
          <RisksCard risks={risks} loading={risksLoading} />
          {isAuthenticated && <ActivityCard cos={cos} loading={cosLoading} />}
          <ChangeOrdersCard cos={cos} loading={cosLoading} />
        </div>
      </div>
    </div>
  );
}

/* ---------- Card chrome shared by the rollup panels ---------- */
function CardShell({
  title,
  meta,
  action,
  children,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-baseline gap-2.5 px-5 py-3.5 border-b border-surface-hairline">
        <h2 className="section-title">{title}</h2>
        {meta && (
          <span className="text-xs text-brand-gray truncate">{meta}</span>
        )}
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function CardEmpty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-5 py-8 text-center">
      <div className="text-sm font-semibold text-brand-black">{title}</div>
      {hint && <div className="text-xs text-brand-gray mt-1">{hint}</div>}
      {action}
    </div>
  );
}

/* ---------- KPI tile ---------- */
function StatTile({
  label,
  value,
  foot,
}: {
  label: string;
  value: number | string;
  foot?: ReactNode;
}) {
  return (
    <div className="card px-[18px] py-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-gray">
        {label}
      </div>
      <div className="mt-1.5 text-[34px] font-bold leading-[1.05] tabular-nums text-brand-black">
        {value}
      </div>
      {foot && <div className="mt-0.5 text-xs text-brand-gray">{foot}</div>}
    </div>
  );
}

/* ---------- AI briefing card ---------- */
function BriefingCard({
  briefing,
  loading,
  onRefresh,
}: {
  briefing: Briefing | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  // Skeleton: render the card shell while the first fetch is in flight so
  // the page doesn't jump when the data arrives.
  if (loading && briefing === null) {
    return (
      <section className="card border-l-[3px] border-l-brand-gold px-5 py-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-brand-deepgold">
          ✦ Morning briefing
        </div>
        <div className="mt-2.5 text-sm text-brand-gray italic">
          Loading your briefing…
        </div>
      </section>
    );
  }
  if (!briefing) return null;

  const whenText = briefing.last_seen_at
    ? formatDistanceToNow(parseISO(briefing.last_seen_at), {
        addSuffix: false,
      }) + " ago"
    : "today";

  // Chip row — skip any with count===0 so quiet days stay clean.
  const chips: Array<{
    key: string;
    count: number;
    label: string;
    className: string;
  }> = [
    {
      key: "overdue",
      count: briefing.overdue_actions_assigned_to_me,
      label: "overdue",
      className: "bg-status-open-bg text-status-open-text",
    },
    {
      key: "new-actions",
      count: briefing.new_actions_assigned_to_me,
      label: "new actions",
      className: "bg-status-pending-bg text-status-pending-text",
    },
    {
      key: "meetings",
      count: briefing.new_meetings_touched,
      label: "meetings touched",
      className: "bg-[#d9f0f7] text-brand-deepblue",
    },
    {
      key: "agendas",
      count: briefing.new_agendas_touched,
      label: "agendas touched",
      className: "bg-status-completed-bg text-status-completed-text",
    },
    {
      key: "follow-ups",
      count: briefing.new_follow_up_notes,
      label: "follow-up notes",
      className: "bg-surface-border text-brand-gray",
    },
  ].filter((c) => c.count > 0);

  return (
    <section className="card border-l-[3px] border-l-brand-gold px-5 py-4">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-brand-deepgold">
          ✦ Morning briefing
        </span>
        <span className="text-[11px] text-brand-gray truncate">
          last visit {whenText}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh briefing"
          aria-label="Refresh briefing"
          className="ml-auto text-brand-gray hover:text-brand-red text-sm leading-none disabled:opacity-40"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      <p className="mt-2.5 text-[13.5px] leading-[1.6] text-brand-black">
        {briefing.briefing}
      </p>

      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span
              key={c.key}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${c.className}`}
            >
              <span className="tabular-nums">{c.count}</span>
              <span>{c.label}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- Subsection shell ---------- */
function SubSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-[13px] font-semibold text-brand-black mb-1">
        {title}
      </h3>
      {children}
    </div>
  );
}

/* ---------- List renderers reused in both contexts ----------
 * `dense` drops the card's own horizontal padding so the same rows can sit
 * inside an already-padded card (the personal section) as well as flush in a
 * CardShell body. */
function ActionsList({
  items,
  emptyHint,
  dense,
}: {
  items: DashboardAction[];
  emptyHint?: string;
  dense?: boolean;
}) {
  if (items.length === 0 && emptyHint) {
    return <div className="text-xs text-brand-gray italic">{emptyHint}</div>;
  }
  return (
    <div>
      {items.map((a) => {
        const days = a.due_date
          ? differenceInCalendarDays(parseISO(a.due_date), new Date())
          : null;
        const isOverdue = days !== null && days < 0;
        return (
          <div
            key={a.id}
            className={clsx(
              "grid grid-cols-[1fr_auto_auto] items-center gap-3.5 py-[11px]",
              "border-b border-b-surface-page last:border-b-0 border-l-[3px]",
              dense ? "-mx-2 px-2" : "px-5",
              isOverdue ? "border-l-brand-red" : "border-l-transparent"
            )}
          >
            <div className="min-w-0">
              <div className="text-sm text-brand-black">{a.text}</div>
              <div className="text-xs text-brand-gray mt-px truncate">
                {a.client_name && (
                  <>
                    <span>{a.client_name}</span>
                    <span className="px-1">/</span>
                  </>
                )}
                <span className="font-medium">
                  {a.project_name || "Portfolio"}
                </span>{" "}
                · {a.owner || "Unassigned"}
              </div>
            </div>
            <span
              className={clsx(
                "text-xs tabular-nums whitespace-nowrap",
                isOverdue ? "font-semibold text-brand-red" : "text-brand-gray"
              )}
              title={
                a.due_date
                  ? `Due ${format(parseISO(a.due_date), "MMM d, yyyy")}`
                  : undefined
              }
            >
              {a.due_date ? dueLabel(a.due_date) : "no due date"}
            </span>
            <StatusPill status={a.status} />
          </div>
        );
      })}
    </div>
  );
}

function AgendasList({
  items,
  onOpen,
  emptyHint,
  dense,
}: {
  items: DashboardAgenda[];
  onOpen: (id: number) => void;
  emptyHint?: string;
  dense?: boolean;
}) {
  if (items.length === 0 && emptyHint) {
    return <div className="text-xs text-brand-gray italic">{emptyHint}</div>;
  }
  return (
    <div>
      {items.map((a) => (
        <button
          key={a.id}
          onClick={() => onOpen(a.id)}
          className={clsx(
            "grid w-full grid-cols-[1fr_auto] items-center gap-3.5 py-[11px] text-left",
            "border-b border-b-surface-page last:border-b-0 hover:bg-surface-rowhover transition",
            dense ? "-mx-2 px-2" : "px-5"
          )}
        >
          <div className="min-w-0">
            <div className="text-sm font-medium text-brand-black truncate">
              {a.title || "Pre-meeting agenda"}
            </div>
            <div className="text-xs text-brand-gray mt-px truncate">
              {a.client_name && (
                <>
                  <span>{a.client_name}</span>
                  <span className="px-1">/</span>
                </>
              )}
              <span>{a.project_name}</span>
            </div>
          </div>
          <div className="text-sm text-brand-red font-semibold whitespace-nowrap">
            {format(parseISO(a.upcoming_date), "EEE, MMM d")}
          </div>
        </button>
      ))}
    </div>
  );
}

function NotesList({
  items,
  emptyHint,
  dense,
}: {
  items: DashboardNote[];
  emptyHint?: string;
  dense?: boolean;
}) {
  if (items.length === 0 && emptyHint) {
    return <div className="text-xs text-brand-gray italic">{emptyHint}</div>;
  }
  return (
    <div>
      {items.map((n) => (
        <div
          key={n.id}
          className={clsx(
            "py-2 border-b border-b-surface-page last:border-b-0",
            dense ? "" : "px-5"
          )}
        >
          <div className="text-[13px] text-brand-black">
            {n.topic || "(no topic)"}
          </div>
          <div className="text-[11px] text-brand-gray mt-px truncate">
            {n.client_name && (
              <>
                {n.client_name} <span className="px-1">/</span>
              </>
            )}
            {n.project_name} ·{" "}
            {n.follow_up_date
              ? `follow up ${format(parseISO(n.follow_up_date), "MMM d")}`
              : "no follow-up date"}
          </div>
        </div>
      ))}
    </div>
  );
}

function Loader() {
  return (
    <div className="px-5 py-8 text-center text-sm text-brand-gray italic">
      Loading…
    </div>
  );
}
