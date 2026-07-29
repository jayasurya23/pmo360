/**
 * Dollar formatting + free-text money parsing, shared by every price control.
 *
 * These lived as one-off `fmtPrice` / `fmtMoney` consts inside Proposals.tsx and
 * drifted apart — one rendered "—" for null, the other rounded. They are here so
 * the read-only rollups, the summary panels and the editable price cell all
 * agree, and so `MoneyInput` can reuse the same sanitise/group pair it needs to
 * keep a caret stable while the user types.
 *
 * Locale is pinned to en-US on purpose: the proposals these numbers end up in
 * are US contract documents, and the PDF/Excel renderers on the backend format
 * the same figures with `{:,.0f}`. A browser set to de-DE must not show
 * "12.500" beside a PDF that says "12,500".
 */

/** Integer dollars with thousands separators, no decimals: 12500 -> "$12,500". */
export const fmtMoney = (n: number | null | undefined) =>
  `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

/** Dollars and cents: 12500.5 -> "$12,500.50". */
export const fmtMoneyCents = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Keep only digits, one dot, one leading minus. Survives a pasted "$1,234.56". */
export function sanitizeMoney(s: string): string {
  const neg = s.trim().startsWith("-");
  let out = s.replace(/[^\d.]/g, "");
  const dot = out.indexOf(".");
  if (dot >= 0) out = out.slice(0, dot + 1) + out.slice(dot + 1).replace(/\./g, "");
  return (neg ? "-" : "") + out;
}

/** Group the integer part of an already-sanitized string: "1234.5" -> "1,234.5".
 *  Never touches the fraction, so a trailing "." survives while typing. */
export function groupMoney(clean: string): string {
  const neg = clean.startsWith("-");
  const body = neg ? clean.slice(1) : clean;
  const dot = body.indexOf(".");
  const int = dot >= 0 ? body.slice(0, dot) : body;
  const frac = dot >= 0 ? body.slice(dot) : "";
  return (neg ? "-" : "") + int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + frac;
}

/** Clean string -> number for the wire. "" / "-" / "." / "1." all resolve safely. */
export const parseMoney = (clean: string): number => {
  const v = Number(clean);
  return Number.isFinite(v) ? v : 0;
};
