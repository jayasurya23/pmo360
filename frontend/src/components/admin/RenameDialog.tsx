/**
 * Modal for renaming the active client or portfolio.
 *
 * `kind="client"`    → PATCH /api/clients/{id}   (name + optional email domain)
 * `kind="portfolio"` → PATCH /api/projects/{id}   (name + optional scope)
 *
 * Pre-fills from the current selection, saves, refreshes the relevant list,
 * and re-asserts the selection so the URL slug picks up the new name.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { updateClient, updateProject } from "@/lib/api";
import { useApp } from "@/lib/state";

interface Props {
  open: boolean;
  kind: "client" | "portfolio";
  onClose: () => void;
}

export default function RenameDialog({ open, kind, onClose }: Props) {
  const {
    currentClient,
    currentProject,
    refreshClients,
    refreshProjects,
    setSelectedClientId,
    setSelectedProjectId,
  } = useApp();

  const entity = kind === "client" ? currentClient : currentProject;
  const [name, setName] = useState("");
  const [secondary, setSecondary] = useState(""); // email_domain | scope
  // Portfolio-only reusable project facts.
  const [location, setLocation] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [sizeMw, setSizeMw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form from the current entity whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(entity?.name ?? "");
    setSecondary(
      kind === "client"
        ? (currentClient?.email_domain ?? "")
        : (currentProject?.scope ?? ""),
    );
    setLocation(currentProject?.location ?? "");
    setStateCode(currentProject?.state ?? "");
    setSizeMw(currentProject?.size_mw ?? "");
    setError(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open || !entity) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (kind === "client") {
        await updateClient(entity!.id, {
          name: trimmed,
          email_domain: secondary.trim(),
        });
        await refreshClients();
        setSelectedClientId(entity!.id); // re-sync URL slug to the new name
      } else {
        await updateProject(entity!.id, {
          name: trimmed,
          scope: secondary.trim(),
          location: location.trim(),
          state: stateCode.trim(),
          size_mw: sizeMw.trim(),
        });
        await refreshProjects();
        setSelectedProjectId(entity!.id);
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || `Failed to rename ${kind}`);
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-title"
    >
      <div
        className="absolute inset-0 bg-brand-black/40 backdrop-blur-sm"
        onClick={() => !submitting && onClose()}
      />
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-md card p-5 space-y-4 shadow-xl"
      >
        <h3 id="rename-title" className="text-base font-semibold text-brand-black">
          {kind === "client" ? "Rename client" : "Edit portfolio"}
        </h3>

        <div>
          <label className="label">Name</label>
          <input
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        </div>

        <div>
          <label className="label">
            {kind === "client" ? "Email domain (optional)" : "Scope (optional)"}
          </label>
          <input
            type="text"
            className="input"
            placeholder={kind === "client" ? "acme.com" : "Brief scope summary"}
            value={secondary}
            onChange={(e) => setSecondary(e.target.value)}
          />
        </div>

        {kind === "portfolio" && (
          <div className="space-y-3 border-t border-surface-hairline pt-3">
            <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
              Project details — reused on Change Orders &amp; documents
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block col-span-2">
                <span className="label">Location</span>
                <input
                  type="text"
                  className="input"
                  placeholder="City / site"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">State</span>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. TN"
                  value={stateCode}
                  onChange={(e) => setStateCode(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Size (MW)</span>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. 8"
                  value={sizeMw}
                  onChange={(e) => setSizeMw(e.target.value)}
                />
              </label>
            </div>
          </div>
        )}

        {error && (
          <div className="text-sm text-status-open-text bg-status-open-bg border border-status-open-border rounded-md px-3 py-2">
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
            disabled={submitting || !name.trim()}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
