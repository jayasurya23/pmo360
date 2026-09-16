/**
 * Deep links by Castillo Project ID — `/portfolio?project_id=264-066`.
 *
 * "Project ID" is monday.com's name for the Castillo number on its Portfolio
 * board; PMO 360 stores it as `Project.project_number`. Other Castillo tools
 * (the Planset QC app) know a project only by that value, not by PMO 360's
 * numeric id or its name slug, so they link with it and PMO 360 resolves it.
 *
 * Project IDs are not unique here — one monday item can cover two portfolios,
 * and a portfolio can cover several monday items while storing one value — so
 * resolution returns every match and the caller decides what to do with zero
 * or several rather than guessing.
 */

/** URL parameter carrying the Project ID. One-shot: removed once resolved. */
export const PROJECT_ID_PARAM = "project_id";

/** Hyphen look-alikes that arrive by copy-paste from Word, Outlook and PDFs. */
const DASHES = /[‐-―−﹣－]/g;

/**
 * Comparison key for a Project ID. The value is opaque (never parsed — the
 * numbering scheme has changed before); only presentation noise is removed.
 */
export function projectIdKey(value: string | null | undefined): string {
  return (value ?? "")
    .replace(DASHES, "-")
    .replace(/\s*-\s*/g, "-")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Portfolios whose Project ID matches `projectId`, in their given order. */
export function portfoliosWithProjectId<T extends { project_number?: string | null }>(
  portfolios: T[],
  projectId: string,
): T[] {
  const key = projectIdKey(projectId);
  if (!key) return [];
  return portfolios.filter((p) => projectIdKey(p.project_number) === key);
}
