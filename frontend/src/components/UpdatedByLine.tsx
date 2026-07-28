import { formatDistanceToNow, parseISO } from "date-fns";
import type { UserStub } from "@/lib/types";

interface Props {
  user?: UserStub | null;
  at?: string | null;
  prefix?: string; // "Saved by" | "Created by" | etc.
}

/**
 * Tiny provenance line — "Saved by Arun · 2h ago". Renders nothing when the
 * user stub is missing, so callers can drop it in unconditionally without
 * checking first.
 */
export default function UpdatedByLine({ user, at, prefix = "Saved by" }: Props) {
  if (!user?.name) return null;
  const when = at ? formatDistanceToNow(parseISO(at), { addSuffix: true }) : null;
  return (
    <div className="text-[11px] text-brand-gray">
      {prefix} <span className="font-semibold text-brand-black">{user.name}</span>
      {when ? ` · ${when}` : null}
    </div>
  );
}
