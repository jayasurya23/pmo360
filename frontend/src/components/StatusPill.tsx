import clsx from "clsx";

export function StatusPill({ status }: { status: string }) {
  const cls =
    {
      open: "pill-open",
      pending: "pill-pending",
      completed: "pill-completed",
      cancelled: "pill-cancelled",
    }[status?.toLowerCase()] || "pill-cancelled";
  return <span className={cls}>{(status || "Open").replace(/^./, (c) => c.toUpperCase())}</span>;
}

export function StatusSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const opts = ["open", "pending", "completed", "cancelled"];
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={clsx(
        "rounded-full border px-3 py-1 text-xs font-semibold",
        statusBg(value)
      )}
    >
      {opts.map((o) => (
        <option key={o} value={o}>
          {o.replace(/^./, (c) => c.toUpperCase())}
        </option>
      ))}
    </select>
  );
}

function statusBg(status: string) {
  switch ((status || "").toLowerCase()) {
    case "open":
      return "bg-status-open-bg text-status-open-text border-status-open-border";
    case "pending":
      return "bg-status-pending-bg text-status-pending-text border-status-pending-border";
    case "completed":
      return "bg-status-completed-bg text-status-completed-text border-status-completed-border";
    default:
      return "bg-status-cancelled-bg text-status-cancelled-text border-status-cancelled-border";
  }
}
