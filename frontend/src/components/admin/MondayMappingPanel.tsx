/**
 * Map monday.com projects onto our portfolios and sub-projects.
 *
 * WHY THIS SCREEN EXISTS AT ALL. Monday keeps one flat list of projects; we
 * keep Client → Portfolio → Project. Measured against the live boards, 17 of 39
 * Monday projects match one of ours by name, 3 match more than one, and 19
 * match nothing. Worse, the projects that actually CARRY RFIs are mostly in the
 * second two groups — auto-matching alone reaches about a tenth of them. So
 * this is not a convenience over the automatic pass; it is how the integration
 * becomes useful.
 *
 * MANY-TO-MANY IN BOTH DIRECTIONS, because both happen and the split shifts as
 * work is re-scoped:
 *   - one Monday project covering several of ours ("Highland South (1 & 2)")
 *   - one of ours drawing from several Monday projects (Coal City 1 / 2 / 3)
 * So each row shows a LIST of links with individual remove buttons, never a
 * single picker that would silently replace what is already there.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useApp } from "@/lib/state";
import {
  autoMapMonday,
  clearMondayMapping,
  listMondayProjects,
  mondayStatus,
  setMondayMapping,
  type AutoMapResult,
  type MondayProject,
  type MondayStatus,
  type MondayTarget,
} from "@/lib/api";
import { listPortfolioProjects } from "@/lib/api";
import type { PortfolioProject, Project } from "@/lib/types";

/** Every mappable row, flattened once so the picker can offer both tiers. */
interface Choice {
  key: string;
  kind: "portfolio" | "project";
  id: number;
  label: string;
}

export default function MondayMappingPanel() {
  const { clients, projects } = useApp();
  const [status, setStatus] = useState<MondayStatus | null>(null);
  const [rows, setRows] = useState<MondayProject[] | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [automapping, setAutomapping] = useState(false);
  const [result, setResult] = useState<AutoMapResult | null>(null);
  const [filter, setFilter] = useState<"all" | "unlinked" | "linked">("all");

  const load = useCallback(async () => {
    setError(null);
    try {
      const st = await mondayStatus();
      setStatus(st);
      if (!st.configured) {
        setRows([]);
        return;
      }
      setRows(await listMondayProjects());
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Could not load monday.com.");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Build the destination list: every portfolio, plus every sub-project under
   * every portfolio. Sub-projects are labelled with their parent because names
   * repeat across portfolios — "Beloit II" exists as both — and an unqualified
   * name is how an RFI gets filed against the wrong client.
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      const clientName = new Map(clients.map((c: any) => [c.id, c.name]));
      const base: Choice[] = projects.map((p: Project) => ({
        key: `portfolio-${p.id}`,
        kind: "portfolio",
        id: p.id,
        label: `${clientName.get((p as any).client_id) ?? "—"} › ${p.name}`,
      }));
      const subs = await Promise.all(
        projects.map((p: Project) =>
          listPortfolioProjects(p.id)
            .then((list: PortfolioProject[]) =>
              list.map((sp) => ({
                key: `project-${sp.id}`,
                kind: "project" as const,
                id: sp.id,
                label: `${clientName.get((p as any).client_id) ?? "—"} › ${p.name} › ${sp.name}`,
              })),
            )
            // One portfolio failing to list its projects must not empty the
            // whole picker.
            .catch(() => []),
        ),
      );
      if (!alive) return;
      setChoices(
        [...base, ...subs.flat()].sort((a, b) => a.label.localeCompare(b.label)),
      );
    })();
    return () => {
      alive = false;
    };
  }, [clients, projects]);

  const shown = useMemo(() => {
    if (!rows) return [];
    if (filter === "unlinked") return rows.filter((r) => r.linked.length === 0);
    if (filter === "linked") return rows.filter((r) => r.linked.length > 0);
    return rows;
  }, [rows, filter]);

  const counts = useMemo(() => {
    const linked = (rows || []).filter((r) => r.linked.length > 0).length;
    return { linked, total: rows?.length ?? 0 };
  }, [rows]);

  async function link(row: MondayProject, choiceKey: string) {
    const choice = choices.find((c) => c.key === choiceKey);
    if (!choice) return;
    setBusy(row.monday_item_id);
    setError(null);
    try {
      await setMondayMapping({
        monday_item_id: row.monday_item_id,
        project_code: row.project_code ?? null,
        kind: choice.kind,
        id: choice.id,
      });
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Could not save that link.");
    } finally {
      setBusy(null);
    }
  }

  async function unlink(row: MondayProject, target: MondayTarget) {
    setBusy(row.monday_item_id);
    setError(null);
    try {
      await clearMondayMapping({
        kind: target.kind,
        id: target.id,
        monday_item_id: row.monday_item_id,
      });
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Could not remove that link.");
    } finally {
      setBusy(null);
    }
  }

  async function runAutomap() {
    setAutomapping(true);
    setError(null);
    try {
      setResult(await autoMapMonday());
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || "Auto-match failed.");
    } finally {
      setAutomapping(false);
    }
  }

  // ---------- states that are not the table ----------
  if (status && !status.configured) {
    return (
      <div className="card p-5 text-sm text-brand-gray">
        <p className="font-semibold text-brand-black">monday.com is not connected</p>
        <p className="mt-1">
          RFIs are read from monday.com. Add a <code>MONDAY_API_TOKEN</code> to this
          environment to enable them. Everything else in PMO 360 works without it.
        </p>
      </div>
    );
  }
  if (rows === null) {
    return <div className="card p-5 text-sm text-brand-gray">Loading monday.com…</div>;
  }

  return (
    <div className="space-y-[18px]">
      <div className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
        <span className="text-[13px] text-brand-black">
          <b className="tabular-nums">{counts.linked}</b>
          <span className="text-brand-gray"> of </span>
          <b className="tabular-nums">{counts.total}</b>
          <span className="text-brand-gray"> monday.com projects linked</span>
        </span>
        <div className="flex items-center gap-1.5">
          {(["all", "unlinked", "linked"] as const).map((f) => (
            <button
              key={f}
              className={clsx(
                "rounded px-2 py-1 text-[12px] font-semibold transition",
                filter === f
                  ? "bg-brand-red text-white"
                  : "text-brand-gray hover:text-brand-red",
              )}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "unlinked" ? "Not linked" : "Linked"}
            </button>
          ))}
        </div>
        <button
          className="btn-ghost ml-auto text-xs"
          onClick={() => void runAutomap()}
          disabled={automapping}
          title="Links every monday.com project whose name matches exactly one of ours. Never overwrites a link you made."
        >
          {automapping ? "Matching…" : "Auto-match by name"}
        </button>
      </div>

      {status?.error && (
        <div className="card border-l-[3px] border-l-brand-gold p-4 text-[13px] text-brand-gray">
          monday.com answered with an error: {status.error}
        </div>
      )}
      {error && (
        <div className="card border-l-[3px] border-l-brand-red p-4 text-[13px] text-brand-red">
          {error}
        </div>
      )}

      {result && (
        <div className="card space-y-1.5 border-l-[3px] border-l-brand-green p-4 text-[13px]">
          <p className="font-semibold text-brand-black">
            Linked {result.applied.length}
            {result.skipped_ambiguous.length > 0 &&
              ` · ${result.skipped_ambiguous.length} need a decision`}
            {result.skipped_no_match.length > 0 &&
              ` · ${result.skipped_no_match.length} have no match here`}
          </p>
          {result.skipped_ambiguous.length > 0 && (
            <p className="text-brand-gray">
              Left alone because the name matches more than one of ours:{" "}
              {result.skipped_ambiguous.join("; ")}. Pick the right one below.
            </p>
          )}
          <button
            className="text-xs font-semibold text-brand-gray hover:text-brand-red"
            onClick={() => setResult(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="card divide-y divide-surface-page overflow-hidden">
        {shown.length === 0 && (
          <div className="px-5 py-6 text-sm text-brand-gray">
            Nothing to show for this filter.
          </div>
        )}
        {shown.map((row) => (
          <div key={row.monday_item_id} className="px-5 py-3.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-semibold text-brand-black">{row.name}</span>
              {row.project_code && (
                <span className="rounded bg-surface-mute px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-brand-gray">
                  {row.project_code}
                </span>
              )}
              <span className="text-[12px] text-brand-gray">
                {row.client_name || "—"}
                {row.contract_status ? ` · ${row.contract_status}` : ""}
              </span>
            </div>

            {row.linked.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {row.linked.map((t) => (
                  <li
                    key={`${t.kind}-${t.id}`}
                    className="flex items-center gap-1.5 rounded border border-surface-border bg-surface-mute px-2 py-1 text-[12px]"
                  >
                    <span className="text-brand-black">
                      {t.portfolio_name ? `${t.portfolio_name} › ` : ""}
                      {t.name}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-brand-lightgray">
                      {t.kind === "portfolio" ? "portfolio" : "project"}
                    </span>
                    <button
                      className="text-brand-lightgray transition hover:text-brand-brightred"
                      title="Remove just this link"
                      aria-label={`Unlink ${t.name}`}
                      onClick={() => void unlink(row, t)}
                      disabled={busy === row.monday_item_id}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {/* Always available, even once linked: adding a SECOND link is a
                  real case, not a mistake. */}
              <select
                className="select h-7 max-w-[26rem] text-[12px]"
                value=""
                disabled={busy === row.monday_item_id}
                aria-label={`Link ${row.name} to a portfolio or project`}
                onChange={(e) => e.target.value && void link(row, e.target.value)}
              >
                <option value="">
                  {row.linked.length ? "Link another…" : "Link to…"}
                </option>
                {choices.map((ch) => (
                  <option key={ch.key} value={ch.key}>
                    {ch.label}
                  </option>
                ))}
              </select>
              {row.linked.length === 0 && row.suggestions.length > 0 && (
                <span className="text-[12px] text-brand-gray">
                  Suggested:{" "}
                  {row.suggestions.map((sg, i) => (
                    <button
                      key={`${sg.kind}-${sg.id}`}
                      className="font-semibold text-brand-red hover:underline"
                      onClick={() => void link(row, `${sg.kind}-${sg.id}`)}
                    >
                      {i > 0 ? ", " : ""}
                      {sg.portfolio_name ? `${sg.portfolio_name} › ` : ""}
                      {sg.name}
                    </button>
                  ))}
                </span>
              )}
              {row.linked.length === 0 && row.suggestions.length === 0 && (
                <span className="text-[12px] text-brand-lightgray">
                  No match here — its RFIs will not appear in any meeting until
                  it is linked.
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
