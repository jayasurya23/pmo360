/**
 * ActivityCard — "what moved since you were last here" on Home.
 *
 * Derived, not fetched: the rows are built from the change orders the Home
 * change-order rollup already loads, using their status plus the
 * created_by/updated_by/updated_at stamps the model carries. Change orders are
 * the only entity on Home that carries a per-record actor + timestamp — the
 * dashboard rollups return actions, notes and agendas without them, so those
 * can't be shown here until the endpoints expose their audit stamps.
 */
import { parseISO } from "date-fns";

import type { ChangeOrder } from "@/lib/types";
import { money } from "./useHomeData";

const MAX_ROWS = 6;

type Tone = "green" | "blue" | "gold" | "gray";

const TONE_CLASS: Record<Tone, string> = {
  green: "text-brand-green",
  blue: "text-brand-blue",
  gold: "text-brand-gold",
  gray: "text-brand-gray",
};

interface ActivityEvent {
  key: string;
  tone: Tone;
  text: string;
  /** Portfolio · actor · when. */
  meta: string;
  at: number;
}

/** Compact relative time — the meta line has room for "2h ago", not
 *  "about 2 hours ago". */
function relTime(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function ts(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = parseISO(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** One row per change order: its latest meaningful state change. */
function toEvent(co: ChangeOrder): ActivityEvent | null {
  const label = `CO-${co.co_number}`;
  const amount = co.total_amount ? ` (${money(co.total_amount)})` : "";
  const actor = co.updated_by?.name || co.created_by?.name || null;

  let tone: Tone = "gray";
  let text = `${label} drafted`;
  let when = ts(co.updated_at) ?? ts(co.created_at);

  if (co.status === "approved") {
    tone = "green";
    text = `${label} approved${amount}`;
    when = ts(co.approved_at) ?? when;
  } else if (co.status === "sent_back") {
    tone = "gold";
    text = `${label} sent back for revision`;
  } else if (co.sent_at) {
    tone = "blue";
    text = `${label} emailed to the client`;
    when = ts(co.sent_at) ?? when;
  } else if (co.status === "pending") {
    tone = "gold";
    text = `${label} submitted for approval${amount}`;
  }

  if (when === null) return null;
  return {
    key: `co-${co.id}`,
    tone,
    text,
    meta: [co.project_name, actor, relTime(when)].filter(Boolean).join(" · "),
    at: when,
  };
}

export default function ActivityCard({
  cos,
  loading,
}: {
  cos: ChangeOrder[];
  loading: boolean;
}) {
  const events = cos
    .map(toEvent)
    .filter((e): e is ActivityEvent => e !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ROWS);

  // Same rule as the other rollups: don't hold space on a quiet week.
  if (!loading && events.length === 0) return null;

  return (
    <section className="card px-5 py-4">
      <div className="flex items-center gap-2">
        <h2 className="section-title">Activity</h2>
        <span className="text-xs text-brand-gray">recent updates</span>
      </div>

      {loading && events.length === 0 ? (
        <div className="mt-2 text-sm text-brand-gray italic">Loading…</div>
      ) : (
        <div className="mt-2.5 flex flex-col">
          {events.map((e) => (
            <div
              key={e.key}
              className="flex gap-2.5 py-[7px] border-b border-surface-page last:border-b-0"
            >
              <span className={`text-xs leading-5 ${TONE_CLASS[e.tone]}`}>●</span>
              <div className="min-w-0">
                <div className="text-[13px] leading-[1.4] text-brand-black">
                  {e.text}
                </div>
                <div className="text-[11px] text-brand-gray">{e.meta}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
