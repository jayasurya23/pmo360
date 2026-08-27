/**
 * Pick the monday.com RFIs discussed in this meeting.
 *
 * A PICKER, not an editor. Monday owns RFIs; PMO 360 records which of them came
 * up and what they said at the time. Nothing here writes back to Monday, and
 * nothing here lets the PM retype an RFI's content — an edited copy that
 * disagreed with the board would be worse than no copy.
 *
 * What IS chosen here is which sub-project's table each RFI prints in. The
 * server resolves that from the mapping, and the choice is shown so a PM can
 * see it before it reaches a client document.
 *
 * The values are SNAPSHOTTED on save. What you see here is what the minutes
 * will print, even if somebody edits the board tomorrow.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { listPortfolioRfis } from "@/lib/api";
import type { MeetingRfi } from "@/lib/types";

function keyOf(r: MeetingRfi) {
  // A single RFI can legitimately appear under two sub-projects, so identity is
  // the PAIR — keying on the Monday id alone would make picking it for one
  // project silently select it for the other.
  return `${r.monday_item_id ?? "manual"}:${r.portfolio_project_id ?? "wide"}`;
}

export default function RfiPicker({
  portfolioId,
  selected,
  onChange,
}: {
  portfolioId: number;
  selected: MeetingRfi[];
  onChange: (next: MeetingRfi[]) => void;
}) {
  const [available, setAvailable] = useState<MeetingRfi[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAvailable(await listPortfolioRfis(portfolioId));
    } catch (e: any) {
      // A picker that cannot reach Monday must not block the minutes. The
      // already-selected snapshots stay editable and savable regardless.
      setError(
        e?.response?.data?.detail ||
          e?.message ||
          "Could not reach monday.com. Any RFIs already added still save normally.",
      );
      setAvailable([]);
    } finally {
      setLoading(false);
    }
  }, [portfolioId]);

  useEffect(() => {
    if (open && available === null) void load();
  }, [open, available, load]);

  const chosen = useMemo(() => new Set(selected.map(keyOf)), [selected]);

  /** Grouped exactly the way the minutes will print, so the editor is a preview
   *  of the document rather than a flat list that reorders on save. */
  const groups = useMemo(() => {
    const out = new Map<string, MeetingRfi[]>();
    for (const r of selected) {
      const label = r.portfolio_project_name || "Whole portfolio";
      if (!out.has(label)) out.set(label, []);
      out.get(label)!.push(r);
    }
    return [...out.entries()];
  }, [selected]);

  function toggle(r: MeetingRfi) {
    const k = keyOf(r);
    if (chosen.has(k)) onChange(selected.filter((x) => keyOf(x) !== k));
    else onChange([...selected, r]);
  }

  return (
    <div className="space-y-3">
      {selected.length === 0 ? (
        <p className="text-[13px] text-brand-gray">
          No RFIs on these minutes yet.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map(([label, rows]) => (
            <div key={label}>
              <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.1em] text-brand-gray">
                {label}
                <span className="ml-1.5 font-normal normal-case tracking-normal text-brand-lightgray">
                  prints as its own table
                </span>
              </div>
              <ul className="divide-y divide-surface-page rounded border border-surface-border">
                {rows.map((r) => (
                  <li
                    key={keyOf(r)}
                    className="flex items-start gap-2 px-3 py-2 text-[13px]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-brand-black">
                        {r.item_equipment || r.name}
                      </div>
                      {(r.description || r.question) && (
                        <div className="text-[12px] text-brand-gray">
                          {r.description || r.question}
                        </div>
                      )}
                      <div className="mt-0.5 text-[11px] text-brand-lightgray">
                        {r.name}
                        {r.status ? ` · ${r.status}` : ""}
                        {r.response_needed_by ? ` · needed by ${r.response_needed_by}` : ""}
                      </div>
                    </div>
                    <button
                      className="shrink-0 text-brand-lightgray transition hover:text-brand-brightred"
                      title="Remove from these minutes"
                      aria-label={`Remove ${r.name}`}
                      onClick={() => toggle(r)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-ghost text-xs"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Done choosing" : "+ Add RFIs from monday.com"}
        </button>
        {open && (
          <button
            className="text-xs font-semibold text-brand-gray hover:text-brand-red"
            onClick={() => void load()}
            disabled={loading}
            title="Re-read the current values from monday.com"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        )}
        {selected.length > 0 && (
          <span className="text-[11px] text-brand-lightgray">
            Values are captured on save, so these minutes keep saying what was
            discussed today.
          </span>
        )}
      </div>

      {open && (
        <div className="rounded border border-surface-border">
          {error && (
            <p className="border-b border-surface-border px-3 py-2 text-[12.5px] text-brand-red">
              {error}
            </p>
          )}
          {loading && available === null && (
            <p className="px-3 py-3 text-[13px] text-brand-gray">
              Loading RFIs…
            </p>
          )}
          {available !== null && available.length === 0 && !error && (
            <p className="px-3 py-3 text-[13px] text-brand-gray">
              No RFIs for this portfolio. If you expected some, check that its
              projects are linked under Settings → monday.com — an unlinked
              project's RFIs never appear here.
            </p>
          )}
          <ul className="max-h-80 divide-y divide-surface-page overflow-y-auto">
            {(available || []).map((r) => {
              const isOn = chosen.has(keyOf(r));
              return (
                <li key={keyOf(r)}>
                  <button
                    className={clsx(
                      "flex w-full items-start gap-2 px-3 py-2 text-left text-[13px] transition",
                      isOn ? "bg-surface-mute" : "hover:bg-surface-rowhover",
                    )}
                    onClick={() => toggle(r)}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 accent-brand-red"
                      checked={isOn}
                      readOnly
                      tabIndex={-1}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-brand-black">
                        {r.item_equipment || r.name}
                      </span>
                      <span className="block text-[11.5px] text-brand-gray">
                        {r.portfolio_project_name || "Whole portfolio"}
                        {r.monday_project_name ? ` · ${r.monday_project_name}` : ""}
                        {r.status ? ` · ${r.status}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
