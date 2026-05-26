/**
 * Modal for deleting the currently-selected portfolio.
 *
 * Shows a danger banner with the portfolio name, fetches counts of meetings /
 * agendas / actions that will be cascaded, and requires the user to type the
 * portfolio name exactly to enable the destructive button.
 *
 * After deletion:
 *   - Clear project selection.
 *   - Refresh project list.
 *   - Re-pick the first portfolio of the same client if any, else clear.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  deleteProject,
  listMeetings,
  listAgendas,
  listActions,
  listProjects,
} from "@/lib/api";
import { useApp } from "@/lib/state";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Counts {
  meetings: number;
  agendas: number;
  actions: number;
}

export default function DeletePortfolioDialog({ open, onClose }: Props) {
  const {
    currentProject,
    selectedClientId,
    refreshProjects,
    setSelectedProjectId,
  } = useApp();

  const [confirmText, setConfirmText] = useState("");
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset and fetch counts when opened.
  useEffect(() => {
    if (!open || !currentProject) return;
    setConfirmText("");
    setError(null);
    setSubmitting(false);
    setCounts(null);
    setLoadingCounts(true);
    const projectId = currentProject.id;
    Promise.all([
      listMeetings(projectId).catch(() => []),
      listAgendas(projectId).catch(() => []),
      listActions(projectId, false).catch(() => []),
    ])
      .then(([meetings, agendas, actions]) => {
        setCounts({
          meetings: meetings.length,
          agendas: agendas.length,
          actions: actions.length,
        });
      })
      .finally(() => setLoadingCounts(false));
  }, [open, currentProject?.id]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open || !currentProject) return null;

  const expectedName = currentProject.name;
  const canDelete = confirmText.trim() === expectedName && !submitting;

  async function handleDelete() {
    if (!currentProject) return;
    setSubmitting(true);
    setError(null);
    try {
      const deletedId = currentProject.id;
      await deleteProject(deletedId);
      // After deletion: clear selection, then re-pick the first remaining
      // portfolio of the same client if any.
      setSelectedProjectId(null);
      await refreshProjects();
      if (selectedClientId) {
        try {
          const remaining = await listProjects(selectedClientId);
          const next = remaining.find((p) => p.id !== deletedId) || null;
          if (next) setSelectedProjectId(next.id);
        } catch {
          /* swallow — selection already cleared */
        }
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to delete portfolio");
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-portfolio-title"
    >
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={() => !submitting && onClose()}
      />
      <div className="relative w-full max-w-lg card p-5 space-y-4 shadow-xl">
        <h3
          id="delete-portfolio-title"
          className="text-base font-semibold text-rose-700"
        >
          Delete portfolio
        </h3>

        <div className="text-sm bg-rose-50 border border-rose-200 text-rose-800 rounded-md px-3 py-3">
          <div className="font-semibold mb-1">
            You are about to permanently delete:
          </div>
          <div className="text-base font-bold text-rose-900">{expectedName}</div>
          <div className="mt-2 text-xs text-rose-700">
            This action cannot be undone. All associated data will be removed.
          </div>
        </div>

        <div className="text-sm text-slate-700">
          {loadingCounts ? (
            <div className="text-slate-500">Counting related records…</div>
          ) : counts ? (
            <ul className="space-y-1">
              <li>
                <span className="font-semibold">{counts.meetings}</span>{" "}
                meeting{counts.meetings === 1 ? "" : "s"} will be deleted
              </li>
              <li>
                <span className="font-semibold">{counts.agendas}</span>{" "}
                agenda{counts.agendas === 1 ? "" : "s"} will be deleted
              </li>
              <li>
                <span className="font-semibold">{counts.actions}</span>{" "}
                action item{counts.actions === 1 ? "" : "s"} will be deleted
              </li>
            </ul>
          ) : null}
        </div>

        <div>
          <label className="label">
            Type the portfolio name to confirm
          </label>
          <input
            type="text"
            className="input"
            placeholder={expectedName}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoFocus
          />
        </div>

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
          <button
            type="button"
            className="btn-danger"
            onClick={handleDelete}
            disabled={!canDelete}
          >
            {submitting ? "Deleting…" : "Delete portfolio"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
