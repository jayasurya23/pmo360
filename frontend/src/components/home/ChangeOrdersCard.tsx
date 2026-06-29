/**
 * ChangeOrdersCard — "📝 Change orders across portfolios" rollup on Home.
 *
 * Pulls every portfolio's change orders in one call (listChangeOrders with no
 * project_id → aggregate) and summarizes the two states that matter at a
 * glance: Pending approval (awaiting sign-off) and Approved (signed, billable),
 * each as a count + dollar total, followed by the most recent few with their
 * client / portfolio. The motivation mirrors RisksCard: leadership wants a
 * single cross-portfolio view of money in flight without opening each portfolio.
 *
 * Hidden entirely when:
 *   - the user isn't signed in
 *   - there are no submitted change orders (pending + approved == 0). Drafts
 *     alone don't warrant space — they're per-portfolio WIP.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/auth/useAuth";
import { listChangeOrders } from "@/lib/api";
import type { ChangeOrder } from "@/lib/types";

const money = (n: number | null | undefined) =>
  `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

export default function ChangeOrdersCard() {
  const { isAuthenticated } = useAuth();
  const nav = useNavigate();

  const [cos, setCos] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setCos([]);
      return;
    }
    setLoading(true);
    listChangeOrders()
      .then(setCos)
      .catch(() => setCos([]))
      .finally(() => setLoading(false));
  }, [isAuthenticated]);

  if (!isAuthenticated) return null;

  const pending = cos.filter((c) => c.status === "pending");
  const approved = cos.filter((c) => c.status === "approved");

  // Keep Home uncluttered when there's nothing billable in flight.
  if (!loading && pending.length === 0 && approved.length === 0) return null;

  const sum = (rows: ChangeOrder[]) =>
    rows.reduce((s, c) => s + (Number(c.total_amount) || 0), 0);
  // Most recent submitted COs (the aggregate endpoint already sorts newest-first).
  const recent = [...pending, ...approved].slice(0, 5);

  return (
    <section className="card p-5 border-l-4 border-l-brand-gold">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
            📝 Change orders
          </div>
          <div className="text-base font-semibold text-brand-black mt-1">
            Across all portfolios
          </div>
        </div>
        <button
          type="button"
          onClick={() => nav("/change-orders")}
          className="text-xs font-semibold text-brand-red hover:underline shrink-0"
        >
          Open all →
        </button>
      </div>

      {loading && cos.length === 0 ? (
        <div className="text-sm text-brand-gray italic">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 mb-3">
            <Stat
              label="Pending approval"
              count={pending.length}
              amount={sum(pending)}
              tone="#7a7320"
            />
            <Stat
              label="Approved"
              count={approved.length}
              amount={sum(approved)}
              tone="#278747"
            />
          </div>

          <div className="space-y-2">
            {recent.map((co) => (
              <button
                key={co.id}
                type="button"
                onClick={() => nav("/change-orders")}
                className="w-full text-left card px-4 py-2 hover:border-brand-red transition flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm text-brand-black truncate">
                    CO-{co.co_number}
                    {co.title ? ` · ${co.title}` : ""}
                  </div>
                  <div className="text-xs text-brand-gray truncate">
                    {co.client_name && (
                      <>
                        {co.client_name}
                        <span className="px-1">/</span>
                      </>
                    )}
                    <span className="font-medium">{co.project_name || "—"}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-brand-black tabular-nums">
                    {money(co.total_amount)}
                  </div>
                  <div
                    className="text-[10px] uppercase tracking-wide font-semibold"
                    style={{ color: co.status === "approved" ? "#278747" : "#7a7320" }}
                  >
                    {co.status === "approved" ? "Approved" : "Pending"}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Stat({
  label,
  count,
  amount,
  tone,
}: {
  label: string;
  count: number;
  amount: number;
  tone: string;
}) {
  return (
    <div className="rounded-lg border border-brand-lightgray/60 px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
        {label}
      </div>
      <div className="text-2xl font-bold text-brand-black mt-1 tabular-nums">
        {money(amount)}
      </div>
      <div className="text-xs mt-0.5" style={{ color: tone }}>
        {count} change order{count === 1 ? "" : "s"}
      </div>
    </div>
  );
}
