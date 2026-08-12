/**
 * Move or copy action items to another portfolio.
 *
 * ONE DIALOG FOR BOTH because the question is the same — where does this go —
 * and only the fate of the original differs. Splitting it into two entry points
 * would make the PM decide "move or copy" before they have picked a destination,
 * which is the wrong order: they know where it belongs first.
 *
 * A MODAL, not an inline expander, and that is deliberate. The Actions page
 * already fought a bug where controls shifted under the cursor as rows changed
 * height; anything that grows a row moves every row below it. A modal costs one
 * click and moves nothing.
 *
 * The destination is a CLIENT + PORTFOLIO pair, not a flat portfolio list.
 * Portfolio names repeat across clients, and a flat list of them is exactly how
 * an action ends up filed under the wrong company.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import SubProjectSelect from "@/components/SubProjectSelect";
import { listProjects } from "@/lib/api";
import type { Client, Project } from "@/lib/types";

export type ReassignMode = "move" | "copy";

export interface ReassignTarget {
  project_id: number;
  portfolio_project_id: number | null;
}

export default function MoveActionDialog({
  open,
  count,
  /** Portfolio the selected action(s) sit in today, so the dialog can open on
   *  the right client and warn when the destination is the same place. Null
   *  when a mixed selection spans portfolios. */
  sourceProjectId,
  clients,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  count: number;
  sourceProjectId: number | null;
  clients: Client[];
  onCancel: () => void;
  onSubmit: (mode: ReassignMode, target: ReassignTarget) => Promise<void>;
}) {
  const [clientId, setClientId] = useState<number | null>(null);
  const [portfolios, setPortfolios] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [subId, setSubId] = useState<number | null>(null);
  const [busy, setBusy] = useState<ReassignMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset every time it opens. A dialog that reopens holding the last
  // destination is how an action gets moved somewhere nobody chose.
  useEffect(() => {
    if (!open) return;
    setClientId(clients[0]?.id ?? null);
    setProjectId(null);
    setSubId(null);
    setError(null);
    setBusy(null);
  }, [open, clients]);

  // Portfolios for the chosen client. `alive` guards the case where the PM
  // switches client faster than the fetch returns — without it a slow response
  // for client A can land after client B's and offer B's portfolios under A's
  // name.
  useEffect(() => {
    if (!open || clientId == null) {
      setPortfolios(null);
      return;
    }
    let alive = true;
    setPortfolios(null);
    listProjects(clientId)
      .then((rows) => {
        if (!alive) return;
        setPortfolios(rows);
      })
      .catch(() => alive && setPortfolios([]));
    return () => {
      alive = false;
    };
  }, [open, clientId]);

  // Clearing the sub-project when the portfolio changes is not cosmetic: the
  // server rejects a sub-project belonging to a different portfolio, so keeping
  // the old id would turn every portfolio switch into a 400.
  useEffect(() => {
    setSubId(null);
  }, [projectId]);

  const sameAsSource = projectId != null && projectId === sourceProjectId;
  const noun = count === 1 ? "action" : `${count} actions`;

  const destinationLabel = useMemo(() => {
    const p = (portfolios ?? []).find((x) => x.id === projectId);
    return p?.name ?? "";
  }, [portfolios, projectId]);

  if (!open) return null;

  async function run(mode: ReassignMode) {
    if (projectId == null) return;
    setBusy(mode);
    setError(null);
    try {
      await onSubmit(mode, {
        project_id: projectId,
        portfolio_project_id: subId,
      });
    } catch (e: any) {
      // Surface the server's own words. It names the offending sub-project and
      // the portfolio that owns it, which is more useful than anything this
      // component could infer.
      setError(
        e?.response?.data?.detail ||
          e?.message ||
          "That did not go through. Nothing was changed.",
      );
      setBusy(null);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-action-title"
    >
      <div
        className="absolute inset-0 bg-brand-black/40 backdrop-blur-sm"
        onClick={() => !busy && onCancel()}
      />
      <div className="card relative w-full max-w-md space-y-4 p-5 shadow-xl">
        <div className="space-y-1">
          <h3 id="move-action-title" className="text-base font-semibold text-brand-black">
            Move or copy {noun}
          </h3>
          <p className="text-[12.5px] leading-[1.5] text-brand-gray">
            <strong>Move</strong> re-files {count === 1 ? "it" : "them"} under
            another portfolio.{" "}
            <strong>Copy</strong> leaves the original in place and adds a second
            copy — for one commitment that binds two portfolios.
          </p>
        </div>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-gray">
              Client
            </span>
            <select
              className="select w-full text-[13px]"
              value={clientId ?? ""}
              onChange={(e) => {
                setClientId(e.target.value ? Number(e.target.value) : null);
                setProjectId(null);
              }}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-gray">
              Portfolio
            </span>
            <select
              className="select w-full text-[13px]"
              value={projectId ?? ""}
              disabled={portfolios === null}
              onChange={(e) =>
                setProjectId(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">
                {portfolios === null ? "Loading…" : "Choose a portfolio…"}
              </option>
              {(portfolios ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          {/* Optional third tier, and only when the destination has one.
              Portfolio-wide stays the default here exactly as it is on the row. */}
          {projectId != null && (
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-gray">
                Project <span className="font-normal normal-case">(optional)</span>
              </span>
              <SubProjectSelect
                portfolioId={projectId}
                value={subId}
                className="select w-full text-[13px]"
                ariaLabel="Destination project"
                onChange={setSubId}
              />
            </label>
          )}
        </div>

        {sameAsSource && (
          <p className="text-[12px] text-brand-gray">
            That is where {count === 1 ? "it already lives" : "they already live"}
            . Copying here would just duplicate {count === 1 ? "it" : "them"} in
            place.
          </p>
        )}

        {error && (
          <p className="rounded border border-brand-red/40 bg-brand-red/5 px-3 py-2 text-[12.5px] text-brand-red">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={!!busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => run("copy")}
            disabled={projectId == null || !!busy}
          >
            {busy === "copy" ? "Copying…" : "Copy here"}
          </button>
          <button
            type="button"
            className={clsx("btn-primary")}
            onClick={() => run("move")}
            disabled={projectId == null || !!busy || sameAsSource}
            title={
              destinationLabel ? `Move to ${destinationLabel}` : "Pick a portfolio first"
            }
          >
            {busy === "move" ? "Moving…" : "Move here"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
