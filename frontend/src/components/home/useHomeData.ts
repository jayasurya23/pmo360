/**
 * Shared Home data + formatters.
 *
 * The redesigned Home surfaces the same two rollups in several places at once:
 * open risks feed both the at-risk spotlight and the risk board, and change
 * orders feed a KPI tile, the activity feed and the change-orders card.
 * Fetching them here (once, from the page) keeps the network cost identical to
 * the old layout, where each card owned its own request.
 */
import { useCallback, useEffect, useState } from "react";
import { differenceInCalendarDays, parseISO } from "date-fns";

import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";
import { fetchOpenRisks, listChangeOrders, type DashboardRisk } from "@/lib/api";
import type { ChangeOrder } from "@/lib/types";

/** Risk severity buckets, ordered most-urgent first. */
export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

/** Map a free-text agenda likelihood onto a severity bucket. Anything we
 *  don't recognise (including blank) lands in "low" so it still gets counted
 *  in the risk-board bar without inflating the urgent buckets. */
export function riskSeverity(likelihood: string | null | undefined): Severity {
  switch ((likelihood || "").trim().toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

export const money = (n: number | null | undefined) =>
  `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

/** Short form for the KPI tile, which only has room for ~6 glyphs: $71.2k. */
export const compactMoney = (n: number | null | undefined) => {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}m`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v}`;
};

/** Relative due wording shared by the action rows, the KPI foot lines and the
 *  at-risk tiles: "today" / "2d overdue" / "in 3d". */
export function dueLabel(iso: string): string {
  const days = differenceInCalendarDays(parseISO(iso), new Date());
  if (days === 0) return "today";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  return `in ${days}d`;
}

/** Days past due; negative for anything still in the future. */
export function daysOverdue(iso: string): number {
  return -differenceInCalendarDays(parseISO(iso), new Date());
}

/**
 * Open risks aggregated from every portfolio's most-recent agenda.
 *
 * Scope follows the Mine/All toggle exactly as the dashboard endpoints do:
 * "mine" only applies to signed-in non-admins; admins and anonymous users
 * fall through to "all".
 */
export function useOpenRisks(): { risks: DashboardRisk[]; loading: boolean } {
  const { isAuthenticated } = useAuth();
  const { scope, me } = useApp();

  const [risks, setRisks] = useState<DashboardRisk[]>([]);
  const [loading, setLoading] = useState(false);

  const effectiveScope: "mine" | "all" =
    scope === "mine" && me !== null && !me.is_admin ? "mine" : "all";

  const load = useCallback(() => {
    if (!isAuthenticated) {
      setRisks([]);
      return;
    }
    setLoading(true);
    fetchOpenRisks(effectiveScope)
      .then(setRisks)
      .catch(() => setRisks([]))
      .finally(() => setLoading(false));
  }, [isAuthenticated, effectiveScope]);

  useEffect(() => {
    load();
  }, [load]);

  return { risks, loading };
}

/** Every portfolio's change orders in one aggregate call (no project_id). */
export function useChangeOrders(): { cos: ChangeOrder[]; loading: boolean } {
  const { isAuthenticated } = useAuth();

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

  return { cos, loading };
}
