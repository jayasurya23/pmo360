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
      {/* flex-1 (basis 0), NOT the natural content width.
          The kicker is a variable-length context line, and with flex-wrap the
          browser wraps a too-wide row rather than narrowing a column — so
          sizing this block to its content let the KICKER decide where the
          actions landed. On Actions that was visible: the short "E1300" kicker
          left room for the toolbar beside the title, while "UTOPIAN POWER —
          ALL PORTFOLIOS · 57 TOTAL — …" pushed the identical toolbar onto its
          own line. Same controls, different place, purely because of how much
          text sat above them.
          Basis 0 means this block never forces the wrap; it takes the space
          left over and the kicker wraps inside it. min-w keeps that honest on
          narrow screens: below it the row wraps as before, so the actions drop
          under the title on a phone instead of crushing it to a sliver. */}
      <div className="min-w-0 sm:min-w-[18rem] flex-1">
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
