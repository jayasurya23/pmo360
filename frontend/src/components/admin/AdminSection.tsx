/**
 * Shell for one section of the admin console on Settings.
 *
 * Deliberately the same title strip + hairline as the personal-preference
 * cards above it, so the admin area reads as more of the same page rather
 * than a bolted-on console. Children are unpadded: these sections hold
 * full-bleed tables, which need the card's edge, not a gutter.
 */
import { useId, useState, type ReactNode } from "react";

export default function AdminSection({
  title,
  hint,
  actions,
  children,
  collapsible = false,
  open: openProp,
  onOpenChange,
  defaultOpen = true,
}: {
  title: string;
  hint?: string;
  /** Right-aligned control in the title strip (e.g. "+ New client"). In a
   *  collapsible section these stay visible while the body is folded away —
   *  that is the point: "+ New client" must not be hidden inside the thing it
   *  adds to. */
  actions?: ReactNode;
  children: ReactNode;
  /** Lets the body fold away behind a clickable title strip. Off by default so
   *  existing sections (Users) are untouched. */
  collapsible?: boolean;
  /** Controlled open state. Omit to let the section keep its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Initial state when uncontrolled. */
  defaultOpen?: boolean;
}) {
  const [inner, setInner] = useState(defaultOpen);
  const bodyId = useId();
  const open = !collapsible || (openProp ?? inner);

  function toggle() {
    const next = !open;
    if (openProp === undefined) setInner(next);
    onOpenChange?.(next);
  }

  return (
    <section className="card overflow-hidden">
      <div
        className={
          "flex items-center gap-2 px-5 py-3.5 " +
          (open ? "border-b border-surface-hairline" : "")
        }
      >
        {collapsible ? (
          // The whole title area is the control, not just a small arrow: a
          // 16px chevron is easy to miss and easy to miss-click. `actions`
          // sit OUTSIDE this button — a button inside a button is invalid and
          // would make "+ New client" unclickable on some browsers.
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={bodyId}
            className="-mx-2 -my-1.5 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-surface-rowhover focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-brand-red/40"
          >
            <Chevron open={open} />
            <h2 className="section-title">{title}</h2>
            {hint && <span className="text-xs text-brand-gray">{hint}</span>}
            <span className="flex-1" />
            {/* Words as well as a glyph: an arrow alone reads as decoration. */}
            <span className="shrink-0 text-xs font-semibold text-brand-gray">
              {open ? "Hide" : "Show"}
            </span>
          </button>
        ) : (
          <>
            <h2 className="section-title">{title}</h2>
            {hint && <span className="text-xs text-brand-gray">{hint}</span>}
            <div className="flex-1" />
          </>
        )}
        {actions}
      </div>
      {/* Kept mounted and merely hidden, never unmounted: a half-typed search,
          an unsaved row edit or a loaded list must survive a fold. */}
      <div id={bodyId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={
        "h-4 w-4 shrink-0 text-brand-gray transition-transform " +
        (open ? "rotate-90" : "")
      }
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 4l6 6-6 6" />
    </svg>
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
