/**
 * Modal for creating a new portfolio (project) under a client.
 *
 * Fields:
 *   - client         (preselected with currentClient, can change)
 *   - name           (required)
 *   - scope          (textarea, optional)
 *   - sub_projects   (textarea, one per line, optional)
 *
 * On submit: POST /api/projects, refresh the projects list, and select the
 * newly created portfolio so the user can immediately start using it.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createProject } from "@/lib/api";
import { useApp } from "@/lib/state";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function NewPortfolioDialog({ open, onClose }: Props) {
  const {
    clients,
    selectedClientId,
    setSelectedClientId,
    refreshProjects,
    setSelectedProjectId,
  } = useApp();

  const [clientId, setClientId] = useState<number | null>(selectedClientId);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("");
  const [subProjectsText, setSubProjectsText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setClientId(selectedClientId);
      setName("");
      setScope("");
      setSubProjectsText("");
      setError(null);
      setSubmitting(false);
    }
  }, [open, selectedClientId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId) {
      setError("Pick a client");
      return;
    }
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    const subProjects = subProjectsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    setSubmitting(true);
    setError(null);
    try {
      const created = await createProject({
        client_id: clientId,
        name: name.trim(),
        scope: scope.trim() || undefined,
        sub_projects_json: subProjects.length ? subProjects : undefined,
      });
      // If the user picked a different client than the active one, switch the
      // selection first so refreshProjects loads the right list.
      if (clientId !== selectedClientId) {
        setSelectedClientId(clientId);
        // Give the state effect a tick to load projects for the new client.
        // We still call refreshProjects() afterwards to be safe.
      }
      await refreshProjects();
      setSelectedProjectId(created.id);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to create portfolio");
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-portfolio-title"
    >
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={() => !submitting && onClose()}
      />
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-lg card p-5 space-y-4 shadow-xl"
      >
        <h3
          id="new-portfolio-title"
          className="text-base font-semibold text-slate-900"
        >
          New portfolio
        </h3>

        <div>
          <label className="label">Client</label>
          <select
            className="select"
            value={clientId ?? ""}
            onChange={(e) =>
              setClientId(e.target.value ? Number(e.target.value) : null)
            }
            required
          >
            <option value="">— Pick a client —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">Name</label>
          <input
            type="text"
            className="input"
            placeholder="e.g. Heelstone / Snapdragon"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        </div>

        <div>
          <label className="label">Scope (optional)</label>
          <textarea
            className="textarea"
            rows={2}
            placeholder="Short description of the portfolio scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
        </div>

        <div>
          <label className="label">Projects (optional)</label>
          <textarea
            className="textarea"
            rows={3}
            placeholder={"One per line, e.g.\nSite A\nSite B"}
            value={subProjectsText}
            onChange={(e) => setSubProjectsText(e.target.value)}
          />
          <p className="text-[11px] text-slate-500 mt-1">
            One project per line. Used by the Notes tab to filter.
          </p>
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
            type="submit"
            className="btn-primary"
            disabled={submitting || !clientId || !name.trim()}
          >
            {submitting ? "Creating…" : "Create portfolio"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
