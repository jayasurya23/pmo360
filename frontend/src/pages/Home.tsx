import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";
import { fetchDashboard } from "@/lib/api";
import type { DashboardResponse } from "@/lib/types";
import { useApp } from "@/lib/state";
import { differenceInCalendarDays, parseISO, format } from "date-fns";

export default function Home() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();
  const { settings, resetDraft } = useApp();

  useEffect(() => {
    fetchDashboard()
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

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

      <section>
        <h2 className="section-title mb-3">Overdue & Soon Due Actions</h2>
        {loading ? (
          <Loader />
        ) : (data?.open_actions || []).length === 0 ? (
          <EmptyState
            title="Nothing overdue"
            hint="All clear — no rolling actions need attention right now."
          />
        ) : (
          <div className="card divide-y divide-brand-lightgray/60">
            {(data?.open_actions || []).slice(0, 10).map((a) => {
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
                    <div className="text-sm text-brand-black">
                      {a.text}
                    </div>
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
        )}
      </section>

      <section>
        <h2 className="section-title mb-3">Upcoming Pre-Meeting Agendas</h2>
        {loading ? (
          <Loader />
        ) : (data?.upcoming_agendas || []).length === 0 ? (
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
          <div className="card divide-y divide-brand-lightgray/60">
            {(data?.upcoming_agendas || []).map((a) => (
              <button
                key={a.id}
                onClick={() => nav(`/next-agenda?agenda=${a.id}`)}
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
        )}
      </section>

      <section>
        <h2 className="section-title mb-3">Follow-up Notes</h2>
        {loading ? (
          <Loader />
        ) : (data?.follow_up_notes || []).length === 0 ? (
          <EmptyState
            title="No follow-ups"
            hint="Notes with a follow-up date appear here when their date arrives."
          />
        ) : (
          <div className="card divide-y divide-brand-lightgray/60">
            {(data?.follow_up_notes || []).map((n) => (
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
                    ? `Follow up ${format(
                        parseISO(n.follow_up_date),
                        "MMM d"
                      )}`
                    : "No follow-up date"}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
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
