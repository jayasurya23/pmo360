/**
 * Sub-project name helpers for the Notes page.
 *
 * The Notes tab needs a stable, deduped list of sub-project names so PMs
 * always pick from a consistent menu instead of free-typing variants
 * ("snapdragon" vs "Snapdragon" vs "Snap Dragon"). The list is merged from
 * three sources, in priority order:
 *
 *   1. The portfolio's curated `Project.sub_projects_json`
 *   2. Auto-discovered `Deliverable.project_segment` values on that portfolio
 *   3. Existing `Note.project_area` values already used on prior notes
 *
 * Dedupe is case-insensitive but the first-seen casing wins so the curated
 * list controls capitalization.
 */

/**
 * Merge curated + discovered sub-project lists into a single deduped list.
 * Case-insensitive dedupe, preserves first-seen casing.
 */
export function mergeSubProjects(
  ...sources: (string | null | undefined)[][]
): string[] {
  const seen = new Map<string, string>(); // lowercase -> first-seen casing
  for (const src of sources) {
    for (const name of src || []) {
      const trimmed = (name || "").trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) seen.set(key, trimmed);
    }
  }
  return Array.from(seen.values());
}

/** Sentinel value used in the per-note <select> to toggle a free-text input. */
export const NEW_AREA_SENTINEL = "__new_area__";

/** Display label shown for the sentinel option. */
export const NEW_AREA_LABEL = "+ New area…";
