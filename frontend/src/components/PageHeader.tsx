import { ReactNode } from "react";

/**
 * The page title block used by every screen.
 *
 * The redesign leads with a small uppercase `kicker` above a large title —
 * the kicker is where pages put their context/count line ("14 OPEN · 3
 * OVERDUE"). `subtitle` is the older below-the-title slot; both still render,
 * so pages can move across independently, but new screens should use `kicker`.
 */
export default function PageHeader({
  kicker,
  title,
  subtitle,
  actions,
}: {
  kicker?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        {kicker && <div className="kicker mb-1.5">{kicker}</div>}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="text-sm text-brand-gray mt-1">{subtitle}</p>}
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {actions}
        </div>
      )}
    </div>
  );
}
