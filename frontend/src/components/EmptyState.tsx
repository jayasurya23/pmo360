import { ReactNode } from "react";

export default function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card p-12 text-center">
      <div className="text-lg font-semibold text-brand-black mb-1">{title}</div>
      {hint && <div className="text-sm text-brand-gray mb-4">{hint}</div>}
      {action}
    </div>
  );
}
