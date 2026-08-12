/**
 * Pick the sub-project ("Project") an item belongs to, inside one portfolio.
 *
 * ONE COMPONENT ON PURPOSE. Sub-project tagging is being rolled out across the
 * app — action items first, then meetings, change orders and schedules — and
 * every one of those needs the same control with the same rules. A second
 * implementation would drift, and the rule it would drift on is the one that
 * matters: only sub-projects OF THIS PORTFOLIO may be offered.
 *
 * PORTFOLIO-WIDE IS THE DEFAULT, not an afterthought. The empty option is
 * listed first and is what every existing item already is. Tagging is an extra
 * step someone takes deliberately; nothing here nags for it, and there is no
 * "unassigned" styling implying an item is incomplete without one.
 *
 * The server validates the same rule independently (api/actions.py::
 * _resolve_sub_project). This picker is convenience, not enforcement — it
 * cannot be the only thing standing between a mis-filed id and the database.
 */
import { useEffect, useState } from "react";
import { listPortfolioProjects } from "@/lib/api";
import type { PortfolioProject } from "@/lib/types";

/** Cache keyed by portfolio id. A rolling-actions list can hold dozens of rows
 *  from the same handful of portfolios; without this, every row would fetch the
 *  same list again. Module-level so it survives row remounts within a session,
 *  and deliberately not invalidated on a timer — sub-projects change rarely,
 *  and `refresh()` covers the case where one is added while the page is open. */
const cache = new Map<number, PortfolioProject[]>();
const inflight = new Map<number, Promise<PortfolioProject[]>>();

export function loadSubProjects(portfolioId: number): Promise<PortfolioProject[]> {
  const hit = cache.get(portfolioId);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(portfolioId);
  if (pending) return pending;
  const p = listPortfolioProjects(portfolioId)
    .then((rows) => {
      cache.set(portfolioId, rows);
      inflight.delete(portfolioId);
      return rows;
    })
    .catch((e) => {
      inflight.delete(portfolioId);
      throw e;
    });
  inflight.set(portfolioId, p);
  return p;
}

/** Drop the cache for a portfolio (or all of them) after a sub-project is
 *  created or renamed elsewhere in the app. */
export function invalidateSubProjects(portfolioId?: number) {
  if (portfolioId == null) cache.clear();
  else cache.delete(portfolioId);
}

export default function SubProjectSelect({
  portfolioId,
  value,
  onChange,
  disabled,
  className,
  ariaLabel,
}: {
  /** The item's OWN portfolio — not the header selection. On a client-wide list
   *  every row can belong to a different portfolio, and offering the header's
   *  sub-projects would offer the wrong ones. */
  portfolioId: number;
  value: number | null | undefined;
  onChange: (next: number | null) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const [options, setOptions] = useState<PortfolioProject[] | null>(null);

  useEffect(() => {
    let alive = true;
    loadSubProjects(portfolioId)
      .then((rows) => alive && setOptions(rows))
      // A failed lookup must not block editing the rest of the row. The select
      // renders empty-but-usable and the server still refuses a bad id.
      .catch(() => alive && setOptions([]));
    return () => {
      alive = false;
    };
  }, [portfolioId]);

  // A portfolio with no sub-projects renders nothing at all rather than an
  // empty dropdown that looks broken. Most portfolios have none, and a control
  // with one meaningless option is worse than no control.
  if (options !== null && options.length === 0 && value == null) return null;

  return (
    <select
      className={className ?? "select text-[12.5px]"}
      value={value ?? ""}
      disabled={disabled}
      aria-label={ariaLabel ?? "Project"}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    >
      {/* First, and the default. */}
      <option value="">Whole portfolio</option>
      {(options ?? []).map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
      {/* A tag whose sub-project has since been deleted or moved would
          otherwise vanish from the select and silently read as "Whole
          portfolio" — showing the value while it loads, and keeping a stale id
          visible, is the honest behaviour. */}
      {value != null && !(options ?? []).some((s) => s.id === value) && (
        <option value={value}>
          {options === null ? "…" : "(project no longer available)"}
        </option>
      )}
    </select>
  );
}
