/**
 * The "Access" band of the User Management grid — the eight checkbox columns
 * and the two group headers above them.
 *
 * Split out of AdminUsersCard because the column budget and the header labels
 * have to agree with each other exactly, and that is easier to keep true when
 * they live next to each other. The card still owns the row: these export
 * `<col>`, `<th>` and `<td>` fragments that slot into its table.
 *
 * Semantics, so the copy in here stays honest:
 *
 *  - A permission gates WRITES only. Reads stay open, so unticking a box never
 *    blanks a screen or hides a nav tab.
 *  - A ticked box applies EVERYWHERE. There is no per-portfolio version of a
 *    permission: `auth/permissions.py::is_portfolio_member` is disabled and
 *    returns true for anyone signed in, because Castillo's rule is that every
 *    PM reaches every portfolio. Portfolio assignment is a visibility tool —
 *    the Mine/all filter, the dashboard scope toggle, Manage Team — and gates
 *    nothing. No copy in this file may imply otherwise.
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
  // tables carries a portfolio. `scope` no longer decides who may write where
  // — it only files a column under one of the two group headers — so getting
  // this wrong would sit Timeline under "Portfolio work" until the real defs
  // land, describing the module rather than the access.
  { name: "timeline", label: "Timeline", scope: "global" },
  { name: "user_mgmt", label: "User Mgmt", scope: "global" },
  { name: "client_mgmt", label: "Client Mgmt", scope: "global" },
];

/* Per-column budget. 3.5rem leaves 3rem of content inside the 4px gutters,
   which clears the longest single word any label breaks into ("Proposals",
   ~43px at the 10px header size) with room to spare in the Helvetica fallback
   too. That headroom is the whole point: the old band was one wrapped word
   away from rendering "CO / proval". Kept in rem, not px, so a browser
   font-size of Large scales the budget with the text it budgets for.

   Eight of these is 28rem / 448px, which is the largest single term in the
   card's width arithmetic — see the colgroup comment in AdminUsersCard. */
export const ACCESS_COL_W = "3.5rem";

/** What each permission actually unlocks — the hover explanation on the header.
 *  Written as "may + verb" so it reads as a grant, and every one of them names
 *  a write: that is the whole model. */
const HELP: Record<PermissionName, string> = {
  // The attendee directory is called out because it is the one write here that
  // is not filed under a portfolio at all — a shared address book belongs to
  // the company, so an admin should not go looking for it per portfolio.
  meeting_minutes:
    "May create and edit meeting minutes, actions and attachments on any portfolio, plus the company-wide attendee directory. Everyone can still read them.",
  co_creation: "May create and edit change orders, and send them to a client.",
  co_approval:
    "May approve a change order — but never one they created themselves. Approval needs a second pair of eyes.",
  agenda: "May create and edit pre-meeting agendas.",
  proposals: "May create and edit proposals, schedules and versions.",
  timeline:
    "May create and edit timeline assignments. The capacity board plans people across the whole business rather than any one portfolio.",
  user_mgmt:
    "May open this console and edit people — without being a full admin.",
  client_mgmt: "May create, rename and delete clients.",
};

/** The reason an admin's boxes are ticked and can't be changed. Shown on hover
 *  of every locked box, so the state is never mysterious. */
export const ADMIN_LOCK_REASON =
  "Admin — implicitly holds every permission. Remove admin to grant permissions individually.";

/** Index of the first global permission, so the band can split its header and
 *  draw a divider where portfolio work stops. -1 when there are none. */
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

/**
 * Row one of the two header rows: two group headers rather than one "Access".
 *
 * The split groups the columns by WHAT they unlock, not by where it applies —
 * five that govern work filed under a portfolio, three that govern things the
 * company keeps in one place. Every box in both groups applies everywhere.
 * One spanning "Access" made the divider between columns 5 and 6 look
 * decorative, which is why the two headers survived the scoping rule that
 * originally motivated them.
 */
export function AccessGroupHead({ defs }: { defs: PermissionDef[] }) {
  const globalAt = firstGlobalIndex(defs);
  const portfolioCount = globalAt < 0 ? defs.length : globalAt;
  const globalCount = defs.length - portfolioCount;
  return (
    <>
      {portfolioCount > 0 && (
        <th
          colSpan={portfolioCount}
          title="What these unlock lives inside a portfolio — minutes, change orders, agendas, proposals. A ticked box applies on every portfolio; being assigned to one neither widens nor narrows it."
          className="border-l border-surface-hairline px-2 py-2 text-center font-semibold"
        >
          {/* "work", not "access" — the grid also has a Portfolios count
              column, and two headers reading PORTFOLIO would be a coin toss
              about which one the ticks belong to. "Access" was the earlier
              answer and is now the wrong word twice over: these do not grant
              access per portfolio, and the count beside them grants none. */}
          Portfolio work
        </th>
      )}
      {globalCount > 0 && (
        <th
          colSpan={globalCount}
          title="What these unlock is filed under no portfolio at all — the capacity board, this console, and the client list."
          className="border-x border-surface-border px-2 py-2 text-center font-semibold"
        >
          Company-wide
        </th>
      )}
    </>
  );
}

/** The eight labelled sub-headers. Row two.
 *
 *  Each label breaks on its spaces so "Meeting Minutes" stacks to two lines
 *  inside 3.5rem — sentence case, not the uppercase the rest of the header
 *  uses, because uppercase plus letter-spacing would not fit and a header that
 *  needs a tooltip to read is not a header. `whitespace-nowrap` is the part
 *  that matters: a word must overflow its gutter rather than hyphenate itself
 *  into "CO / proval", which is unreadable in a way a 2px spill is not. */
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
            "px-0.5 py-1.5 align-bottom text-center text-[10px] font-semibold leading-[1.15] tracking-normal normal-case text-brand-gray",
            i === 0 && "border-l border-surface-hairline",
            i === defs.length - 1 && "border-r border-surface-border",
            i === globalAt && globalAt > 0 && "border-l border-surface-border",
          )}
        >
          {d.label.split(" ").map((word) => (
            <span key={word} className="block whitespace-nowrap">
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
              "px-0.5 py-1.5 text-center align-middle",
              i === 0 && "border-l border-surface-hairline",
              i === defs.length - 1 && "border-r border-surface-border",
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

/* A predicate lived here — hasDeadPortfolioGrants, later renamed
   hasUnscopedPortfolioGrants — that flagged somebody holding portfolio
   permissions while assigned to no portfolio. It has been deleted rather than
   reworded a third time. Under the first rule that combination meant "these
   grants do nothing"; under the second it meant "these grants reach every
   unassigned portfolio". Under the rule that actually shipped it means
   nothing at all: membership gates no write, so a person on no portfolios has
   exactly the access their eight boxes describe, the same as everyone else.
   A flag with no consequence trains admins to ignore the ones that have one. */
