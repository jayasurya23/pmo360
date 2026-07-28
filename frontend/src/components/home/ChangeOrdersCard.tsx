/**
 * ChangeOrdersCard — the change-orders mini panel on Home.
 *
 * Summarises the two states that matter at a glance — Pending approval
 * (awaiting sign-off) and Approved (signed, billable) — each as a dollar total
 * + count, followed by the most recent few. Leadership wants a single
 * cross-portfolio view of money in flight without opening each portfolio.
 *
 * The change orders are fetched once by Home (see useHomeData) and shared with
 * the KPI tile and the activity feed.
 *
 * Hidden entirely when there are no submitted change orders (pending +
 * approved == 0). Drafts alone don't warrant space — they're per-portfolio WIP.
 */
import { useNavigate } from "react-router-dom";

import type { ChangeOrder } from "@/lib/types";
import { money } from "./useHomeData";

export default function ChangeOrdersCard({
  cos,
  loading,
}: {
  cos: ChangeOrder[];
  loading: boolean;
}) {
  const nav = useNavigate();

  const pending = cos.filter((c) => c.status === "pending");
  const approved = cos.filter((c) => c.status === "approved");

  // Keep Home uncluttered when there's nothing billable in flight.
  if (!loading && pending.length === 0 && approved.length === 0) return null;

  const sum = (rows: ChangeOrder[]) =>
    rows.reduce((s, c) => s + (Number(c.total_amount) || 0), 0);
  // Most recent submitted COs (the aggregate endpoint already sorts newest-first).
  const recent = [...pending, ...approved].slice(0, 5);

  return (
    <section className="card px-5 py-4">
      <div className="flex items-baseline gap-2">
        <h2 className="section-title">Change orders</h2>
        <button
          type="button"
          onClick={() => nav("/change-orders")}
          className="ml-auto text-xs font-semibold text-brand-red hover:underline shrink-0"
        >
          Open all →
        </button>
      </div>

      {loading && cos.length === 0 ? (
        <div className="mt-3 text-sm text-brand-gray italic">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 mt-3">
            <Stat
              label="Pending"
              count={pending.length}
              amount={sum(pending)}
              tone="text-brand-deepgold"
            />
            <Stat
              label="Approved"
              count={approved.length}
              amount={sum(approved)}
              tone="text-brand-green"
            />
          </div>

          <div className="mt-2.5 border-t border-surface-hairline pt-1">
            {recent.map((co) => (
              <button
                key={co.id}
                type="button"
                onClick={() => nav("/change-orders")}
                className="flex w-full items-center justify-between gap-2.5 py-1.5 text-[13px] text-left -mx-2 px-2 rounded hover:bg-surface-rowhover transition"
              >
                <span className="truncate text-brand-black">
                  CO-{co.co_number}
                  {co.project_name ? ` · ${co.project_name}` : ""}
                  {co.title ? ` · ${co.title}` : ""}
                </span>
                <b className="shrink-0 tabular-nums text-brand-black">
                  {money(co.total_amount)}
                </b>
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
    <div className="rounded-lg border border-surface-border px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-gray">
        {label}
      </div>
      <div className="text-xl font-bold text-brand-black tabular-nums">
        {money(amount)}
      </div>
      <div className={`text-[11px] ${tone}`}>
        {count} CO{count === 1 ? "" : "s"}
      </div>
    </div>
  );
}
