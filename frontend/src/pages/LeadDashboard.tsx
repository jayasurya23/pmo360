import { ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import { fetchLeadOverview } from "@/lib/api";
import type { LeadOverview } from "@/lib/types";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

/**
 * Lead Dashboard — a bird's-eye view across every portfolio, visible to every
 * signed-in user (reached via the top-left PMO 360 logo).
 *
 * Three sections: org totals, per-portfolio health (sorted worst-first by
 * overdue then open actions), and per-PM workload. Read-only; the data comes
 * from GET /api/lead/overview.
 */
export default function LeadDashboard() {
  const [data, setData] = useState<LeadOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchLeadOverview()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: any) => {
        if (!cancelled)
          setError(e?.response?.data?.detail || e?.message || "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-[22px]">
      <PageHeader
        kicker="Whole-PMO view"
        title="Lead dashboard"
        subtitle="Cross-portfolio health and team workload. Sorted worst-first, so the top row is where to look."
      />

      {loading && (
        <div className="text-sm text-brand-gray">Loading overview…</div>
      )}
      {error && <div className="text-sm text-brand-red">{error}</div>}

      {data && (
        <>
          {/* ---- Org totals ---- */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3.5">
            <Stat label="Portfolios" value={data.totals.portfolios} />
            <Stat label="Clients" value={data.totals.clients} />
            <Stat label="PMs" value={data.totals.pms} />
            <Stat label="Open actions" value={data.totals.open_actions} />
            <Stat
              label="Overdue"
              value={data.totals.overdue_actions}
              tone={data.totals.overdue_actions > 0 ? "danger" : "default"}
            />
            <Stat
              label="Open risks"
              value={data.totals.open_risks}
              tone={data.totals.open_risks > 0 ? "warn" : "default"}
            />
          </div>
          {data.totals.unassigned_open_actions > 0 && (
            <div className="text-xs text-brand-gray">
              <span className="font-semibold text-brand-red">
                {data.totals.unassigned_open_actions}
              </span>{" "}
              open action(s) have no clear owner — worth assigning.
            </div>
          )}

          {/* ---- Portfolio health ---- */}
          <section className="card overflow-hidden">
            <SectionHead title="Portfolio health" hint="sorted worst-first" />
            {data.portfolios.length === 0 ? (
              <p className="px-5 py-4 text-sm text-brand-gray">
                No portfolios yet. Create clients + portfolios to populate this
                view.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13.5px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-brand-gray font-semibold">
                      <Th edge>Portfolio</Th>
                      <Th>Client</Th>
                      <Th center>PMs</Th>
                      <Th center>Open</Th>
                      <Th center>Overdue</Th>
                      <Th center>Risks</Th>
                      <Th>Last meeting</Th>
                      <Th edge center>
                        Sched.
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.portfolios.map((p) => (
                      <tr
                        key={p.project_id}
                        className="border-t border-surface-page hover:bg-surface-rowhover transition"
                      >
                        <Td edge className="font-semibold">
                          <Link
                            to="/portfolio"
                            className="text-brand-red hover:text-brand-darkred hover:underline"
                            title="Open the per-portfolio dashboard"
                          >
                            {p.name}
                          </Link>
                        </Td>
                        <Td className="text-brand-gray">
                          {p.client_name || "—"}
                        </Td>
                        <Td center>{p.member_count || "—"}</Td>
                        <Td center>{p.open_actions || "—"}</Td>
                        <Td center>
                          <Pill n={p.overdue_actions} tone="danger" />
                        </Td>
                        <Td center>
                          <Pill n={p.open_risks} tone="warn" />
                        </Td>
                        <Td className="text-brand-gray">
                          {p.last_meeting_date
                            ? format(parseISO(p.last_meeting_date), "MMM d, yyyy")
                            : "—"}
                        </Td>
                        <Td edge center className="text-brand-gray">
                          {p.schedule_version || "—"}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ---- PM workload ---- */}
          <section className="card overflow-hidden">
            <SectionHead title="PM workload" />
            {data.pms.length === 0 ? (
              <p className="px-5 py-4 text-sm text-brand-gray">
                No PMs with portfolios or assigned actions yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13.5px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-brand-gray font-semibold">
                      <Th edge>PM</Th>
                      <Th center>Portfolios</Th>
                      <Th center>Open actions</Th>
                      <Th edge center>
                        Overdue
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pms.map((pm) => (
                      <tr
                        key={pm.user_id}
                        className="border-t border-surface-page hover:bg-surface-rowhover transition"
                      >
                        <Td edge>
                          <div className="flex items-center gap-2.5">
                            <Avatar name={pm.name} seed={pm.user_id} />
                            <div>
                              <span className="font-semibold">{pm.name}</span>
                              {pm.is_admin && (
                                <span
                                  className="ml-1.5 text-[10px] px-[7px] py-px rounded-full border border-brand-red text-brand-red align-middle"
                                  title="Admin / lead"
                                >
                                  admin
                                </span>
                              )}
                              <div className="text-[11px] text-brand-gray font-normal">
                                {pm.email}
                              </div>
                            </div>
                          </div>
                        </Td>
                        <Td center>{pm.portfolios || "—"}</Td>
                        <Td center>{pm.open_actions || "—"}</Td>
                        <Td edge center>
                          <Pill n={pm.overdue_actions} tone="danger" />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Card header strip — sits above the table, divided by a hairline. */
function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-5 py-3.5 border-b border-surface-hairline flex items-baseline gap-2.5">
      <h3 className="section-title">{title}</h3>
      {hint && <span className="text-xs text-brand-gray">{hint}</span>}
    </div>
  );
}

/* Table cells: `edge` gives the outer columns the card's 20px gutter, the rest
   sit on a tighter 12px rhythm. */
function Th({
  children,
  center,
  edge,
}: {
  children: ReactNode;
  center?: boolean;
  edge?: boolean;
}) {
  return (
    <th
      className={clsx(
        "py-2.5 font-semibold",
        edge ? "px-5" : "px-3",
        center && "text-center",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  center,
  edge,
  className,
}: {
  children: ReactNode;
  center?: boolean;
  edge?: boolean;
  className?: string;
}) {
  return (
    <td
      className={clsx(
        "py-2.5",
        edge ? "px-5" : "px-3",
        center && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "danger" | "warn";
}) {
  const flagged = tone !== "default" && value > 0;
  return (
    <div
      className={clsx(
        "card px-4 py-3.5",
        // Danger/warn tiles carry a 3px top rail so the row reads at a glance.
        flagged &&
          (tone === "danger"
            ? "border-t-[3px] border-t-brand-red"
            : "border-t-[3px] border-t-brand-gold"),
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.1em] text-brand-gray font-semibold">
        {label}
      </div>
      <div
        className={clsx(
          "text-[28px] font-bold mt-1 leading-tight tabular-nums",
          flagged
            ? tone === "danger"
              ? "text-brand-red"
              : "text-brand-deepgold"
            : "text-brand-black",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Pill({ n, tone }: { n: number; tone: "danger" | "warn" }) {
  if (!n) return <span className="text-brand-lightgray">—</span>;
  return (
    <span
      className={clsx(
        "inline-flex items-center justify-center min-w-[26px] px-2 py-0.5 rounded-full text-xs font-semibold",
        tone === "danger"
          ? "bg-status-open-bg text-status-open-text"
          : "bg-status-pending-bg text-status-pending-text",
      )}
    >
      {n}
    </span>
  );
}

/* Avatar tints cycle through the brand accents so adjacent PM rows stay
   distinguishable; the seed keeps a person's color stable across renders. */
const AVATAR_COLORS = ["#ad1f2b", "#5e4b40", "#1aa6c9", "#278747", "#4d4d4f"];

function Avatar({ name, seed }: { name: string; seed: number }) {
  const bg = AVATAR_COLORS[Math.abs(seed) % AVATAR_COLORS.length];
  return (
    <span
      className="h-7 w-7 shrink-0 rounded-full text-white flex items-center justify-center text-[11px] font-semibold"
      style={{ background: bg }}
    >
      {initialsFor(name)}
    </span>
  );
}

function initialsFor(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
