/**
 * Editable dollar field that shows thousands separators *while you type*.
 *
 * It exists because `<input type="number">` cannot do this: the HTML spec's
 * floating-point value sanitiser rejects any value containing a comma, so the
 * browser blanks the field the moment one is inserted. The control is therefore
 * a plain text input with `inputMode="decimal"` (mobile still gets the numeric
 * keypad) and all grouping done by hand.
 *
 * Two details carry the whole UX:
 *
 * 1. `draft` — the raw, sanitised string the user is actually editing. The
 *    numeric `value` prop cannot represent "", "-" or "1.", so while the field
 *    is focused the draft is the source of truth and the prop is ignored.
 *    Clearing the field stays cleared instead of snapping back to "0".
 * 2. The caret fix-up — regrouping shifts every character right of an inserted
 *    digit, so the pre-edit caret index is meaningless one render later. We
 *    remember how many *value-bearing* characters sat to the left of the caret
 *    and re-seek that many in the regrouped string, in a layout effect so the
 *    correction lands before paint (a timeout or rAF shows a visible jump).
 *
 * `onChange` always emits a NUMBER — a formatted string reaching the proposal
 * tree would 422 the entire save (`price: float` on the backend).
 */
import { useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import clsx from "clsx";
import { groupMoney, parseMoney, sanitizeMoney } from "@/lib/money";

// Mirrors `cellBase` in Proposals.tsx so a MoneyInput dropped into the schedule
// table is indistinguishable from the cells beside it: plain text until you
// point at it. Deliberately carries no width or alignment — those come from the
// caller's `className`, so nothing here can fight it.
const CELL_CLS =
  "rounded-[5px] border border-transparent bg-transparent px-1 py-0.5 text-[12.5px] transition hover:border-surface-border focus:border-brand-red focus:outline-none disabled:hover:border-transparent";

/** Index in `shown` just past its `n`th digit/decimal-point character.
 *  Separators are skipped on the way, which is exactly what makes the caret
 *  survive a regroup — "1,23|4" and "12,3|4" both hold 3 value characters. */
function caretForValueChars(shown: string, n: number): number {
  // A leading "-" is not counted as a value character, so land after it rather
  // than behind it — otherwise typing at the head of "-1,234" jumps the sign.
  if (n <= 0) return shown.startsWith("-") ? 1 : 0;
  let seen = 0;
  for (let i = 0; i < shown.length; i++) {
    if (/[\d.]/.test(shown[i])) {
      seen += 1;
      if (seen === n) return i + 1;
    }
  }
  return shown.length;
}

export default function MoneyInput({
  value,
  onChange,
  className,
  disabled,
  title,
  placeholder,
}: {
  value: number;
  /** Always a number — never the formatted string. */
  onChange: (n: number) => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // Value-character count left of the caret, set only by a real keystroke/paste
  // so the layout effect below stays inert on unrelated re-renders.
  const caretChars = useRef<number | null>(null);

  const shown = groupMoney(draft ?? String(Number.isFinite(value) ? value : 0));

  useLayoutEffect(() => {
    const el = ref.current;
    const want = caretChars.current;
    if (!el || want == null) return;
    caretChars.current = null;
    const pos = caretForValueChars(el.value, want);
    el.setSelectionRange(pos, pos);
  });

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    const caret = e.target.selectionStart ?? raw.length;
    caretChars.current = (raw.slice(0, caret).match(/[\d.]/g) || []).length;
    // Drop leading zeros ahead of another digit ("05" -> "5") to match what the
    // old type="number" field did on its own. "0" and "0.5" are left alone.
    const clean = sanitizeMoney(raw).replace(/^(-?)0+(?=\d)/, "$1");
    setDraft(clean);
    onChange(parseMoney(clean));
  }

  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={clsx(CELL_CLS, className)}
      value={shown}
      disabled={disabled}
      title={title}
      placeholder={placeholder}
      onChange={handleChange}
      onFocus={() => setDraft(sanitizeMoney(String(Number.isFinite(value) ? value : 0)))}
      onBlur={() => {
        setDraft(null);
        caretChars.current = null;
      }}
    />
  );
}
