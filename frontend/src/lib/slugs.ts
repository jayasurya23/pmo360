/**
 * URL slug helpers — used to mirror selected client / portfolio into the URL
 * as ?client=&portfolio= so links are shareable.
 *
 * Slug rules (must match what the Streamlit version used):
 *  - lowercase
 *  - spaces and underscores → "-"
 *  - any character outside [a-z0-9-] is stripped
 *  - collapse repeated "-"
 *  - trim leading / trailing "-"
 */

export function nameToSlug(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Find an item in a list by matching slug(item.name) to the given slug. */
export function findBySlug<T extends { name: string }>(
  items: T[],
  slug: string | null,
): T | null {
  if (!slug) return null;
  const target = slug.toLowerCase();
  return items.find((i) => nameToSlug(i.name) === target) ?? null;
}
