/**
 * The "Access" band of the User Management grid — the eight checkbox columns
 * and the spanning header above them.
 *
 * Split out of AdminUsersCard because the column budget, the two-line header
 * labels and the sticky-column offsets have to agree with each other exactly,
 * and that is easier to keep true when they live next to each other. The card
 * still owns the row: these export `<col>`, `<th>` and `<td>` fragments that
 * slot into its table.
 *
 * Semantics, so the copy in here stays honest:
 *
 *  - A permission gates WRITES only. Reads stay open and already portfolio-
 *    filtered, so unticking a box never blanks a screen or hides a nav tab.
 *  - Scope is BOTH. The permission says WHAT, portfolio membership says WHERE.
 *    The five portfolio permissions do nothing for someone on no portfolios,
 *    which is why the card warns about that case. The other three — Timeline,
 *    User Mgmt, Client Mgmt — are global and need no membership.
 *  - Admin is the super-role and implicitly holds all eight, so an admin's
 *    boxes render ticked and locked. Showing eight empty boxes beside someone
 *    who can in fact do everything would be a lie the grid tells daily.
 *
 * Nothing here enforces anything. Every box maps to a server-side gate in
 * auth/permissions.py; a disabled checkbox is a courtesy, not a boundary.
 */
import clsx from "clsx";
import type { AdminUser, PermissionDef, PermissionName } from "@/lib/types";

/** Used only if the server sends no column definitions (an older backend).
 *  Order matches the sketch, and `auth/permissions.py::PERMISSIONS`. */
export const FALLBACK_PERMISSION_DEFS: PermissionDef[] = [
  { name: "meeting_minutes", label: "Meeting Minutes", scope: "portfolio" },
  { name: "co_creation", label: "CO Creation", scope: "portfolio" },
  { name: "co_approval", label: "CO Approval", scope: "portfolio" },
  { name: "agenda", label: "Agenda", scope: "portfolio" },
  { name: "proposals", label: "Proposals", scope: "portfolio" },
  // Global, not portfolio: the capacity board plans PEOPLE and none of its
  // tables carries a portfolio. Getting this wrong here isn't cosmetic — the
  // fallback paints before the defs fetch resolves, and a portfolio-scoped
  // Timeline would make hasDeadPortfolioGrants briefly accuse a Timeline-only
  // holder of holding permissions that do nothing.
  { name: "timeline", label: "Timeline", scope: "global" },
  { name: "user_mgmt", label: "User Mgmt", scope: "global" },
  { name: "client_mgmt", label: "Client Mgmt", scope: "global" },
];

/* Per-column budget. 3.5rem fits the longest single word any label breaks into
   ("Proposals") at the 10px header size, which is what lets the header stay
   horizontal and readable instead of rotated. Kept in rem, not px, so a
   browser font-size of Large scales the budget with the text it budgets for. */
export const ACCESS_COL_W = "3.5rem";

/** What each permission actually unlocks — the hover explanation on the header.
 *  Written as "may + verb" so it reads as a grant, and every one of them names
 *  a write: that is the whole model. */
const HELP: Record<PermissionName, string> = {
  // The company-wide attendee directory is called out because it is the one
  // write this permission unlocks with no membership check — a shared address
  // book has no portfolio to belong to, so the grid must not imply otherwise.
  meeting_minutes:
    "May create and edit meeting minutes, actions and attachments on their portfolios, plus the company-wide attendee directory, which belongs to no portfolio. Everyone can still read them.",
  co_creation: "May create and edit change orders, and send them to a client.",
  co_approval:
    "May approve a change order — but never one they created themselves. Approval needs a second pair of eyes.",
  agenda: "May create and edit pre-meeting agendas.",
  proposals: "May create and edit proposals, schedules and versions.",
  timeline:
    "May create and edit timeline assignments. Global: the capacity board plans people company-wide, so it is not limited to any portfolio.",
  user_mgmt:
    "May open this console and edit people — without being a full admin. Global: not limited to any portfolio.",
  client_mgmt:
    "May create, rename and delete clients. Global: not limited to any portfolio.",
};

/** The reason an admin's boxes are ticked and can't be changed. Shown on hover
 *  of every locked box, so the state is never mysterious. */
export const ADMIN_LOCK_REASON =
  "Admin — implicitly holds every permission, on every portfolio. Remove admin to grant permissions individually.";

/** Index of the first global permission, so the band can draw a divider where
 *  portfolio work stops. -1 when there are none. */
function firstGlobalIndex(defs: PermissionDef[]): number {
  return defs.findIndex((d) => d.scope === "global");
}

/** The eight `<col>` elements. Must be rendered inside the table's colgroup in
 *  the same position the head and body cells appear. */
export function AccessCols({ defs }: { defs: PermissionDef[] }) {
  return (
    <>
      {defs.map((d) => (
        <col key={d.name} style={{ width: ACCESS_COL_W }} />
      ))}
    </>
  );
}

/** The spanning "Access" header. Row one of the table's two header rows. */
export function AccessGroupHead({ defs }: { defs: PermissionDef[] }) {
  return (
    <th
      colSpan={defs.length}
      className="border-x border-surface-hairline px-2 py-2 text-center font-semibold"
    >
      Access
    </th>
  );
}

/** The eight labelled sub-headers. Row two.
 *
 *  Each label breaks on its spaces so "Meeting Minutes" stacks to two lines
 *  inside 3.5rem — sentence case, not the uppercase the rest of the header
 *  uses, because uppercase plus letter-spacing would not fit and a header that
 *  needs a tooltip to read is not a header. */
export function AccessHeadCells({ defs }: { defs: PermissionDef[] }) {
  const globalAt = firstGlobalIndex(defs);
  return (
    <>
      {defs.map((d, i) => (
        <th
          key={d.name}
          scope="col"
          title={HELP[d.name] ?? d.label}
          className={clsx(
            "px-1 py-2 align-bottom text-center text-[10px] font-semibold leading-[1.15] tracking-normal normal-case text-brand-gray",
            i === 0 && "border-l border-surface-hairline",
            i === defs.length - 1 && "border-r border-surface-hairline",
            // Everything right of here is global — it takes no portfolio. The
            // divider is the visual half of the sentence the card's footnote
            // spells out.
            i === globalAt && globalAt > 0 && "border-l border-surface-border",
          )}
        >
          {d.label.split(" ").map((word) => (
            <span key={word} className="block">
              {word}
            </span>
          ))}
        </th>
      ))}
    </>
  );
}

export function AccessCells({
  defs,
  user,
  pending,
  disabled,
  disabledReason,
  onToggle,
}: {
  defs: PermissionDef[];
  user: AdminUser;
  /** Permission names with a PATCH in flight for this user. */
  pending: Set<PermissionName>;
  /** True when this operator may not edit this row at all (the server would
   *  refuse). Presentation — the refusal still comes from the backend. */
  disabled?: boolean;
  disabledReason?: string;
  onToggle: (name: PermissionName, next: boolean) => void;
}) {
  const globalAt = firstGlobalIndex(defs);
  const who = user.name || user.email || `User #${user.id}`;
  return (
    <>
      {defs.map((d, i) => {
        const granted = !!user.permissions?.[d.name];
        // An admin's ticks come from the role, not from a stored grant, so the
        // box shows the truth but can't be edited — unticking it would change
        // nothing, and a control that does nothing is worse than no control.
        const lockedByRole = user.is_admin;
        const inFlight = pending.has(d.name);
        const reason = lockedByRole
          ? ADMIN_LOCK_REASON
          : disabled
            ? disabledReason
            : HELP[d.name];
        return (
          <td
            key={d.name}
            className={clsx(
              "px-1 py-2 text-center align-middle",
              i === 0 && "border-l border-surface-hairline",
              i === defs.length - 1 && "border-r border-surface-hairline",
              i === globalAt && globalAt > 0 && "border-l border-surface-border",
            )}
          >
            <input
              type="checkbox"
              className={clsx(
                "h-3.5 w-3.5 accent-brand-red align-middle",
                "disabled:cursor-not-allowed",
                // In flight: dim the box rather than swapping in a spinner, so
                // the column doesn't jump width mid-save.
                inFlight && "opacity-40",
                lockedByRole && "opacity-70",
              )}
              checked={granted}
              disabled={lockedByRole || !!disabled || inFlight}
              title={reason}
              aria-label={`${d.label} for ${who}`}
              onChange={(e) => onToggle(d.name, e.target.checked)}
            />
          </td>
        );
      })}
    </>
  );
}

/** "no portfolios, but holds portfolio permissions" — the one combination that
 *  looks granted and does nothing, so the card says so out loud. */
export function hasDeadPortfolioGrants(
  user: AdminUser,
  defs: PermissionDef[],
): boolean {
  if (user.is_admin) return false; // admins bypass membership entirely
  if ((user.portfolios ?? []).length > 0) return false;
  return defs.some((d) => d.scope === "portfolio" && user.permissions?.[d.name]);
}
