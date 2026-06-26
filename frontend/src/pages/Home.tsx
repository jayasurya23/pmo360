import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";
import CalendarCard from "@/components/home/CalendarCard";
import PlannerCard from "@/components/home/PlannerCard";
import RisksCard from "@/components/home/RisksCard";
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
      : "Across all portfolios";
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
  const overdue = (data?.open_actions || []).filter(
    (a) => a.due_date && parseISO(a.due_date) < today
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Welcome to ${settings?.app.title || "PMO 360"}`}
        subtitle={settings?.app.tagline}
        actions={
          <>
            <button
              className="btn-ghost"
              onClick={() => {
                resetDraft();
                nav("/capture");
              }}
            >
              + Capture meeting notes
            </button>
            <button className="btn-primary" onClick={() => nav("/next-agenda")}>
              + New pre-meeting agenda
            </button>
          </>
        }
      />

      {/* ----- Resume in-progress meeting draft ----- */}
      <DraftResumeBanner />

      {/* ----- AI briefing card (signed-in only) ----- */}
      {isAuthenticated && (
        <BriefingCard
          briefing={briefing}
          loading={briefingLoading}
          firstName={firstName}
          onRefresh={loadBriefing}
        />
      )}

      {/* ----- Open risks rollup (signed-in only; auto-hides when empty) ----- */}
      <RisksCard />


      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard
          label="Open + Pending Actions"
          value={data?.open_actions.length || 0}
          accent="red"
        />
        <StatCard
          label="Overdue Actions"
          value={overdue.length}
          accent="gold"
        />
        <StatCard
          label="Upcoming Agendas"
          value={data?.upcoming_agendas.length || 0}
          accent="green"
        />
      </div>

      {/* ----- Personalised "Your stuff" view ----- */}
      {isAuthenticated && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 className="section-title">Your stuff</h2>
            <span
              className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full"
              style={{
                background: "rgba(199,187,46,0.15)",
                color: "#8a8021",
                border: "1px solid rgba(199,187,46,0.6)",
              }}
            >
              ✦ Personal
            </span>
          </div>

          <div
            className="card p-5 space-y-5"
            style={{
              background:
                "linear-gradient(180deg, rgba(199,187,46,0.04), transparent)",
              borderColor: "rgba(199,187,46,0.4)",
            }}
          >
            <SubSection title="Your open actions">
              <ActionsList
                items={(mine?.open_actions || []).slice(0, 5)}
                emptyHint="Nothing assigned to you"
              />
              {(mine?.open_actions || []).length > 0 && (
                <button
                  className="mt-2 text-xs font-semibold text-brand-red hover:underline"
                  onClick={() => nav("/actions?owner=mine&status=open_pending")}
                >
                  {(mine?.open_actions || []).length > 5
                    ? `View all ${mine!.open_actions.length} open actions →`
                    : "View all in Actions →"}
                </button>
              )}
            </SubSection>

            <SubSection title="Your follow-ups">
              <NotesList
                items={mine?.follow_up_notes || []}
                emptyHint="Nothing assigned to you"
              />
            </SubSection>

            <SubSection title="Your upcoming agendas">
              <AgendasList
                items={mine?.upcoming_agendas || []}
                onOpen={(id) => nav(`/next-agenda?agenda=${id}`)}
                emptyHint="Nothing assigned to you"
              />
            </SubSection>
          </div>

          {/* Upcoming Outlook meetings + my Microsoft Planner tasks — both are
              personal-to-you, so they live under "Your stuff". */}
          <CalendarCard />
          <PlannerCard />
        </section>
      )}

      {/* ----- All-portfolio rollups ----- */}
      <div className="pt-2">
        <div className="text-xs uppercase tracking-wider font-semibold text-brand-gray mb-3">
          {rollupHeader}
        </div>

        <section>
          <h2 className="section-title mb-3">Overdue & Soon Due Actions</h2>
          {loading ? (
            <Loader />
          ) : scopedActions.length === 0 ? (
            <EmptyState
              title="Nothing overdue"
              hint="All clear — no rolling actions need attention right now."
            />
          ) : (
            <>
              <ActionsList
                items={showAllOverdue ? scopedActions : scopedActions.slice(0, 5)}
              />
              {scopedActions.length > 5 && (
                <button
                  className="mt-2 text-xs font-semibold text-brand-red hover:underline"
                  onClick={() => setShowAllOverdue((v) => !v)}
                >
                  {showAllOverdue
                    ? "Show fewer"
                    : `Show all ${scopedActions.length} →`}
                </button>
              )}
            </>
          )}
        </section>

        <section className="mt-8">
          <h2 className="section-title mb-3">Upcoming Pre-Meeting Agendas</h2>
          {loading ? (
            <Loader />
          ) : scopedAgendas.length === 0 ? (
            <EmptyState
              title="No upcoming agendas"
              hint="Use the Next Agenda page to plan an upcoming meeting."
              action={
                <button
                  className="btn-primary mt-2"
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
        </section>

        <section className="mt-8">
          <h2 className="section-title mb-3">Follow-up Notes</h2>
          {loading ? (
            <Loader />
          ) : scopedNotes.length === 0 ? (
            <EmptyState
              title="No follow-ups"
              hint="Notes with a follow-up date appear here when their date arrives."
            />
          ) : (
            <NotesList items={scopedNotes} />
          )}
        </section>
      </div>
    </div>
  );
}

/* ---------- AI briefing card ---------- */
function BriefingCard({
  briefing,
  loading,
  firstName,
  onRefresh,
}: {
  briefing: Briefing | null;
  loading: boolean;
  firstName: string;
  onRefresh: () => void;
}) {
  // Skeleton: render the card shell while the first fetch is in flight so
  // the page doesn't jump when the data arrives.
  if (loading && briefing === null) {
    return (
      <div className="card p-5 border-l-4 border-l-brand-gold bg-gradient-to-r from-amber-50/40 to-white">
        <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
          Your morning briefing
        </div>
        <div className="mt-2 text-base text-brand-gray italic">
          Loading your briefing…
        </div>
      </div>
    );
  }
  if (!briefing) return null;

  const greeting = firstName ? `Good morning, ${firstName}.` : "Welcome back.";
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
      className: "bg-rose-100 text-rose-700",
    },
    {
      key: "new-actions",
      count: briefing.new_actions_assigned_to_me,
      label: "new actions",
      className: "bg-amber-100 text-amber-800",
    },
    {
      key: "meetings",
      count: briefing.new_meetings_touched,
      label: "meetings touched",
      className: "bg-sky-100 text-sky-700",
    },
    {
      key: "agendas",
      count: briefing.new_agendas_touched,
      label: "agendas touched",
      className: "bg-emerald-100 text-emerald-700",
    },
    {
      key: "follow-ups",
      count: briefing.new_follow_up_notes,
      label: "follow-up notes",
      className: "bg-slate-100 text-slate-700",
    },
  ].filter((c) => c.count > 0);

  return (
    <div className="card p-5 border-l-4 border-l-brand-gold bg-gradient-to-r from-amber-50/40 to-white relative">
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        title="Refresh briefing"
        aria-label="Refresh briefing"
        className="absolute top-3 right-3 text-brand-gray hover:text-brand-black text-base leading-none px-2 py-1 rounded hover:bg-brand-nearwhite/60 disabled:opacity-40"
      >
        {loading ? "…" : "↻"}
      </button>

      <div className="text-lg font-semibold text-brand-black">{greeting}</div>
      <div className="text-xs text-brand-gray mt-1">
        Since you were last here {whenText}, here's where things stand.
      </div>

      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((c) => (
            <span
              key={c.key}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${c.className}`}
            >
              <span className="tabular-nums font-semibold">{c.count}</span>
              <span>{c.label}</span>
            </span>
          ))}
        </div>
      )}

      <p className="mt-3 text-sm text-brand-black leading-relaxed">
        {briefing.briefing}
      </p>
    </div>
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
      <h3 className="text-sm font-semibold text-brand-black mb-2">{title}</h3>
      {children}
    </div>
  );
}

/* ---------- List renderers reused in both contexts ---------- */
function ActionsList({
  items,
  emptyHint,
}: {
  items: DashboardAction[];
  emptyHint?: string;
}) {
  if (items.length === 0 && emptyHint) {
    return (
      <div className="text-xs text-brand-gray italic px-1">{emptyHint}</div>
    );
  }
  return (
    <div className="card divide-y divide-brand-lightgray/60">
      {items.map((a) => {
        const dueText = a.due_date
          ? `${format(parseISO(a.due_date), "MMM d, yyyy")} (${dueLabel(
              a.due_date
            )})`
          : "—";
        return (
          <div
            key={a.id}
            className="px-5 py-3 grid grid-cols-[1fr_auto] gap-4 items-center"
          >
            <div>
              <div className="text-sm text-brand-black">{a.text}</div>
              <div className="text-xs text-brand-gray mt-1">
                {a.client_name && (
                  <>
                    <span>{a.client_name}</span>
                    <span className="px-1">/</span>
                  </>
                )}
                <span className="font-medium">
                  {a.project_name || "Portfolio"}
                </span>{" "}
                · {a.owner || "Unassigned"} · Due {dueText}
              </div>
            </div>
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
}: {
  items: DashboardAgenda[];
  onOpen: (id: number) => void;
  emptyHint?: string;
}) {
  if (items.length === 0 && emptyHint) {
    return (
      <div className="text-xs text-brand-gray italic px-1">{emptyHint}</div>
    );
  }
  return (
    <div className="card divide-y divide-brand-lightgray/60">
      {items.map((a) => (
        <button
          key={a.id}
          onClick={() => onOpen(a.id)}
          className="w-full text-left px-5 py-3 hover:bg-brand-nearwhite/40 grid grid-cols-[1fr_auto] gap-4 items-center"
        >
          <div>
            <div className="text-sm font-medium text-brand-black">
              {a.title || "Pre-meeting agenda"}
            </div>
            <div className="text-xs text-brand-gray mt-1">
              {a.client_name && (
                <>
                  <span>{a.client_name}</span>
                  <span className="px-1">/</span>
                </>
              )}
              <span>{a.project_name}</span>
            </div>
          </div>
          <div className="text-sm text-brand-red font-semibold">
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
}: {
  items: DashboardNote[];
  emptyHint?: string;
}) {
  if (items.length === 0 && emptyHint) {
    return (
      <div className="text-xs text-brand-gray italic px-1">{emptyHint}</div>
    );
  }
  return (
    <div className="card divide-y divide-brand-lightgray/60">
      {items.map((n) => (
        <div key={n.id} className="px-5 py-3">
          <div className="text-sm font-medium text-brand-black">
            {n.topic || "(no topic)"}
          </div>
          <div className="text-xs text-brand-gray mt-1">
            {n.client_name && (
              <>
                {n.client_name} <span className="px-1">/</span>
              </>
            )}
            {n.project_name} ·{" "}
            {n.follow_up_date
              ? `Follow up ${format(parseISO(n.follow_up_date), "MMM d")}`
              : "No follow-up date"}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: "red" | "gold" | "green";
}) {
  const accentClass = {
    red: "border-l-brand-red",
    gold: "border-l-brand-gold",
    green: "border-l-brand-green",
  }[accent];
  return (
    <div className={`card p-5 border-l-4 ${accentClass}`}>
      <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
        {label}
      </div>
      <div className="text-4xl font-bold text-brand-black mt-2 tabular-nums">
        {value}
      </div>
    </div>
  );
}

function Loader() {
  return (
    <div className="card p-6 text-center text-sm text-brand-gray">
      Loading…
    </div>
  );
}

function dueLabel(iso: string): string {
  const days = differenceInCalendarDays(parseISO(iso), new Date());
  if (days === 0) return "today";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  return `in ${days}d`;
}
