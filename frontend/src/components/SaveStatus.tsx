/**
 * Tiny visual indicator for the debounced auto-save state. Pair with the
 * `useAutoSave` hook — pass through its three observable values.
 *
 * Renders inline so a page can place it in a header / footer toolbar.
 */
import clsx from "clsx";
import type { AutoSaveStatus } from "@/lib/useAutoSave";
import { autoSaveLabel } from "@/lib/useAutoSave";

interface Props {
  status: AutoSaveStatus;
  lastSavedAt: Date | null;
  errorMessage: string | null;
  /** Called when user clicks "Reload" on a conflict, if provided. */
  onReload?: () => void;
}

export default function SaveStatus({
  status,
  lastSavedAt,
  errorMessage,
  onReload,
}: Props) {
  const label = autoSaveLabel(status, lastSavedAt, errorMessage);
  const dotClass = clsx("h-2 w-2 rounded-full", {
    "bg-slate-300": status === "idle",
    "bg-amber-400 animate-pulse": status === "saving",
    "bg-emerald-500": status === "saved",
    "bg-rose-500": status === "error" || status === "conflict",
  });

  return (
    <div
      className={clsx(
        "inline-flex items-center gap-2 text-xs",
        status === "error" || status === "conflict"
          ? "text-rose-600"
          : "text-slate-500",
      )}
      role="status"
      aria-live="polite"
    >
      <span className={dotClass} />
      <span>{label}</span>
      {status === "conflict" && onReload && (
        <button
          type="button"
          onClick={onReload}
          className="underline underline-offset-2 hover:text-rose-700"
        >
          Reload
        </button>
      )}
    </div>
  );
}
