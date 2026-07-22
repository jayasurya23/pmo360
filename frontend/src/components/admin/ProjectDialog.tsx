/**
 * Modal for managing the Project tier under a Portfolio.
 *
 *   mode="new"     → add a new project to the current portfolio
 *   mode="rename"  → relabel the currently-selected project
 *   mode="delete"  → remove the currently-selected project (confirm)
 *
 * Each action maintains BOTH representations of a "Project" so the whole app
 * agrees on it:
 *   1. A real `PortfolioProject` row (POST/PATCH/DELETE /api/portfolio-projects)
 *      — this is what a Proposal links to (Proposal.project_id). Without it a
 *      project created here would be invisible to the proposal link picker.
 *   2. The portfolio's `sub_projects_json` tag (PATCH /api/projects/{id}) —
 *      drives the header breadcrumb dropdown and Notes filtering.
 * Then it refreshes the portfolio list and re-syncs the active selection.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  updateProject,
  listPortfolioProjects,
  createPortfolioProject,
  updatePortfolioProject,
  deletePortfolioProject,
} from "@/lib/api";
import type { PortfolioProject } from "@/lib/types";
import { useApp } from "@/lib/state";

export type ProjectMode = "new" | "rename" | "delete";

const TITLES: Record<ProjectMode, string> = {
  new: "New project",
  rename: "Rename project",
  delete: "Delete project",
};

export default function ProjectDialog({
  mode,
  onClose,
}: {
  mode: ProjectMode | null;
  onClose: () => void;
}) {
  const {
    currentProject,
    selectedSubProject,
    refreshProjects,
    setSelectedSubProject,
  } = useApp();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Real PortfolioProject rows under this portfolio — used to keep the linkable
  // project entities in sync with the sub_projects_json tags (match by name).
  const [ppList, setPpList] = useState<PortfolioProject[]>([]);

  const open = mode !== null;

  useEffect(() => {
    if (!open || !currentProject) return;
    let cancelled = false;
    listPortfolioProjects(currentProject.id)
      .then((rows) => !cancelled && setPpList(rows))
      .catch(() => !cancelled && setPpList([]));
    return () => {
      cancelled = true;
    };
  }, [open, currentProject?.id]);

  // Seed the field whenever the dialog opens (rename pre-fills the current tag).
  useEffect(() => {
    if (!open) return;
    setName(mode === "rename" ? (selectedSubProject ?? "") : "");
    setError(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open || !currentProject) return null;
  // rename/delete need a Project actually selected to act on
  if ((mode === "rename" || mode === "delete") && !selectedSubProject) return null;

  const list = currentProject.sub_projects_json || [];

  async function apply(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = name.trim();
    if ((mode === "new" || mode === "rename") && !trimmed) {
      setError("Name is required");
      return;
    }
    // Case-insensitive duplicate guard (ignore the row we're renaming).
    if (mode === "new" || mode === "rename") {
      const clash = list.some(
        (s) =>
          s.toLowerCase() === trimmed.toLowerCase() &&
          !(mode === "rename" && s === selectedSubProject),
      );
      if (clash) {
        setError(`"${trimmed}" already exists on this portfolio`);
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      // 1) Maintain the real PortfolioProject row (what proposals link to) so a
      //    project created here is immediately selectable in the proposal link
      //    picker. Match existing rows by name (case-insensitive).
      const findPP = (n: string) =>
        ppList.find(
          (p) => (p.name || "").trim().toLowerCase() === n.trim().toLowerCase(),
        );
      if (mode === "new") {
        if (!findPP(trimmed)) {
          await createPortfolioProject({
            portfolio_id: currentProject!.id,
            name: trimmed,
          });
        }
      } else if (mode === "rename") {
        const pp = selectedSubProject ? findPP(selectedSubProject) : undefined;
        if (pp) await updatePortfolioProject(pp.id, { name: trimmed });
      } else {
        const pp = selectedSubProject ? findPP(selectedSubProject) : undefined;
        if (pp) await deletePortfolioProject(pp.id);
      }

      // 2) Mirror into the portfolio's sub_projects_json tags (header breadcrumb
      //    dropdown + Notes filtering).
      let next: string[];
      if (mode === "new") next = [...list, trimmed];
      else if (mode === "rename")
        next = list.map((s) => (s === selectedSubProject ? trimmed : s));
      else next = list.filter((s) => s !== selectedSubProject);

      await updateProject(currentProject!.id, { sub_projects_json: next });
      await refreshProjects();
      // New/rename selects the resulting tag; delete clears the selection.
      setSelectedSubProject(mode === "delete" ? null : trimmed);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to save project");
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={() => !submitting && onClose()}
      />
      <form
        onSubmit={apply}
        className="relative w-full max-w-md card p-5 space-y-4 shadow-xl"
      >
        <h3 className="text-base font-semibold text-slate-900">{TITLES[mode!]}</h3>
        <p className="text-xs text-brand-gray">
          Project under{" "}
          <span className="font-medium text-slate-700">{currentProject.name}</span>.
        </p>

        {mode === "delete" ? (
          <p className="text-sm text-slate-700">
            Remove <span className="font-semibold">{selectedSubProject}</span> from
            this portfolio's projects? Notes already tagged with it keep their text —
            they just won't match the Project filter anymore.
          </p>
        ) : (
          <div>
            <label className="label">Project name</label>
            <input
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>
        )}

        {error && (
          <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          {mode === "delete" ? (
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-md bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-50"
            >
              {submitting ? "Deleting…" : "Delete"}
            </button>
          ) : (
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || !name.trim()}
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}
