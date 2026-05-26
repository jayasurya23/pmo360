import clsx from "clsx";

/**
 * Castillo brand status palette — keep in sync with tailwind.config.js
 * `colors.status.*` and backend `config.BrandColors.STATUS_*`.
 *
 * Returns the trio of Tailwind classes (bg / text / border) for a given
 * status. Exported so the same tinting can be reused on other controls
 * (e.g. row backgrounds) without duplicating the switch.
 */
export function statusColorClasses(status: string): string {
  switch ((status || "").toLowerCase()) {
    case "open":
      return "bg-status-open-bg text-status-open-text border-status-open-border";
    case "pending":
      return "bg-status-pending-bg text-status-pending-text border-status-pending-border";
    case "completed":
      return "bg-status-completed-bg text-status-completed-text border-status-completed-border";
    case "cancelled":
      return "bg-status-cancelled-bg text-status-cancelled-text border-status-cancelled-border";
    default:
      return "bg-status-cancelled-bg text-status-cancelled-text border-status-cancelled-border";
  }
}

const STATUS_OPTIONS = ["open", "pending", "completed", "cancelled"] as const;

export function StatusPill({ status }: { status: string }) {
  const cls =
    {
      open: "pill-open",
      pending: "pill-pending",
      completed: "pill-completed",
      cancelled: "pill-cancelled",
    }[status?.toLowerCase()] || "pill-cancelled";
  return (
    <span className={cls}>
      {(status || "Open").replace(/^./, (c) => c.toUpperCase())}
    </span>
  );
}

/**
 * Drop-in status `<select>` that paints itself with the brand tint matching
 * the currently-selected value. By default it ships sized to fit inline grid
 * cells (matches the `.select` component class); pass `className` to override
 * width / rounding / padding if you need a different fit.
 */
export function StatusSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={clsx(
        "w-full rounded-lg border px-3 py-2 text-sm font-semibold",
        "focus:outline-none focus:ring-2 focus:ring-brand-red/30",
        statusColorClasses(value),
        className
      )}
    >
      {STATUS_OPTIONS.map((o) => (
        <option key={o} value={o} className="bg-white text-slate-900">
          {o.replace(/^./, (c) => c.toUpperCase())}
        </option>
      ))}
    </select>
  );
}
