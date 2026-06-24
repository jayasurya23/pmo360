/**
 * Modal for managing the Project tier — the free-text tags stored on the
 * selected portfolio's `sub_projects_json`.
 *
 *   mode="new"     → add a new project to the current portfolio
 *   mode="rename"  → relabel the currently-selected project
 *   mode="delete"  → remove the currently-selected project (confirm)
 *
 * Each persists via PATCH /api/projects/{id} { sub_projects_json }, then
 * refreshes the portfolio list (so the picker's Project dropdown updates) and
 * re-syncs the active Project selection.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { updateProject } from "@/lib/api";
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

  const open = mode !== null;

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
