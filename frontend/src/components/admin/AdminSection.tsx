/**
 * Shell for one section of the admin console on Settings.
 *
 * Deliberately the same title strip + hairline as the personal-preference
 * cards above it, so the admin area reads as more of the same page rather
 * than a bolted-on console. Children are unpadded: these sections hold
 * full-bleed tables, which need the card's edge, not a gutter.
 */
import type { ReactNode } from "react";

export default function AdminSection({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  /** Right-aligned control in the title strip (e.g. "+ New client"). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface-hairline px-5 py-3.5">
        <h2 className="section-title">{title}</h2>
        {hint && <span className="text-xs text-brand-gray">{hint}</span>}
        <div className="flex-1" />
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Inline server message for one row. Errors here are the backend's own
 *  refusals ("that's the last admin", "you can't offboard yourself"), so the
 *  text is quoted as-is rather than re-worded. */
export function RowMessage({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-status-open-border bg-status-open-bg px-3 py-1.5 text-xs text-status-open-text">
      {children}
    </div>
  );
}

/** Two-letter avatar. `muted` swaps the solid brand fill for a dashed ring —
 *  the shape cue that marks a deactivated user without leaning on colour. */
export function Avatar({ name, muted }: { name: string; muted?: boolean }) {
  const parts = (name || "?").trim().split(/\s+/).filter(Boolean);
  const initials = !parts.length
    ? "?"
    : parts.length === 1
      ? parts[0].slice(0, 2).toUpperCase()
      : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={
        "h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold " +
        (muted
          ? "border border-dashed border-brand-lightgray text-brand-lightgray"
          : "bg-brand-red text-white")
      }
    >
      {initials}
    </span>
  );
}
