/**
 * Debounced auto-save hook.
 *
 * Tracks a stringified snapshot of `data`. When it changes, waits
 * `debounceMs` (default 800ms) of inactivity, then calls `save()`. Surfaces
 * a `status` field consumers render as "Saved 12:42:03 · Saving… · Error".
 *
 * 409 stale-version errors are surfaced via a dedicated `"conflict"` status
 * and the optional `onConflict` callback — callers typically show a toast
 * + "Reload" button so the user can pull the latest state.
 *
 * Auto-save is skipped while `enabled` is false (e.g. before the first
 * explicit save has created a row to update — there's no `draftMeetingId`
 * yet). The user's explicit "Save" button still runs unconditionally.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError, isStaleVersionError } from "./api";

export type AutoSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

export interface UseAutoSaveOptions<T> {
  /** The current editable state — anything serializable. */
  data: T;
  /** Skip auto-save when false (e.g. no draft id yet). */
  enabled: boolean;
  /** Performs the save. Should resolve when the write completed. */
  save: (data: T) => Promise<unknown>;
  /** Optional callback when a 409 stale-version comes back. */
  onConflict?: (err: ApiError) => void;
  /** Optional callback when a non-409 error comes back. */
  onError?: (err: unknown) => void;
  /** Debounce window in ms. Default 800. */
  debounceMs?: number;
}

export interface UseAutoSaveResult {
  status: AutoSaveStatus;
  lastSavedAt: Date | null;
  errorMessage: string | null;
  /** Force a save right now (e.g. user clicked an explicit Save button). */
  saveNow: () => Promise<void>;
}

export function useAutoSave<T>({
  data,
  enabled,
  save,
  onConflict,
  onError,
  debounceMs = 800,
}: UseAutoSaveOptions<T>): UseAutoSaveResult {
  const [status, setStatus] = useState<AutoSaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Stringified snapshot of the last *successfully saved* payload. If the
  // current snapshot matches, we skip — no point firing identical writes.
  const lastSavedSnapshot = useRef<string>("");
  // Holds the latest snapshot through the debounce window so the timeout
  // sees the very newest data when it fires (not the data captured at
  // schedule time).
  const pendingSnapshot = useRef<string>("");
  // Latest `save` function — captured via ref so the debounced closure
  // always calls the current one even if the parent re-renders.
  const saveRef = useRef(save);
  saveRef.current = save;

  const timerRef = useRef<number | null>(null);
  // True while a save round-trip is in flight. Prevents overlapping calls.
  const inFlight = useRef(false);
  // Set when an edit lands during an in-flight save — kicks off another
  // save as soon as the first finishes.
  const dirtyDuringFlight = useRef(false);

  async function runSave() {
    const snapshot = pendingSnapshot.current;
    if (!snapshot) return;
    if (snapshot === lastSavedSnapshot.current) return;
    if (inFlight.current) {
      dirtyDuringFlight.current = true;
      return;
    }
    inFlight.current = true;
    setStatus("saving");
    setErrorMessage(null);
    try {
      await saveRef.current(JSON.parse(snapshot) as T);
      lastSavedSnapshot.current = snapshot;
      setLastSavedAt(new Date());
      setStatus("saved");
    } catch (err) {
      if (isStaleVersionError(err)) {
        setStatus("conflict");
        setErrorMessage(
          err instanceof Error ? err.message : "Stale version",
        );
        if (onConflict && err instanceof ApiError) onConflict(err);
      } else {
        setStatus("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Save failed",
        );
        if (onError) onError(err);
      }
    } finally {
      inFlight.current = false;
      if (dirtyDuringFlight.current) {
        dirtyDuringFlight.current = false;
        // chase the latest edits
        void runSave();
      }
    }
  }

  // Debounce edits → schedule a save.
  useEffect(() => {
    if (!enabled) return;
    const snapshot = JSON.stringify(data);
    pendingSnapshot.current = snapshot;
    // First render — capture the baseline so we don't immediately fire a
    // save with the just-hydrated state.
    if (!lastSavedSnapshot.current) {
      lastSavedSnapshot.current = snapshot;
      return;
    }
    if (snapshot === lastSavedSnapshot.current) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void runSave();
    }, debounceMs);
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(data), enabled, debounceMs]);

  // Reset baseline when `enabled` flips from false to true (i.e. a fresh
  // draft was just created). Otherwise we'd compare against an empty
  // snapshot and immediately fire a save with the hydrated form.
  useEffect(() => {
    if (enabled) {
      lastSavedSnapshot.current = JSON.stringify(data);
      setStatus("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  async function saveNow() {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingSnapshot.current = JSON.stringify(data);
    await runSave();
  }

  return { status, lastSavedAt, errorMessage, saveNow };
}


/** Helper for rendering the status. */
export function autoSaveLabel(
  status: AutoSaveStatus,
  lastSavedAt: Date | null,
  errorMessage: string | null,
): string {
  switch (status) {
    case "saving":
      return "Saving…";
    case "saved":
      return lastSavedAt
        ? `Saved · ${lastSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
        : "Saved";
    case "error":
      return errorMessage ? `Save failed · ${errorMessage}` : "Save failed";
    case "conflict":
      return "Edited by someone else — reload";
    case "idle":
    default:
      return "Auto-save enabled";
  }
}
