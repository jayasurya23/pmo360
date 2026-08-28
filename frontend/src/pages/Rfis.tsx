/**
 * RFIs — everything monday.com is tracking, at whatever width the header is set to.
 *
 * DELIBERATELY LIVE, and deliberately READ-ONLY. Monday owns RFIs; this page is
 * a window onto them, scoped through the project mapping. The snapshots stored
 * on a meeting are a different thing — a record of what was said on a date —
 * and are read from that meeting. Blurring the two is how somebody starts
 * trusting old minutes to be current, so nothing here writes and nothing here
 * pretends a meeting's copy is up to date.
 *
 * Scope mirrors the Actions page — all / client / portfolio — plus one tier
 * Actions cannot have: an RFI resolves to a specific project, so it can be
 * narrowed one level further.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { useApp } from "@/lib/state";
import { listPortfolioRfis } from "@/lib/api";
import type { MeetingRfi } from "@/lib/types";
import { format, parseISO } from "date-fns";

type Level = "all" | "client" | "portfolio";

/** monday.com's own vocabulary, not the action-item one. */
const STATUS_TONE: Record<string, string> = {
  completed: "bg-brand-green/15 text-brand-green",
  "in review": "bg-brand-gold/20 text-brand-deepgold",
  "on hold": "bg-brand-gold/20 text-brand-deepgold",
  "in progress": "bg-brand-blue/10 text-brand-blue",
  assigned: "bg-surface-mute text-brand-gray",
};

function fmt(d?: string | null) {
  if (!d) return "";
  try {
    return format(parseISO(d), "MMM d, yyyy");
  } catch {
    return d;
  }
}

export default function Rfis() {
  const { clients, currentClient, currentProject } = useApp();
  const [level, setLevel] = useState<Level>("portfolio");
  const [rows, setRows] = useState<MeetingRfi[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>("open");
  const [discipline, setDiscipline] = useState<string>("all");

  // Fall back to the widest scope the header can actually satisfy rather than
  // querying with a missing id, which would silently read as "everything".
  const effective: Level = useMemo(() => {
    if (level === "portfolio" && !currentProject) return currentClient ? "client" : "all";
    if (level === "client" && !currentClient) return "all";
    return level;
  }, [level, currentProject, currentClient]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params =
        effective === "portfolio" && currentProject
          ? { project_id: currentProject.id }
          : effective === "client" && currentClient
            ? { client_id: currentClient.id }
            : {};
      setRows(await listPortfolioRfis(params));
    } catch (e: any) {
      setError(
        e?.response?.data?.detail ||
          e?.message ||
          "Could not reach monday.com.",
      );
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [effective, currentProject?.id, currentClient?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const disciplines = useMemo(
    () =>
      Array.from(
        new Set((rows || []).map((r) => r.discipline || "").filter(Boolean)),
      ).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    let out = rows || [];
    if (status === "open") {
      // "Open" here means monday's not-finished statuses, not our action-item
      // vocabulary — Completed is the only terminal one on that board.
      out = out.filter((r) => (r.status || "").trim().toLowerCase() !== "completed");
    } else if (status !== "all") {
      out = out.filter((r) => (r.status || "").trim().toLowerCase() === status);
    }
    if (discipline !== "all") out = out.filter((r) => r.discipline === discipline);
    return out;
  }, [rows, status, discipline]);

  /** Grouped by project, the same grouping the printed minutes use. */
  const groups = useMemo(() => {
    const out = new Map<string, MeetingRfi[]>();
    for (const r of filtered) {
      const label = [
        r.client_name || "—",
        r.project_name || "—",
        r.portfolio_project_name || "Whole portfolio",
      ].join(" › ");
      if (!out.has(label)) out.set(label, []);
      out.get(label)!.push(r);
    }
    return [...out.entries()];
  }, [filtered]);

  const counts = useMemo(() => {
    const all = rows || [];
    const done = all.filter(
      (r) => (r.status || "").trim().toLowerCase() === "completed",
    ).length;
    return { total: all.length, open: all.length - done, done };
  }, [rows]);

  const scopeLabel =
    effective === "portfolio"
      ? currentProject?.name || "this portfolio"
      : effective === "client"
        ? currentClient?.name || "this client"
        : "All clients";

  return (
    <div className="space-y-[18px]">
      <PageHeader
        kicker={`${scopeLabel} · ${counts.total} from monday.com — ${counts.open} open, ${counts.done} completed`}
        title="RFIs"
        actions={
          <button
            className="btn-ghost text-xs"
            onClick={() => void load()}
            disabled={loading}
            title="Re-read the current values from monday.com"
          >
            {loading ? "Refreshing…" : "↻ Refresh"}
          </button>
        }
      />

      <div className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
        <div className="flex items-center gap-1.5">
          {(["portfolio", "client", "all"] as const).map((lv) => (
            <button
              key={lv}
              className={clsx(
                "rounded px-2 py-1 text-[12px] font-semibold transition",
                effective === lv
                  ? "bg-brand-red text-white"
                  : "text-brand-gray hover:text-brand-red",
                ((lv === "portfolio" && !currentProject) ||
                  (lv === "client" && !currentClient)) &&
                  "cursor-not-allowed opacity-40",
              )}
              disabled={
                (lv === "portfolio" && !currentProject) ||
                (lv === "client" && !currentClient)
              }
              onClick={() => setLevel(lv)}
            >
              {lv === "portfolio"
                ? "This portfolio"
                : lv === "client"
                  ? "This client"
                  : "All"}
            </button>
          ))}
        </div>

        <select
          className="select select-sm w-auto"
          value={status}
          aria-label="Filter by status"
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="open">Open (not completed)</option>
          <option value="all">All statuses</option>
          <option value="assigned">Assigned</option>
          <option value="in progress">In Progress</option>
          <option value="in review">In Review</option>
          <option value="on hold">On Hold</option>
          <option value="completed">Completed</option>
        </select>

        {disciplines.length > 0 && (
          <select
            className="select select-sm w-auto"
            value={discipline}
            aria-label="Filter by discipline"
            onChange={(e) => setDiscipline(e.target.value)}
          >
            <option value="all">All disciplines</option>
            {disciplines.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}

        <span className="ml-auto text-[11px] text-brand-lightgray">
          Live from monday.com · read-only
        </span>
      </div>

      {error && (
        <div className="card border-l-[3px] border-l-brand-red p-4 text-[13px] text-brand-red">
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="card p-5 text-sm text-brand-gray">Loading RFIs…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? "No RFIs in this scope" : "Nothing matches these filters"}
          hint={
            rows.length === 0
              ? "RFIs only appear for projects linked to monday.com. Check Settings → monday.com — an unlinked project's RFIs never reach this page."
              : "Widen the status or discipline filter."
          }
        />
      ) : (
        <div className="space-y-[18px]">
          {groups.map(([label, list]) => (
            <div key={label}>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-brand-lightgray">
                {label}
                <span className="ml-2 font-normal normal-case tracking-normal text-brand-gray">
                  {list.length} {list.length === 1 ? "RFI" : "RFIs"}
                </span>
              </div>
              <div className="card divide-y divide-surface-page overflow-hidden">
                {list.map((r) => (
                  <div
                    key={`${r.monday_item_id}-${r.portfolio_project_id ?? "w"}`}
                    className="px-5 py-3"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-brand-black">
                        {r.item_equipment || r.name}
                      </span>
                      {r.status && (
                        <span
                          className={clsx(
                            "rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide",
                            STATUS_TONE[(r.status || "").toLowerCase()] ||
                              "bg-surface-mute text-brand-gray",
                          )}
                        >
                          {r.status}
                        </span>
                      )}
                      {r.discipline && (
                        <span className="text-[11px] text-brand-gray">{r.discipline}</span>
                      )}
                    </div>
                    {(r.description || r.question) && (
                      <p className="mt-0.5 text-[12.5px] leading-[1.5] text-brand-gray">
                        {r.description || r.question}
                      </p>
                    )}
                    <div className="mt-0.5 text-[11px] text-brand-lightgray">
                      {r.name}
                      {r.assigned_to ? ` · ${r.assigned_to}` : ""}
                      {r.date_submitted ? ` · raised ${fmt(r.date_submitted)}` : ""}
                      {r.response_needed_by ? ` · needed by ${fmt(r.response_needed_by)}` : ""}
                      {/* Internal routing label. Shown here because this page is
                          for the team; it never reaches a client document. */}
                      {r.response_owner ? ` · ${r.response_owner}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
