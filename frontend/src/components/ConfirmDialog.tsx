/**
 * Reusable confirmation modal — replaces native window.confirm across the app.
 *
 * Two usage styles:
 *
 * 1. Declarative (recommended for inline use inside a page):
 *
 *      const [askDelete, setAskDelete] = useState<Item | null>(null);
 *      ...
 *      <button onClick={() => setAskDelete(item)}>Delete</button>
 *      <ConfirmDialog
 *        open={!!askDelete}
 *        title="Delete this action?"
 *        body={askDelete?.text}
 *        confirmLabel="Delete"
 *        destructive
 *        onCancel={() => setAskDelete(null)}
 *        onConfirm={async () => {
 *          await deleteAction(askDelete!.id);
 *          setAskDelete(null);
 *        }}
 *      />
 *
 * 2. Imperative via the `useConfirm()` hook — exposes a promise that resolves
 *    true if the user confirmed, false if they cancelled. Renders the dialog
 *    into a portal so the call site doesn't have to keep state:
 *
 *      const confirm = useConfirm();
 *      const ok = await confirm({title: "Delete?", confirmLabel: "Delete"});
 *      if (ok) await deleteThing();
 *
 * Press Escape to cancel. Press Enter to confirm. Backdrop click cancels.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Optional body — plain text or React node. Long content scrolls. */
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** If true, confirm button uses the destructive (red) styling. */
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && !submitting) {
        e.preventDefault();
        handleConfirm();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, submitting]);

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={() => !submitting && onCancel()}
      />
      {/* Card */}
      <div className="relative w-full max-w-md card p-5 space-y-3 shadow-xl">
        <h3
          id="confirm-dialog-title"
          className="text-base font-semibold text-slate-900"
        >
          {title}
        </h3>
        {body !== undefined && (
          <div className="text-sm text-slate-600 max-h-60 overflow-y-auto whitespace-pre-wrap">
            {body}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={onCancel}
            disabled={submitting}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={clsx(destructive ? "btn-danger" : "btn-primary")}
            onClick={handleConfirm}
            disabled={submitting}
            autoFocus
          >
            {submitting ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ============================================================
 * Imperative hook — `const confirm = useConfirm(); await confirm({...})`.
 *
 * Provides a Promise-returning API for code that wants to call confirm()
 * inline without managing dialog state itself. Wraps the app in a
 * `<ConfirmProvider>` (mounted from main.tsx) to make `useConfirm()` work
 * everywhere.
 * ============================================================ */

type ConfirmOptions = Omit<ConfirmDialogProps, "open" | "onConfirm" | "onCancel">;

interface ConfirmContextValue {
  ask: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<
    | { opts: ConfirmOptions; resolve: (ok: boolean) => void }
    | null
  >(null);

  const ask = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ opts, resolve });
    });
  }, []);

  return (
    <ConfirmContext.Provider value={{ ask }}>
      {children}
      <ConfirmDialog
        open={state !== null}
        title={state?.opts.title || ""}
        body={state?.opts.body}
        confirmLabel={state?.opts.confirmLabel}
        cancelLabel={state?.opts.cancelLabel}
        destructive={state?.opts.destructive}
        onConfirm={async () => {
          state?.resolve(true);
          setState(null);
        }}
        onCancel={() => {
          state?.resolve(false);
          setState(null);
        }}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return ctx.ask;
}
