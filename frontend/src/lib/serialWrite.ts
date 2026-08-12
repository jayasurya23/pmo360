/**
 * Per-key write serialisation.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Actions and Notes save by firing a PATCH straight from the inline editor's
 * commit — there is no useAutoSave on either page. DraftField commits on an
 * idle debounce as well as on blur (see components/DraftField.tsx for why it
 * must), so composing one sentence with normal thinking pauses now produces
 * several PATCHes for the same row instead of one:
 *
 *     PATCH /actions/12  {text: "Confirm IE study"}
 *     PATCH /actions/12  {text: "Confirm IE study scope with"}
 *     PATCH /actions/12  {text: "Confirm IE study scope with Duke by Friday"}
 *
 * Each payload carries the whole column and each earlier one is a strict
 * PREFIX of the later ones. `apiClient` is a bare axios instance with no
 * request queue, so those are concurrent on the wire, and neither
 * `PATCH /actions/{id}` nor `PATCH /notes/{id}` carries a version token — the
 * backend is last-writer-wins. One slow round-trip (cold container, a DB
 * hiccup) is enough for the FIRST write to land LAST, leaving the row
 * truncated mid-sentence in the database while the browser still shows the
 * full text. Nothing surfaces it until the next page load.
 *
 * Making the debounce longer only makes that rarer; it cannot make it safe,
 * because a pause longer than the window still produces two writes. And
 * lengthening it would widen the window in which a closed tab loses typed
 * text, which is the thing DraftField exists to protect.
 *
 * So instead: writes for the same key go out one at a time, each starting only
 * after the previous one has settled. Arrival order then equals issue order,
 * and last-writer-wins lands on the newest text by construction.
 *
 * Different keys stay fully parallel — a bulk update across 40 rows is still
 * 40 concurrent requests.
 *
 * ============================================================================
 * USING IT
 * ============================================================================
 *   void serialWrite(`action:${id}`, () => updateAction(id, { text }))
 *     .catch(...)
 *
 * The returned promise settles with the caller's own result/error. A rejection
 * does NOT poison the chain: the next write for that key still runs.
 */

/** Tail of the in-flight chain per key. Absent once a key goes quiet. */
const tails = new Map<string, Promise<unknown>>();

export function serialWrite<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Run on BOTH settle paths: a rejected predecessor must not stop the writes
  // queued behind it.
  const result = prev.then(run, run);
  // The chain link swallows errors so the next `.then(run, run)` still fires;
  // the caller gets `result`, which keeps its own rejection.
  const link: Promise<unknown> = result.catch(() => undefined);
  tails.set(key, link);
  // Drop the entry once this link is still the tail, so a long session across
  // hundreds of rows doesn't retain a settled promise per row.
  void link.then(() => {
    if (tails.get(key) === link) tails.delete(key);
  });
  return result;
}
