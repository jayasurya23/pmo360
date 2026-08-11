/**
 * OwnerFilterSelect — the Actions page owner filter, grouped by company.
 *
 * This replaces a native <select>. That is a downgrade unless it is done
 * properly, so the reason has to be worth it: browsers do not honour colour on
 * <option> (Safari ignores it outright, Windows is inconsistent) and <optgroup>
 * gives headers but no colour at all. Company colour-coding was the ask, so the
 * list has to be ours.
 *
 * What that costs, and what is therefore reimplemented here: arrow-key
 * navigation, Enter to choose, Escape to close, type-ahead, focus returning to
 * the trigger, click-outside-to-close, and combobox/listbox ARIA. See the
 * keyboard block below.
 *
 * The interaction model follows OwnerPicker.tsx — type to narrow, arrows to
 * move, Enter to take the highlighted row — so the app does not end up with two
 * custom dropdowns that behave differently. The difference is the trigger: this
 * one must *display* a current selection ("All owners"), which a bare text input
 * cannot do, so the search box lives inside the popup instead of being the
 * control itself.
 *
 * VALUE CONTRACT — do not change without changing every reader. `value` holds
 * exactly what the old <select> held: OWNER_ALL, OWNER_MINE, or a raw owner
 * name string. Actions.tsx filters on it AND passes it to saveActionsCsv, so
 * anything else here silently breaks the CSV export.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  actionScopeIsResolved,
  actionScopeParams,
  fetchActionOwners,
} from "@/lib/api";
import type { ActionOwnerEntry, ActionOwnerGroup, ActionScope } from "@/lib/types";

/** The two non-name values. Exported so the page and this component cannot
 *  drift apart on a magic string. */
export const OWNER_ALL = "__all__";
export const OWNER_MINE = "__mine__";

interface Tone {
  /** Text + rail. */
  fg: string;
  /** Header wash. */
  bg: string;
}

/**
 * Colour is read through the theme variables rather than Tailwind classes for
 * the same reason CommandPalette's KIND_STYLE is: it is looked up from a map,
 * so it cannot be a class name.
 *
 * Each entry pairs a low-alpha wash of a hue with the readable "-on"/"deep"
 * step of the SAME hue. That pairing is the one thing the token layer already
 * guarantees is legible on whichever surface is current, which is what makes
 * these survive dark mode — the default here.
 *
 * Castillo is PINNED to the brand red and is deliberately NOT in the derived
 * palette, so no client company can ever collide with us.
 */
const CASTILLO_TONE: Tone = {
  fg: "rgb(var(--brand-red-on))",
  bg: "rgb(var(--brand-red) / 0.16)",
};

/** Unplaced owners. Grey, because grey reads as "not categorised yet" — this
 *  section is a worklist, and colouring it would imply it were a company. */
const UNMATCHED_TONE: Tone = {
  fg: "rgb(var(--brand-gray))",
  bg: "rgb(var(--brand-lightgray) / 0.18)",
};

/**
 * Client companies. FOUR, and that is the honest ceiling, not an oversight.
 *
 * The brand has exactly four non-red hues whose readable step stays distinct
 * from every other hue in BOTH themes. `--brand-blue` collapses onto
 * `--brand-deepblue` in dark (#35bcdd vs #4fc9e8) and `--brand-brightgreen`
 * onto `--brand-green-on`, so shipping them as separate slots would be six
 * colours that look like four on the theme most people are actually using.
 *
 * With more than four client companies in scope the colours repeat. That is
 * survivable because colour is not the identifier here: every section is
 * titled with the company name in text, which is also what makes this work for
 * a colour-blind reader.
 */
const COMPANY_TONES: Tone[] = [
  { fg: "rgb(var(--brand-deepblue))", bg: "rgb(var(--brand-blue) / 0.16)" },
  // Gold needs a heavier wash than the rest — it is the palest hue in the
  // brand, so 16% barely separates from the card.
  { fg: "rgb(var(--brand-deepgold))", bg: "rgb(var(--brand-gold) / 0.22)" },
  { fg: "rgb(var(--brand-green-on))", bg: "rgb(var(--brand-green) / 0.16)" },
  // THREE, not four. Brown was the fourth and it measured 3.43:1 on the dark
  // card — under AA for 11px semibold, and dark mode is the default here. The
  // others all have a lightened dark-mode step (green-on, deepgold, deepblue);
  // --brand-brown is 156 133 120 in dark and has no such step, so it would have
  // needed the shared token bending for one badge. It also sat close enough to
  // the unmatched grey to blur the one distinction in this list that carries
  // meaning. Fewer hues just means more companies share one, which costs
  // nothing: the colour is a scanning aid and the header states the company in
  // words — that is what makes this work for a colour-blind reader too.
];

/** Hashed from the company name, not taken from its position in the list, so a
 *  company keeps the same colour across reloads and no matter which other
 *  companies happen to have open actions this week. */
function toneFor(group: ActionOwnerGroup): Tone {
  if (group.is_castillo) return CASTILLO_TONE;
  if (group.is_unmatched) return UNMATCHED_TONE;
  const key = group.company.trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COMPANY_TONES[h % COMPANY_TONES.length];
}

/** Stable identity so the "still loading" render doesn't hand the memo below a
 *  fresh array on every pass. */
const NO_GROUPS: ActionOwnerGroup[] = [];

interface Props {
  /** OWNER_ALL | OWNER_MINE | a raw owner name. */
  value: string;
  onChange: (next: string) => void;
  /** Must mirror the table's scope — the SAME `ActionScope` the page hands
   *  `listActions`, or a bare portfolio id for a caller that only ever means one
   *  portfolio. Otherwise the dropdown lists owners the table has no rows for,
   *  each carrying an `action_count` the list beside it contradicts, and picking
   *  one empties the table for no visible reason. All three widths are real now
   *  ("this client" is not "this portfolio" and not "all"), so this cannot be a
   *  portfolio id alone. */
  scope: number | ActionScope | null;
  /** Signed-in user's display name, or null when nobody is signed in — decides
   *  whether "Mine" is offered at all, exactly as the old <select> did. */
  meName: string | null;
  /** Owner names scraped off the loaded rows. Used ONLY if the endpoint fails,
   *  so a company lookup being down degrades the filter instead of removing it. */
  fallbackNames: string[];
  /** Bump to refetch. The owner set changes whenever a PM edits an owner, and
   *  a filter listing people who are no longer there is its own small lie. */
  reloadKey?: number;
  className?: string;
}

export default function OwnerFilterSelect({
  value,
  onChange,
  scope,
  meName,
  fallbackNames,
  reloadKey = 0,
  className,
}: Props) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  // null until we know. An empty ARRAY from the server is a real answer
  // ("nothing in scope has an owner") and must never be confused with a
  // failure, which is why this is not just `[]`.
  const [groups, setGroups] = useState<ActionOwnerGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const listboxId = `${uid}-listbox`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  // A PRIMITIVE effect dep, because `scope` is an OBJECT the page rebuilds on
  // every render — depending on it directly would refetch the directory forever.
  // Keyed on the params that actually reach the server rather than on the scope
  // itself, so a change the request cannot see (a different client while still
  // scoped to one portfolio) costs no fetch.
  const scopeKey = JSON.stringify(actionScopeParams(scope));

  // A level the header can't fill sends NO params, which the server reads as
  // "every owner in the company" — so the dropdown would fill with people while
  // the table beside it renders its "pick a portfolio" empty state. Skip the
  // fetch instead and stay empty with the table.
  const resolved = actionScopeIsResolved(scope);

  // Fetched on mount rather than on first open: the TRIGGER carries the
  // selected owner's company colour, so the data is needed before the popup is.
  useEffect(() => {
    let alive = true;
    if (!resolved) {
      setGroups(null);
      setFailed(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    fetchActionOwners(scope)
      .then((d) => {
        if (!alive) return;
        setGroups(d.groups ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setGroups(null);
        setFailed(true);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `scope` is deliberately absent: `scopeKey` is its request-shaped digest,
    // and the effect re-runs on the same render the key changes on, so the
    // closure's `scope` is always the one the key describes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, reloadKey, resolved]);

  // Degraded mode: names with no company rather than an empty dropdown. The
  // note rendered above the list is what stops this reading as the truth.
  const degradedGroups = useMemo<ActionOwnerGroup[]>(
    () =>
      fallbackNames.length
        ? [
            {
              company: "Owners",
              is_castillo: false,
              is_unmatched: false,
              owners: fallbackNames.map((name) => ({
                name,
                owner_user_id: null,
                first_name: null,
                // 0 = unknown here, not zero actions. Counts are suppressed in
                // the row renderer rather than shown as a wrong "0".
                action_count: 0,
              })),
            },
          ]
        : [],
    [fallbackNames],
  );

  // Server truth wins whenever we have it, INCLUDING an empty array. If the
  // server says nothing in scope has an owner while the table plainly shows
  // owners, that is a scope disagreement worth seeing, not something to paper
  // over with the fallback.
  const sourceGroups = groups ?? (loading ? NO_GROUPS : degradedGroups);
  // True only while we are showing names we could not group. Colour has to stop
  // here: a hashed hue on the fallback group would assert a company identity
  // that is precisely what failed to load.
  const degraded = groups === null && !loading;

  // ---- the visible model ----
  // Built in one pass so every row's flat keyboard index is assigned by the
  // same code that decides whether the row is visible. Two passes would
  // eventually disagree and the arrow keys would land on the wrong row.
  const model = useMemo(() => {
    const q = query.trim().toLowerCase();
    const values: string[] = [];

    const specials: { value: string; label: string; detail?: string; idx: number }[] = [];
    const push = (v: string, label: string, detail?: string) => {
      if (q && !label.toLowerCase().includes(q) && !(detail || "").toLowerCase().includes(q)) {
        return;
      }
      specials.push({ value: v, label, detail, idx: values.length });
      values.push(v);
    };
    push(OWNER_ALL, "All owners");
    if (meName !== null) push(OWNER_MINE, "Mine", meName || undefined);

    const sections: {
      group: ActionOwnerGroup;
      tone: Tone;
      headerId: string;
      rows: { owner: ActionOwnerEntry; idx: number }[];
    }[] = [];

    sourceGroups.forEach((group, gi) => {
      // Typing a company name reveals that whole company — searching for
      // "Heelstone" to see who at Heelstone owns anything is the same question
      // as searching for a person, and hiding the people would answer neither.
      const companyHit = !!q && group.company.toLowerCase().includes(q);
      const rows: { owner: ActionOwnerEntry; idx: number }[] = [];
      for (const owner of group.owners) {
        if (q && !companyHit && !owner.name.toLowerCase().includes(q)) continue;
        rows.push({ owner, idx: values.length });
        values.push(owner.name);
      }
      if (rows.length) {
        sections.push({
          group,
          tone: degraded ? UNMATCHED_TONE : toneFor(group),
          headerId: `${uid}-grp-${gi}`,
          rows,
        });
      }
    });

    return { specials, sections, values };
  }, [query, sourceGroups, meName, uid, degraded]);

  // Company of the CURRENT selection, for the trigger's dot. Looked up against
  // the unfiltered groups — the trigger must keep its colour while the user is
  // typing a query that excludes the selected row.
  const selectedTone = useMemo<Tone | null>(() => {
    if (degraded || value === OWNER_ALL || value === OWNER_MINE) return null;
    for (const g of sourceGroups) {
      if (g.owners.some((o) => o.name === value)) return toneFor(g);
    }
    return null;
  }, [value, sourceGroups, degraded]);

  const triggerLabel =
    value === OWNER_ALL ? "All owners" : value === OWNER_MINE ? "Mine" : value;

  // ---- open / close ----
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    // Only on Escape and on choosing. A click that landed on some other control
    // should leave focus where the user put it, not yank it back here.
    if (restoreFocus) triggerRef.current?.focus();
  };

  const openList = () => {
    setOpen(true);
    setQuery("");
  };

  const choose = (next: string) => {
    onChange(next);
    close(true);
  };

  // Focus the search box once the popup exists, and start the highlight on the
  // current selection so Enter is a no-op rather than a surprise.
  useEffect(() => {
    if (!open) return;
    const at = model.values.indexOf(value);
    setActiveIdx(at >= 0 ? at : 0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // Intentionally only on `open`: re-running this on every keystroke would
    // fight the typing by resetting the highlight to the selected row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Narrowing the list can strand the highlight past the end.
  useEffect(() => {
    setActiveIdx((i) => (i >= model.values.length ? 0 : i));
  }, [model.values.length]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(activeIdx))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = model.values.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        // Clamped, not wrapped — matches CommandPalette, and the APG default.
        setActiveIdx((i) => Math.min(i + 1, Math.max(last, 0)));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        e.preventDefault();
        setActiveIdx(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIdx(Math.max(last, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (model.values[activeIdx] !== undefined) choose(model.values[activeIdx]);
        break;
      case "Escape":
        e.preventDefault();
        close(true);
        break;
      // NO "Tab" CASE ON PURPOSE. Closing here unmounted the listbox during
      // the keydown, before the browser had chosen where focus goes — so focus
      // fell to <body> and the next Tab restarted from the top of the page.
      // The wrapper's onBlur closes it once focus has actually landed
      // somewhere outside, which is the same outcome without the drop.
    }
  };

  const onTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    // Enter / Space already reach us as a click. Down/Up are the extra ones a
    // native <select> answers and a <button> does not.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openList();
    }
  };

  const empty = model.values.length === 0;

  return (
    <div
      ref={wrapRef}
      className={clsx("relative", className)}
      // Close once focus has genuinely left the component. relatedTarget is
      // where focus is GOING: null means it left the document entirely
      // (alt-tab, devtools), which must not close the popup — otherwise coming
      // back to the window loses whatever was open.
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && !e.currentTarget.contains(next)) {
          setOpen(false);
          setQuery("");
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={`Owner filter — ${triggerLabel}`}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onTriggerKey}
        className="select flex w-48 items-center gap-2 rounded-lg text-left text-[13px]"
      >
        {selectedTone && (
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: selectedTone.fg }}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <svg
          className="h-3 w-3 shrink-0 text-brand-lightgray"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden
        >
          <path d="M3 4.5 6 7.5 9 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        // Right-anchored: the trigger sits in a right-justified toolbar, so a
        // left-anchored popup wider than 12rem would hang off the viewport.
        <div className="absolute right-0 z-40 mt-1 w-[290px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[10px] border border-surface-border bg-surface-card shadow-lg">
          <div className="border-b border-surface-hairline px-2.5 py-2">
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={empty ? undefined : optionId(activeIdx)}
              aria-label="Filter owners by name or company"
              value={query}
              placeholder="Filter owners…"
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(0);
              }}
              onKeyDown={onSearchKey}
              className="w-full bg-transparent px-1 py-0.5 text-[13px] text-brand-black outline-none placeholder:text-brand-lightgray"
            />
          </div>

          {/* role="status" so the two states a sighted user reads as "not the
              same as an empty list" are announced as well. */}
          {loading && (
            <div role="status" className="px-3 py-3 text-xs italic text-brand-gray">
              Loading owners…
            </div>
          )}
          {failed && (
            <div
              role="status"
              className="border-b border-surface-hairline px-3 py-2 text-[11px] text-brand-deepgold"
            >
              Couldn't group owners by company — showing names only. The filter
              still works.
            </div>
          )}

          {/* Rendered even while loading, so the input's aria-controls always
              resolves to a real node. It is EMPTY in that state rather than
              carrying the "no owners" copy — an empty answer and an unanswered
              question are different things and must not read the same. */}
          <div
            id={listboxId}
            role="listbox"
            aria-label="Owner filter"
            className={clsx("overflow-y-auto py-1", loading ? "max-h-0" : "max-h-[340px]")}
          >
            {loading ? null : (
              empty ? (
                <div className="px-3 py-3 text-xs text-brand-gray">
                  {query.trim()
                    ? `No owner or company matches "${query.trim()}".`
                    : "No actions in scope have an owner yet."}
                </div>
              ) : (
                <>
                  {model.specials.map((s) => (
                    <Row
                      key={s.value}
                      id={optionId(s.idx)}
                      label={s.label}
                      detail={s.detail}
                      selected={value === s.value}
                      active={activeIdx === s.idx}
                      onHover={() => setActiveIdx(s.idx)}
                      onPick={() => choose(s.value)}
                    />
                  ))}

                  {model.sections.map((section, si) => (
                    <div
                      key={`${section.group.company}-${si}`}
                      role="group"
                      aria-labelledby={section.headerId}
                      // The rail is the second, quieter carrier of the same
                      // grouping the header states in words.
                      style={{ borderLeft: `3px solid ${section.tone.fg}` }}
                      className={clsx(si > 0 || model.specials.length ? "mt-1" : "")}
                    >
                      {/* Not an option: no role, not focusable, never a target
                          of the arrow keys. aria-labelledby above is what makes
                          a screen reader announce it as the group's name. */}
                      <div
                        id={section.headerId}
                        className="flex items-baseline gap-2 px-3 py-1.5 text-[11px] font-semibold"
                        style={{ backgroundColor: section.tone.bg, color: section.tone.fg }}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {section.group.is_unmatched
                            ? "Not matched to a company"
                            : section.group.company}
                        </span>
                        <span className="shrink-0 tabular-nums opacity-80">
                          {section.rows.length}
                        </span>
                      </div>

                      {/* Deliberately not styled as a warning. These are real
                          owners; the directory just hasn't met them yet, and
                          saying so is what makes the section actionable. */}
                      {section.group.is_unmatched && (
                        <p className="px-3 pb-1 pt-1.5 text-[10.5px] leading-snug text-brand-gray">
                          Add them under Settings → Clients and they'll file
                          themselves from then on.
                        </p>
                      )}

                      {section.rows.map(({ owner, idx }) => (
                        <Row
                          key={`${section.group.company}:${owner.name}`}
                          id={optionId(idx)}
                          label={owner.name}
                          count={owner.action_count}
                          selected={value === owner.name}
                          active={activeIdx === idx}
                          onHover={() => setActiveIdx(idx)}
                          onPick={() => choose(owner.name)}
                        />
                      ))}
                    </div>
                  ))}
                </>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  id,
  label,
  detail,
  count,
  selected,
  active,
  onHover,
  onPick,
}: {
  id: string;
  label: string;
  detail?: string;
  count?: number;
  selected: boolean;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      // mousedown, not click: it fires before the search input's blur, so the
      // pick can't be pre-empted by the popup closing underneath it.
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={clsx(
        "flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[13px]",
        active ? "bg-surface-mute" : "hover:bg-surface-rowhover",
      )}
    >
      <span
        className={clsx(
          "min-w-0 flex-1 truncate",
          selected ? "font-semibold text-brand-black" : "text-brand-black",
        )}
      >
        {label}
      </span>
      {detail && (
        <span className="shrink-0 truncate text-[11px] text-brand-gray">{detail}</span>
      )}
      {/* 0 means "unknown" in degraded mode, never "no actions" — an owner only
          exists in this list because they own something. */}
      {count !== undefined && count > 0 && (
        <span className="shrink-0 tabular-nums text-[11px] text-brand-lightgray">
          {count}
        </span>
      )}
      {selected && (
        <span aria-hidden className="shrink-0 text-[11px] text-brand-red">
          ✓
        </span>
      )}
    </div>
  );
}
