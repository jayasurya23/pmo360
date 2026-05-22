/**
 * Tab-to-indent keydown handler for `<textarea>` elements.
 *
 * Mirrors the global handler the Streamlit version injected:
 *   - Tab         → insert 2 spaces at the cursor (replaces any selection)
 *   - Shift+Tab   → drop up to 2 leading spaces from the line the cursor is on
 *
 * Works with React-controlled textareas because we set `.value` through the
 * native HTMLTextAreaElement setter and then dispatch a bubbling 'input'
 * event so React's onChange fires and state stays in sync.
 */
export function handleTextareaTab(
  e: React.KeyboardEvent<HTMLTextAreaElement>
): void {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const ta = e.currentTarget;
  const value = ta.value;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;

  let newValue = value;
  let newStart = start;
  let newEnd = end;

  if (e.shiftKey) {
    const before = value.slice(0, start);
    const sel = value.slice(start, end);
    const after = value.slice(end);
    const lineStart = before.lastIndexOf("\n") + 1;
    const head = value.slice(lineStart, start);
    const trimmedHead = head.replace(/^ {1,2}/, "");
    const drop = head.length - trimmedHead.length;
    if (drop === 0) return;
    newValue = value.slice(0, lineStart) + trimmedHead + sel + after;
    newStart = start - drop;
    newEnd = end - drop;
  } else {
    newValue = value.slice(0, start) + "  " + value.slice(end);
    newStart = start + 2;
    newEnd = start + 2;
  }

  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  if (setter) {
    setter.call(ta, newValue);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // Fallback for environments without the descriptor — set value directly
    // and fire change so a parent onChange can still pick it up.
    ta.value = newValue;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  ta.selectionStart = newStart;
  ta.selectionEnd = newEnd;
}
