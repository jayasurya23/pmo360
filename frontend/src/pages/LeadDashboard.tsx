import { useEffect, useState } from "react";
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
    <div className="space-y-6">
      <PageHeader
        title="Lead dashboard"
        subtitle="Cross-portfolio health and team workload across the whole PMO."
      />

      {loading && (
        <div className="text-sm text-brand-gray">Loading overview…</div>
      )}
      {error && <div className="text-sm text-brand-red">{error}</div>}

      {data && (
        <>
          {/* ---- Org totals ---- */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
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
          <section className="card p-5">
            <h3 className="section-title mb-3">Portfolio health</h3>
            {data.portfolios.length === 0 ? (
              <p className="text-sm text-brand-gray">
                No portfolios yet. Create clients + portfolios to populate this
                view.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-brand-gray border-b border-brand-lightgray/60">
                      <th className="py-2 pr-3">Portfolio</th>
                      <th className="py-2 pr-3">Client</th>
                      <th className="py-2 pr-3 text-center">PMs</th>
                      <th className="py-2 pr-3 text-center">Open</th>
                      <th className="py-2 pr-3 text-center">Overdue</th>
                      <th className="py-2 pr-3 text-center">Risks</th>
                      <th className="py-2 pr-3">Last meeting</th>
                      <th className="py-2 pr-3 text-center">Sched.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.portfolios.map((p) => (
                      <tr
                        key={p.project_id}
                        className="border-b border-brand-lightgray/40 last:border-0"
                      >
                        <td className="py-2 pr-3 font-medium">
                          <Link
                            to="/portfolio"
                            className="hover:text-brand-red"
                            title="Open the per-portfolio dashboard"
                          >
                            {p.name}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 text-brand-gray">
                          {p.client_name || "—"}
                        </td>
                        <td className="py-2 pr-3 text-center">
                          {p.member_count || "—"}
                        </td>
                        <td className="py-2 pr-3 text-center">
                          {p.open_actions || "—"}
                        </td>
                        <td className="py-2 pr-3 text-center">
                          <Pill n={p.overdue_actions} tone="danger" />
                        </td>
                        <td className="py-2 pr-3 text-center">
                          <Pill n={p.open_risks} tone="warn" />
                        </td>
                        <td className="py-2 pr-3 text-brand-gray">
                          {p.last_meeting_date
                            ? format(parseISO(p.last_meeting_date), "MMM d, yyyy")
                            : "—"}
                        </td>
                        <td className="py-2 pr-3 text-center text-brand-gray">
                          {p.schedule_version || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ---- PM workload ---- */}
          <section className="card p-5">
            <h3 className="section-title mb-3">PM workload</h3>
            {data.pms.length === 0 ? (
              <p className="text-sm text-brand-gray">
                No PMs with portfolios or assigned actions yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-brand-gray border-b border-brand-lightgray/60">
                      <th className="py-2 pr-3">PM</th>
                      <th className="py-2 pr-3 text-center">Portfolios</th>
                      <th className="py-2 pr-3 text-center">Open actions</th>
                      <th className="py-2 pr-3 text-center">Overdue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pms.map((pm) => (
                      <tr
                        key={pm.user_id}
                        className="border-b border-brand-lightgray/40 last:border-0"
                      >
                        <td className="py-2 pr-3 font-medium">
                          {pm.name}
                          {pm.is_admin && (
                            <span
                              className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border border-brand-red text-brand-red align-middle"
                              title="Admin / lead"
                            >
                              admin
                            </span>
                          )}
                          <div className="text-[11px] text-brand-gray font-normal">
                            {pm.email}
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-center">
                          {pm.portfolios || "—"}
                        </td>
                        <td className="py-2 pr-3 text-center">
                          {pm.open_actions || "—"}
                        </td>
                        <td className="py-2 pr-3 text-center">
                          <Pill n={pm.overdue_actions} tone="danger" />
                        </td>
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

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "danger" | "warn";
}) {
  return (
    <div
      className={clsx(
        "card p-4 border-l-4",
        tone === "danger" && value > 0
          ? "border-l-brand-red"
          : tone === "warn" && value > 0
            ? "border-l-[#c7bb2e]"
            : "border-l-brand-lightgray",
      )}
    >
      <div className="text-[11px] uppercase tracking-wider text-brand-gray">
        {label}
      </div>
      <div
        className={clsx(
          "text-2xl font-bold",
          tone === "danger" && value > 0 && "text-brand-red",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Pill({ n, tone }: { n: number; tone: "danger" | "warn" }) {
  if (!n) return <span className="text-brand-gray">—</span>;
  return (
    <span
      className={clsx(
        "inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-full text-xs font-semibold",
        tone === "danger"
          ? "bg-[#fce8ea] text-[#791f1f]"
          : "bg-[#fdeac0] text-[#5e3f00]",
      )}
    >
      {n}
    </span>
  );
}
