/**
 * DraftField — the shared inline text editor for every row/list editor.
 *
 * ============================================================================
 * WHY THIS EXISTS (throughput)
 * ============================================================================
 * Every inline editor in this app used to be a plain controlled input whose
 * onChange wrote straight into a large parent state object. One keystroke then
 * re-rendered the whole page: filters re-ran, memos that scan every row were
 * invalidated, derived structures were rebuilt and every sibling editor
 * re-rendered. At a handful of rows nobody notices. At real data volumes each
 * keypress misses the frame budget and typing degrades to about a character at
 * a time — which is exactly how it was reported ("you can only type one
 * character at a time" on Rolling action items, then the same in meeting
 * minutes).
 *
 * Keystrokes now stay inside this component. The parent only hears about the
 * text on the schedule below.
 *
 * ============================================================================
 * WHY IT COMMITS THREE WAYS — DO NOT "SIMPLIFY" THIS TO BLUR-ONLY
 * ============================================================================
 * Review (meeting minutes), NextAgenda and Settings AUTOSAVE while you type,
 * via useAutoSave, off a data object rebuilt from parent state on every render.
 * If a draft were held locally and only pushed up on blur, then:
 *
 *   * an autosave fired by a NEIGHBOURING field (change the due date on the row
 *     you are typing in and 800ms later the whole meeting is PUT) persists the
 *     STALE text, and the hook then believes it is in sync, and
 *   * navigating away, closing the tab, or the meeting being submitted before
 *     the field is blurred loses everything typed since the last blur — there
 *     is no beforeunload guard and no route-change blocker anywhere in this app.
 *
 * Losing a PM's meeting notes is far worse than the stutter this fixes. So the
 * draft is pushed up on ALL THREE of:
 *
 *   1. a short idle debounce (DEFAULT_DEBOUNCE_MS) — so an autosave, whose own
 *      debounce is 800ms, always sees near-live text. Keep this comfortably
 *      under useAutoSave's window; do not raise it.
 *   2. blur — the moment the field stops being the user's focus.
 *   3. unmount — the pending timer would otherwise just be cleared.
 *
 * Be precise about what #3 buys, because it is easy to over-read. It covers
 * SUB-TREE unmounts — a row deleted, a disclosure collapsed, a filter dropping
 * the row off screen, a step advancing — where the page survives to save what
 * was flushed. It also covers Actions and Notes completely, because there the
 * commit handler IS the network write. What it does NOT cover:
 *
 *   * closing the tab or hard-refreshing — React runs no cleanup at all, and
 *     this app has no beforeunload guard;
 *   * a full route change on Review / NextAgenda — the flush reaches parent
 *     state, but useAutoSave's own cleanup then clears its pending timer
 *     without saving (lib/useAutoSave.ts), so no PUT is issued.
 *
 * Closing those two needs a beforeunload handler plus a save-on-unmount in
 * useAutoSave. That is a separate change; do not read this comment as a claim
 * that it is already done.
 *
 * A stale value can never be resurrected after a newer commit: the timer reads
 * the pending edit out of a ref (always the latest keystroke), and blur and
 * unmount both cancel the timer as part of flushing.
 *
 * WRITE ORDERING. Committing on a debounce means a page whose commit fires a
 * request per commit (Actions, Notes — neither has an autosave) now issues one
 * write per typing pause rather than one per edit. Those payloads are growing
 * prefixes of each other against endpoints with no version token, so they must
 * not race: both call sites push through lib/serialWrite.ts. If you add a
 * third such page, do the same.
 *
 * ============================================================================
 * USING IT
 * ============================================================================
 * `onCommit` MUST be referentially stable at the call site or the memo() below
 * is worthless and nothing improves. Build it with useCallback + functional
 * setState — or use the useListFieldCommit / useRecordFieldCommit helpers at
 * the bottom of this file, which do exactly that. A plain useState setter
 * (e.g. setClosingRemarks) is already stable and can be passed directly.
 *
 * The row identity (`commitKey`) and property name (`field`) are handed back to
 * onCommit rather than captured in a per-row closure, which is what lets one
 * stable handler serve every row of a list.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";

/** Row identity — a list index, a record key, or a database id. */
export type DraftKey = string | number;

/**
 * Value first so a bare `useState` setter (`(v: string) => void`) satisfies it
 * without a wrapper. Extra arguments are ignored by such setters.
 *
 * `prevValue` is the text this editor and the parent last agreed on, i.e. what
 * the row held when the edit began. A deferred commit can outlive the array it
 * was aimed at, so a positional handler can use it to check it is still
 * pointing at the right row — see useListFieldCommit.
 */
export type DraftCommit = (
  value: string,
  key: DraftKey | undefined,
  field: string | undefined,
  prevValue: string,
) => void;

/**
 * Idle window before the draft is pushed to the parent.
 *
 * Sized against useAutoSave's 800ms debounce: short enough that an autosave
 * can never fire on text this component is still sitting on, long enough that
 * a normal typing run collapses ~10 keystrokes into one parent render.
 */
const DEFAULT_DEBOUNCE_MS = 200;

interface DraftCore {
  value: string;
  onCommit: DraftCommit;
  /** Passed back to onCommit. Changing it re-points the editor at a new record. */
  commitKey?: DraftKey;
  /** Passed back to onCommit — the property name being edited. */
  field?: string;
  /** Override the idle window. Must stay well under useAutoSave's 800ms. */
  debounceMs?: number;
  /** UI side effect on blur, run after the commit. NOT a place to commit. */
  onBlur?: () => void;
}

/**
 * The draft state machine, shared by the textarea and input shapes.
 */
function useDraft({
  value,
  onCommit,
  commitKey,
  field,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  onBlur,
}: DraftCore) {
  const [draft, setDraft] = useState(value);

  // Everything the deferred commit needs, read through refs so the handlers
  // below can be created once and stay stable for the lifetime of the row.
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const keyRef = useRef(commitKey);
  keyRef.current = commitKey;
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const debounceRef = useRef(debounceMs);
  debounceRef.current = debounceMs;

  /**
   * The text the draft and the incoming `value` are known to agree on — set
   * both when we push up and when we adopt down. Without it, a value that
   * changes away and later changes back would be skipped as "ours" and the box
   * would keep showing the wrong text.
   */
  const syncedRef = useRef(value);
  /**
   * The un-pushed edit, with the key/field it belongs to at the time it was
   * made and the text the row held when the edit began (`prev`).
   */
  const pendingRef = useRef<{
    key: DraftKey | undefined;
    field: string | undefined;
    text: string;
    prev: string;
  } | null>(null);
  const timerRef = useRef<number | null>(null);
  const focusedRef = useRef(false);
  const prevKeyRef = useRef(commitKey);
  /** Latest incoming `value`, readable from event handlers (see handleBlur). */
  const valueRef = useRef(value);
  valueRef.current = value;

  /**
   * Push the pending edit up now and cancel the timer. No-op when clean.
   * Returns whether it actually called onCommit — handleBlur needs to know,
   * because straight after a commit `value` is still the pre-commit text.
   */
  const flush = useCallback((): boolean => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return false;
    // Type-then-undo (or tabbing through after a stray keypress) leaves a
    // pending edit that is identical to what the parent already has. Writing
    // it anyway costs a redundant PATCH on Actions/Notes and re-stamps the
    // row's `updated_by` with someone who changed nothing.
    if (pending.text === pending.prev) return false;
    syncedRef.current = pending.text;
    onCommitRef.current(pending.text, pending.key, pending.field, pending.prev);
    return true;
  }, []);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Commit #3 — unmount. Rescues text from a row that disappears mid-edit
  // (deleted, filtered out, its disclosure collapsed, the step advanced) and,
  // on the pages whose commit IS the write, from a route change too. Nothing
  // else runs after this. See the header for what it does NOT cover.
  useEffect(
    () => () => {
      flushRef.current();
    },
    [],
  );

  const handleChange = useCallback((next: string) => {
    setDraft(next);
    pendingRef.current = {
      key: keyRef.current,
      field: fieldRef.current,
      text: next,
      // syncedRef holds steady across a typing burst, so every keystroke of a
      // burst records the same starting text — which is what the commit needs
      // to recognise its own row later.
      prev: pendingRef.current?.prev ?? syncedRef.current,
    };
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    // Commit #1 — idle debounce, so autosave sees near-live text.
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flushRef.current();
    }, debounceRef.current);
  }, []);

  const handleFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);

  // Commit #2 — blur. `onBlur` runs AFTER the flush and is for UI side effects
  // only (closing an editing mode, say). Never put a commit in it: that is the
  // blur-only behaviour this component exists to avoid.
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    const committed = flushRef.current();
    // Re-try an adoption the focus guard below refused. That guard is right to
    // hold a value off while the cursor is in the box, but the sync effect is
    // keyed on [value, commitKey] and focus is a ref, so nothing re-runs it
    // afterwards — without this the refusal is PERMANENT. The box would go on
    // showing text the parent no longer holds (and no longer saves), and the
    // next keystroke would build on it and quietly overwrite whatever landed.
    //
    // Skipped when we just committed: `value` is still the pre-commit text
    // until the parent re-renders, so adopting here would revert what the user
    // just typed, on screen, at the moment they clicked away.
    if (!committed && valueRef.current !== syncedRef.current) {
      syncedRef.current = valueRef.current;
      setDraft(valueRef.current);
    }
    onBlurRef.current?.();
  }, []);

  // Follow `value` when it changes underneath us — a reload, a bulk update,
  // another user, or Review's post-save echo (doSave() calls setParsed(), which
  // hard-resets attendees/agenda/discussion/actions on every autosave).
  useEffect(() => {
    if (prevKeyRef.current !== commitKey) {
      // The row was recycled onto a different record. Push whatever is pending
      // to the record it was typed into — pendingRef carries the OLD key — then
      // adopt the new record's text unconditionally.
      flushRef.current();
      prevKeyRef.current = commitKey;
      syncedRef.current = value;
      setDraft(value);
      return;
    }
    if (value === syncedRef.current) return;
    // Never overwrite an edit in progress: adopting a value mid-word eats
    // characters, and the pending text is by definition newer than anything
    // arriving from outside. The pending flush pushes it up a beat later.
    if (focusedRef.current || pendingRef.current) return;
    syncedRef.current = value;
    setDraft(value);
  }, [value, commitKey]);

  return { draft, handleChange, handleFocus, handleBlur };
}

/* ============================================================
 * Textarea shape
 * ============================================================ */

export interface DraftTextareaProps extends DraftCore {
  className?: string;
  placeholder?: string;
  rows?: number;
  /** Hoist to a module constant at the call site — an inline object breaks memo. */
  style?: CSSProperties;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
}

export const DraftTextarea = memo(function DraftTextarea({
  value,
  onCommit,
  commitKey,
  field,
  debounceMs,
  onBlur,
  className,
  placeholder,
  rows,
  style,
  onKeyDown,
  disabled,
  title,
  "aria-label": ariaLabel,
}: DraftTextareaProps) {
  const { draft, handleChange, handleFocus, handleBlur } = useDraft({
    value,
    onCommit,
    commitKey,
    field,
    debounceMs,
    onBlur,
  });
  return (
    <textarea
      className={className}
      placeholder={placeholder}
      rows={rows}
      style={style}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => handleChange(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={onKeyDown}
    />
  );
});

/* ============================================================
 * Input shape
 * ============================================================ */

export interface DraftInputProps extends DraftCore {
  className?: string;
  placeholder?: string;
  /** `<datalist>` id — the risks Likelihood field uses one. */
  list?: string;
  style?: CSSProperties;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  title?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
}

export const DraftInput = memo(function DraftInput({
  value,
  onCommit,
  commitKey,
  field,
  debounceMs,
  onBlur,
  className,
  placeholder,
  list,
  style,
  onKeyDown,
  disabled,
  title,
  autoComplete,
  autoFocus,
  "aria-label": ariaLabel,
}: DraftInputProps) {
  const { draft, handleChange, handleFocus, handleBlur } = useDraft({
    value,
    onCommit,
    commitKey,
    field,
    debounceMs,
    onBlur,
  });
  return (
    <input
      type="text"
      className={className}
      placeholder={placeholder}
      list={list}
      style={style}
      disabled={disabled}
      title={title}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => handleChange(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={onKeyDown}
    />
  );
});

/* ============================================================
 * Stable commit handlers
 *
 * The whole fix rests on `onCommit` never changing identity. These build one
 * handler that serves every row and every text field of a list, using
 * functional setState so the handler never has to close over the array.
 * ============================================================ */

/**
 * For a list in state: `commitKey` is the row index, `field` the property.
 *
 *   const commitRisk = useListFieldCommit(setRisks);
 *   <DraftInput value={row.impact} commitKey={idx} field="impact"
 *               onCommit={commitRisk} />
 */
export function useListFieldCommit<T>(
  setRows: Dispatch<SetStateAction<T[]>>,
): DraftCommit {
  return useCallback(
    (value, key, field, prevValue) => {
      if (typeof key !== "number" || !field) return;
      setRows((prev) => {
        // Cast: a computed-key spread over a generic widens to
        // `T & { [x: string]: string }`, which is the same object.
        const write = (at: number) =>
          prev.map((row, i) => (i === at ? ({ ...row, [field]: value } as T) : row));
        const read = (row: T) => (row as Record<string, unknown>)?.[field];
        // Fast path: the row is where it was when the edit started.
        if (read(prev[key]) === prevValue) return write(key);
        // It is not. A commit is deferred by up to the debounce window, and
        // Review re-orders `attendees` asynchronously (doSave -> setParsed ->
        // the [parsed] effect rebuilds the list from the roster), so the index
        // captured at keystroke time can point at a DIFFERENT row by the time
        // this runs. Blur-only commits could not do this — they ran inside the
        // discrete event, before anything could move.
        //
        // Re-find the row by the text it held when the edit began.
        const moved = prev.findIndex((row) => read(row) === prevValue);
        if (moved !== -1) return write(moved);
        // Nothing holds the original text any more: the row was deleted, or an
        // external update rewrote it too. Fall back to the index — which is
        // what this did before the check existed — because dropping the commit
        // would silently discard what the PM typed, and that is the worse of
        // the two.
        return write(key);
      });
    },
    [setRows],
  );
}

/**
 * For a `Record<string, string>` in state (NextAgenda's per-discipline
 * discussion-point and recap text): `commitKey` is the record key.
 */
export function useRecordFieldCommit(
  setRecord: Dispatch<SetStateAction<Record<string, string>>>,
): DraftCommit {
  return useCallback(
    (value, key) => {
      if (key === undefined) return;
      setRecord((prev) => ({ ...prev, [String(key)]: value }));
    },
    [setRecord],
  );
}
