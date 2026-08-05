/**
 * Reading the signed-in user's permissions, in one place.
 *
 * This lived as a private helper inside Layout.tsx, which was fine while the
 * shell was the only thing that hid a control. It isn't any more: the Change
 * Orders page decides whether to offer Approve, Send back, Edit and Delete, and
 * a second hand-rolled copy of "does this person hold co_approval" is a second
 * place for the answer to be wrong. Same reasoning as the note on
 * `UserPermissions` in types.ts — the SPA never re-derives an authorization
 * rule it was already told the answer to.
 *
 * PRESENTATION ONLY. Every one of these is also enforced server-side, and that
 * gate is the one that matters — a hidden button is a courtesy, not a control.
 * Nothing here may be the sole thing standing between a user and a write.
 */
import type { MeResponse, PermissionName } from "./types";

/**
 * One permission as this user experiences it, read off /api/me.
 *
 * `permissions` is optional on MeResponse — an /api/me older than this client
 * omits it — so an absent map falls back to the admin flag rather than locking
 * an admin out of their own console. Everyone else lands on the closed side,
 * which is the safe direction for the destructive items it guards.
 */
export function can(me: MeResponse | null, name: PermissionName): boolean {
  if (!me) return false;
  // The server already folds the admin bypass into `permissions`; keeping it
  // here too costs nothing and covers the older-payload case above.
  if (me.is_admin) return true;
  return !!me.permissions?.[name];
}
