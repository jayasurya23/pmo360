/**
 * Modal for creating a new client.
 *
 * Fields:
 *   - name        (required)
 *   - email_domain (optional)
 *
 * On submit: POST /api/clients, refresh the clients list, and set the newly
 * created client as the active selection so the user can immediately work
 * inside it.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/api";
import { useApp } from "@/lib/state";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function NewClientDialog({ open, onClose }: Props) {
  const { refreshClients, setSelectedClientId } = useApp();
  const [name, setName] = useState("");
  const [emailDomain, setEmailDomain] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setName("");
      setEmailDomain("");
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

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
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createClient({
        name: name.trim(),
        email_domain: emailDomain.trim() || undefined,
      });
      await refreshClients();
      setSelectedClientId(created.id);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to create client");
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-client-title"
    >
      <div
        className="absolute inset-0 bg-brand-black/40 backdrop-blur-sm"
        onClick={() => !submitting && onClose()}
      />
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-md card p-5 space-y-4 shadow-xl"
      >
        <h3
          id="new-client-title"
          className="text-base font-semibold text-brand-black"
        >
          New client
        </h3>

        <div>
          <label className="label">Name</label>
          <input
            type="text"
            className="input"
            placeholder="e.g. Acme Solar"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
          />
        </div>

        <div>
          <label className="label">Email domain (optional)</label>
          <input
            type="text"
            className="input"
            placeholder="acme.com"
            value={emailDomain}
            onChange={(e) => setEmailDomain(e.target.value)}
          />
          <p className="text-[11px] text-brand-gray mt-1">
            Used to auto-match attendees by email domain.
          </p>
        </div>

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
            {submitting ? "Creating…" : "Create client"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
