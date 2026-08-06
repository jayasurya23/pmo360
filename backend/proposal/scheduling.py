"""Proposal scheduling engine — VERBATIM port of the date / predecessor /
roll-up logic from ProposalGenerator (Full_proposal_V9.py).

Ported pieces (line refs to the desktop tool):
  - _is_holiday / _get_holiday_np_array        :6109 / :6123
  - _add_business_days                         :6142
  - _get_business_days_between                 :6173
  - _is_in_project_initiation                  :2400
  - _apply_pi_show_defaults                    :2525
  - _apply_default_link_rules                  :2546
  - get_project_end_date                       :1085
  - calculate_all_dates (+ _seed_pi_dates,
        calculate_milestone_rollup)            :6217
  - tree reconstruction + Client-Review /
        Record-Drawings injection (push_into_generator) :8952

Logic, rules, offsets, and ordering are copied exactly. The ONLY mechanical
changes (no Tkinter on the server, no behavior change):
  * tk var access ``x.enabled.get()`` / ``x.show_start_date.set(v)`` becomes
    plain attribute access ``x.enabled`` / ``x.show_start_date = v`` (our
    ProposalItem uses plain bools);
  * ``self.*`` shared state (project_start, utilization %, fs_start_next_day,
    holidays, item_id_map, template_items) is passed in via ScheduleConfig /
    args;
  * the circular-dependency ``messagebox.showerror`` + return becomes a raised
    CircularDependencyError so the API can surface it (same abort semantics);
  * UI refresh calls (populate_tree/expand/update_project_totals) and debug
    prints are dropped.

NOT ported — an ADDITIVE product rule layered on top (see
find_price_only_predecessor_links / PriceOnlyPredecessorError below): the desktop
tool silently tolerates a price-only predecessor, and calculate_all_dates STILL
does, byte for byte. The new rule is a separate pure function the API calls
before scheduling, so the ported date math is untouched.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Optional

import numpy as np
import holidays as _holidays_pkg

from .models import ProposalItem


class CircularDependencyError(ValueError):
    """Predecessor cycle detected during calculate_all_dates. The desktop tool
    showed a messagebox and returned; we raise so the caller/API surfaces it."""


class PriceOnlyPredecessorError(ValueError):
    """A scheduled task depends on a Price Only row (see the rule's rationale on
    find_price_only_predecessor_links).

    Mirrors CircularDependencyError's SHAPE — a ValueError subclass the API maps
    to 422 — but not its payload. CircularDependencyError carries one fixed
    sentence and names nothing, which on a 200-row tree tells the PM a loop
    exists and nothing about where. This rule is far likelier to fire (the
    predecessor dropdown offered price-only rows until now), and the whole point
    is "prompt the PM to fix it IN the proposal", so it carries ``links`` — every
    offending pair, by id AND name — and the API forwards that list to the UI.
    Collect-then-raise-once, so one trip fixes every row instead of whack-a-mole.
    """

    def __init__(self, links: list[dict]):
        self.links = links
        super().__init__(self.render_message(links))

    @staticmethod
    def render_message(links: list[dict]) -> str:
        """One sentence the PM can act on without expanding anything.

        Names at most three pairs: the banner is a single line above a long
        table, and a wall of names is skimmed past exactly like no names at all.
        The full list still rides along in ``links`` for the per-row tint.
        """
        def pair(l):
            # Spelled out rather than an arrow glyph: which end of "A → B" is the
            # predecessor is exactly the thing the PM is confused about here.
            return f"“{l['successor_name']}” (predecessor “{l['predecessor_name']}”)"

        shown = ", ".join(pair(l) for l in links[:3])
        extra = f" (+{len(links) - 3} more)" if len(links) > 3 else ""
        noun = "task depends" if len(links) == 1 else "tasks depend"
        msg = (
            f"{len(links)} {noun} on a Price Only row: {shown}{extra}. "
            "A Price Only row is excluded from the schedule, so it has no dates "
            "for the task to start from. Pick a different predecessor for that "
            "task, or switch Price Only off on the row it points at."
        )
        # "Open the proposal" used to lead that sentence, but the ONLY screen this
        # message is ever rendered on is the open proposal editor (Proposals.tsx
        # puts e.message straight into calcError), so it sent the PM hunting for
        # another screen. The client banner's own wording ("on each gold row
        # below") stays the more specific of the two.

        # The carve-out is keyed to a top-level section whose name reads as
        # "Project Initiation" (is_project_initiation_section — tolerant of
        # numbering and suffixes, but it still has to say those words). If the
        # section was renamed past recognition, or dragged inside another one,
        # links that were legal for years start failing here and BOTH fixes above
        # are wrong for them: the row is a standard PI row and the link was
        # always fine. Name the real cause or the PM cannot act — nothing else in
        # the UI mentions the section at all.
        orphaned = [l for l in links
                    if l.get("project_initiation_missing") and l.get("predecessor_section")]
        if orphaned:
            sect = orphaned[0].get("predecessor_section") or ""
            msg += (
                f" No top-level section of this proposal is named “Project "
                f"Initiation”, so Price Only rows no longer count as project-start "
                f"rows anywhere in it. If “{sect}” is your Project Initiation "
                f"section, put “Project Initiation” back in its name and move it "
                f"back to the top level — this link becomes legal again."
            )
        # predecessor_id is lock-protected (_LOCKED_PROTECTED_FIELDS), so on a
        # locked row the fix above is silently rejected. Say so, or the PM
        # retries the same edit forever.
        if any(l.get("successor_locked") for l in links):
            msg += " Unlock the row first — a locked row's predecessor can't be changed."
        return msg


@dataclass
class ScheduleConfig:
    """Project-wide schedule inputs (the ``self.*`` tk vars from the desktop tool)."""
    project_start: str                       # "%m/%d/%y"
    utilization_percent: float = 100.0
    # Desktop default is True (Full_proposal_V9.py:987): an FS successor starts
    # the next working day after the predecessor finishes (fs_offset = 2).
    fs_start_next_day: bool = True
    disabled_holidays: frozenset = frozenset()    # holiday NAMES to ignore
    custom_holidays: frozenset = frozenset()      # set[datetime.date]


# ============================================================
# Holiday + business-day math
# ============================================================
def holiday_np_array(start_year, end_year, disabled_holidays, custom_holidays):
    """Port of _get_holiday_np_array: effective holidays (custom ∪ US-federal,
    minus disabled-by-name) as a datetime64[D] array."""
    holiday_dates = set()
    for d in custom_holidays:
        if start_year <= d.year <= end_year:
            holiday_dates.add(d)
    us_hols = _holidays_pkg.UnitedStates(years=range(start_year, end_year + 1))
    for d, name in us_hols.items():
        if name not in disabled_holidays:
            holiday_dates.add(d)
    return (np.array(sorted(holiday_dates), dtype="datetime64[D]")
            if holiday_dates else np.array([], dtype="datetime64[D]"))


def add_business_days(start_date_str, days_to_add, cfg: ScheduleConfig):
    """Port of ProposalGenerator._add_business_days. Snaps the start forward to
    a business day; positive counts the start as day 1 (offset = days-1),
    negative offsets straight. Returns "%m/%d/%y" (or "")."""
    if not start_date_str:
        return ""
    try:
        current_date = datetime.strptime(start_date_str, "%m/%d/%y").date()
    except ValueError:
        return ""

    days_to_add = int(days_to_add)
    est_end_year = current_date.year + max(1, abs(days_to_add) // 200)
    hol_np = holiday_np_array(current_date.year - 1, est_end_year,
                              cfg.disabled_holidays, cfg.custom_holidays)
    d64 = np.datetime64(current_date, "D")

    # Snap start to next business day (always forward)
    d64 = np.busday_offset(d64, 0, roll="forward", holidays=hol_np)

    if days_to_add > 0:
        offset = days_to_add - 1   # start date counts as day 1
    elif days_to_add < 0:
        offset = days_to_add
    else:
        offset = 0

    if offset != 0:
        d64 = np.busday_offset(d64, offset, holidays=hol_np)

    result_date = d64.item()
    return datetime(result_date.year, result_date.month, result_date.day).strftime("%m/%d/%y")


def business_days_between(start_date_str, end_date_str, cfg: ScheduleConfig):
    """Port of _get_business_days_between (inclusive Mon-Fri, holidays excluded)."""
    try:
        start_date = datetime.strptime(start_date_str, "%m/%d/%y").date()
        end_date = datetime.strptime(end_date_str, "%m/%d/%y").date()
        if start_date > end_date:
            return 0
        hol_np = holiday_np_array(start_date.year, end_date.year,
                                  cfg.disabled_holidays, cfg.custom_holidays)
        count = np.busday_count(
            np.datetime64(start_date, "D"),
            np.datetime64(end_date + timedelta(days=1), "D"),
            holidays=hol_np,
        )
        return int(count)
    except (ValueError, TypeError):
        return 0


# ============================================================
# Tree helpers / default rules
# ============================================================
def is_in_project_initiation(item: ProposalItem) -> bool:
    """Port of _is_in_project_initiation — walks the parent chain."""
    cur = item
    while cur:
        if cur.is_milestone and cur.indent_level == 0 and (cur.name or "").strip().lower() == "project initiation":
            return True
        cur = cur.parent
    return False


def find_project_initiation_root(template_items):
    """The ONE Project Initiation root the ported date pass uses.

    Exact port semantics, unchanged: first top-level milestone whose name is
    exactly "project initiation", then stop. _seed_pi_dates and
    apply_pi_show_defaults both had this loop inline and both took the first
    match; sharing it here is a refactor, not a behaviour change.
    """
    for r in template_items:
        if r.is_milestone and (r.name or "").strip().lower() == "project initiation":
            return r
    return None


def _pi_name_key(name: str) -> str:
    """Letters and digits only, lowercased — "1. Project Initiation & Mobilization"
    and "Project Initiation" collapse to strings that share one substring."""
    return "".join(ch for ch in (name or "").lower() if ch.isalnum())


def is_project_initiation_section(item) -> bool:
    """Is this top-level row the project's kickoff block?

    DELIBERATELY LOOSER than find_project_initiation_root above, in two ways: it
    substring-matches a punctuation-stripped name (so "1. Project Initiation",
    "Project Initiation Phase" and "Project Initiation & Mobilization" all still
    count) and it does not require is_milestone. Only the price-only-predecessor
    guard uses it. That divergence is deliberate and it is safe, for a reason
    worth spelling out because the obvious reading says otherwise:

      * What the exact-name match drives in the ENGINE is _seed_pi_dates, which
        stamps project_start onto PI price-only rows. Rename the section and
        those rows lose their dates.
      * But a successor NEVER reads them. calculate_all_dates:573-575 sets
        ``pred_item = None`` whenever the predecessor is price_only, BEFORE the
        date branch, so a task keyed off a PI price-only row lands on
        project_start whether or not the seeding ran. Measured: same tree, PI
        section renamed, successor 01/05/26 -> 01/16/26 in BOTH cases.
      * So the exemption is not "this row has seeded dates". It is "this section
        IS day one, so starting the successor on day one is the intended answer,
        not a dropped link" — and that stays true through a rename.

    Making the guard match the engine's string exactly would therefore refuse a
    save for an edit that provably changes no date. Ten of the fifty production
    workbooks carry a standard 30%-task -> PI Due-Diligence link that is legal
    only by this carve-out, and all fifty spell the section exactly, i.e. every
    one of them was a single rename away from a permanently unsaveable proposal
    whose 422 named a task and a row that were never the problem. Refusing a
    legitimate edit is worse than the wrong date this rule exists to stop, so the
    guard errs wide. "Additional Services", the other all-price-only section and
    the one whose rows must NOT be legal predecessors, does not match.
    """
    return "projectinitiation" in _pi_name_key(getattr(item, "name", ""))


def project_initiation_roots(template_items) -> list:
    """Every TOP-LEVEL row that reads as the kickoff block (see above).

    "Top-level" is read off the TREE — this list is ``template_items``, i.e. the
    rows deserialize_tree/build_tree left with no parent. Deliberately NOT off
    ``item.indent_level``: that field arrives from the client and is only
    advisory once the nesting has been rebuilt, so a row buried inside Electrical
    Engineering can declare indent_level 0 and, under a predicate that trusts it,
    win the carve-out for every price-only row beneath it. is_in_project_initiation
    still reads indent_level because the desktop tool did and it feeds the ported
    utilization math; this predicate is new code and does not inherit that.

    All matches, not just the first: refusing a PM's save is a far harsher answer
    than skipping a date seed, and a tree with two kickoff sections is a
    malformed structure, not something to hard-block on.
    """
    return [r for r in template_items if is_project_initiation_section(r)]


def top_level_ancestor(item):
    """The root section an item hangs under (itself when it is already a root)."""
    cur = item
    while cur.parent is not None:
        cur = cur.parent
    return cur


def walk_tree(nodes):
    """Every node in the forest, parents before children.

    The same traversal serialize_tree persists with — which is the point: a guard
    that iterates item_id_map instead cannot see a row whose id is shadowed by a
    later duplicate (``item_id_map[it.id] = it`` is last-write-wins), yet that row
    is stored all the same.
    """
    for n in nodes:
        yield n
        yield from walk_tree(n.children)


def is_schedulable_task(t) -> bool:
    """A row the date pass actually schedules.

    Lifted out of apply_default_link_rules' closure (unchanged body) so the
    price-only-predecessor guard below and the default-link rules cannot drift
    apart on what "a real task" means — the guard has to agree with the engine
    or it flags rows the scheduler never touches. Same filter calculate_all_dates
    builds ``all_tasks`` from.
    """
    return t is not None and not t.is_milestone and t.enabled and not t.price_only


def find_price_only_predecessor_links(template_items, item_id_map) -> list[dict]:
    """Every link where a SCHEDULED task depends on a Price Only row.

    Why this is an error at all: a price-only row carries a price but is excluded
    from the date pass, so it has no end date for a successor to build on. The
    engine's response (calculate_all_dates:387 ``pass``, :435 ``pred_item =
    None``) is to drop the edge and start the successor at project_start — i.e.
    the link the PM drew is silently ignored and the task lands on day one. That
    is a wrong date with no warning anywhere, which is what this rule ends.

    Scoped narrowly, on purpose — a blanket "no price-only predecessor" check
    rejects the SHIPPED standard structure and no proposal could be created:

      * Successor must be schedulable. A price-only → price-only link (the whole
        Project Initiation chain, the whole Additional Services chain, both
        generated by parsing.py) is inert at both ends and harmless. Milestones
        never chain off a predecessor either (calculate_all_dates nulls those).
      * Predecessor must be OUTSIDE Project Initiation. PI is the kickoff block:
        parsing.py:869-875 wires each discipline's first 30% task to a PI
        Due-Diligence row on purpose, and the engine's answer for those — start
        the successor at project_start — is the intended one, because the whole
        section IS the project start. See is_project_initiation_section for why
        that carve-out is matched loosely, and why matching it as strictly as the
        engine does would refuse legitimate saves without changing a single date.

    Verified against all 50 desktop template workbooks imported into prod: this
    predicate flags 0 links; dropping the two clauses above flags 85 across 23
    files. Pure read — mutates nothing, so it is safe to call before scheduling.

    Takes the TREE as well as the id map. Iterating the map alone missed any row
    whose id a later duplicate had overwritten (serialization.py:211 is
    last-write-wins) even though serialize_tree walks the tree and stores it — so
    a payload with two rows sharing an id could park an illegal link in the
    database through this very guard. Predecessors are still resolved THROUGH the
    map, because that is the object calculate_all_dates:524 resolves too: the
    guard and the engine have to agree about which row an id means.

    Returns one dict per offending link (sorted by successor id for a stable
    message), carrying ids AND names because the UI has to name the row the PM
    must open, plus the predecessor's top-level section so the message can
    diagnose a Project Initiation section that no longer matches by name.
    """
    pi_roots = project_initiation_roots(template_items)
    out: list[dict] = []
    for item in walk_tree(template_items):
        # `is None`, not falsy: predecessor_id 0 is a real key in the map, and a
        # falsy test quietly exempted it while the client's own mirror flagged it.
        if item.predecessor_id is None or not is_schedulable_task(item):
            continue
        pred = item_id_map.get(item.predecessor_id)
        # A dangling id (predecessor row deleted) is a different defect the
        # engine already tolerates and the UI already tints gold — not ours.
        if pred is None or not pred.price_only:
            continue
        section = top_level_ancestor(pred)
        # Identity, not ==: ProposalItem is an eq-able dataclass whose children
        # compare recursively, so `section in pi_roots` would walk the subtree.
        if any(section is r for r in pi_roots):
            continue
        out.append({
            "successor_id": item.id,
            "successor_name": item.name or f"#{item.id}",
            "successor_locked": bool(getattr(item, "locked", False)),
            "predecessor_id": pred.id,
            "predecessor_name": pred.name or f"#{pred.id}",
            # Diagnostics for render_message: which section the predecessor lives
            # in, and whether this tree has ANY recognised Project Initiation at
            # all. Together they tell "you pointed at an Additional Services fee"
            # apart from "you renamed Project Initiation past recognition", which
            # need opposite fixes and used to produce the same sentence.
            "predecessor_section": section.name or "",
            "project_initiation_missing": not pi_roots,
        })
    out.sort(key=lambda l: (l["successor_id"] is None, l["successor_id"] or 0))
    return out


def assert_no_price_only_predecessors(template_items, item_id_map) -> None:
    """Raise PriceOnlyPredecessorError if any link violates the rule above.

    Deliberately NOT called from calculate_all_dates: that function is the
    verbatim port and must keep tolerating these links, so that reading, opening,
    importing, exporting and re-dating an existing proposal all still work. Only
    the PM-driven write paths call this (see api/proposals.py put_tree /
    recompute_version), which is what lets a PM open a violating proposal, see
    the offending rows, and fix them — rather than being locked out of the very
    screen where the fix lives.
    """
    links = find_price_only_predecessor_links(template_items, item_id_map)
    if links:
        raise PriceOnlyPredecessorError(links)


def apply_pi_show_defaults(template_items) -> None:
    """Port of _apply_pi_show_defaults — hide Start/End for PI descendants."""
    def walk(node):
        for c in node.children:
            yield c
            yield from walk(c)

    # Same "first PI root, then stop" the port had inline — now via the shared
    # resolver so this, _seed_pi_dates and the price-only carve-out cannot
    # disagree about which section is Project Initiation.
    root = find_project_initiation_root(template_items)
    if root is not None:
        for d in walk(root):
            if not d.is_milestone:
                d.show_start_date = False
                d.show_end_date = False


def apply_default_link_rules(template_items, only_type_defaults: bool = False) -> None:
    """Port of _apply_default_link_rules.

    Rule 1 (setup-only): within an engineering parent, the first schedulable
    task of a sub-milestone gets the previous sub-milestone's last Client Review
    as its FS predecessor (skipped when only_type_defaults=True so manual wiring
    survives recalcs).
    Rule 2 (always): under "Electrical Engineering", tasks whose name contains
    "study" default to FS (unless the user explicitly set the type).
    """
    # Body moved to module scope (is_schedulable_task) so the price-only
    # predecessor guard shares this exact definition. Same predicate, same
    # behaviour — the alias just keeps the ported code below reading verbatim.
    is_schedulable = is_schedulable_task

    def find_last_client_review(items):
        for t in reversed(items):
            if is_schedulable(t) and "client review" in t.name.lower():
                return t
        return None

    def first_schedulable(items):
        for t in items:
            if is_schedulable(t):
                return t
        return None

    def walk_descendants(node):
        for c in node.children:
            yield c
            yield from walk_descendants(c)

    for root in template_items:
        if not root.is_milestone:
            continue

        if not only_type_defaults:
            sub_ms = [c for c in root.children if c.is_milestone and c.children]
            for i in range(len(sub_ms) - 1):
                cur, nxt = sub_ms[i], sub_ms[i + 1]
                cr = find_last_client_review(cur.children)
                if cr is None:
                    continue
                nxt_first = first_schedulable(nxt.children)
                if nxt_first is None:
                    continue
                nxt_first.predecessor_id = cr.id
                nxt_first.predecessor_type = "FS"
                nxt_first.lag = 0

        if "electrical engineering" in root.name.lower():
            for t in walk_descendants(root):
                if (not t.is_milestone
                        and "study" in t.name.lower()
                        and not t.predecessor_type_user_set):
                    t.predecessor_type = "FS"


def get_project_end_date(item_id_map) -> Optional[str]:
    """Port of get_project_end_date — latest enabled end_date, "%m/%d/%y"."""
    latest = None
    for item in item_id_map.values():
        if item.enabled and item.end_date:
            try:
                dt = datetime.strptime(item.end_date, "%m/%d/%y")
                if latest is None or dt > latest:
                    latest = dt
            except ValueError:
                pass
    return latest.strftime("%m/%d/%y") if latest else None


# ============================================================
# Tree reconstruction from flattened rows (push_into_generator)
# ============================================================
def build_tree(rows_out):
    """Port of push_into_generator's reconstruction + post-build augmentation.

    Builds the ProposalItem tree from flatten_to_template_rows output, wires
    parent/child + predecessor (study->FF else FS), then injects a 5-day
    "Client Review" under each engineering sub-milestone (skipping Additional
    Services / existing reviews) and a disabled "Record Drawings" milestone per
    engineering branch, and finally applies the default link rules + PI
    show-defaults. The Tkinter tree refresh and project-info var wiring are
    handled elsewhere (API layer).

    Returns (template_items, item_id_map, task_counter).
    """
    id_to_item = {}

    def mk_item(row):
        it = ProposalItem(
            name=row["Name"],
            duration=int(row["Duration"] or 0),
            price=int(row["Price"] or 0),
            is_milestone=bool(row["Is Milestone"]),
            indent_level=int(row["Indent Level"] or 0),
            id=int(row["ID"]),
        )
        it.targeted_hours = row.get("Targeted Hours")
        it.price_only = bool(row.get("Price Only", False))
        return it

    for r in rows_out:
        id_to_item[r["ID"]] = mk_item(r)

    for r in rows_out:
        item = id_to_item[r["ID"]]
        pid = r["Parent ID"]
        if pid:
            parent = id_to_item.get(pid)
            if parent:
                item.parent = parent
                item.parent_id = parent.id
                parent.children.append(item)
        pred = r["Predecessor ID"]
        if pred:
            item.predecessor_id = int(pred)
            # Set predecessor type to 'FF' if task name contains "study", otherwise 'FS'
            if "study" in item.name.lower():
                item.predecessor_type = "FF"
            else:
                item.predecessor_type = "FS"
            item.lag = int(r.get("Lag") or 0)
        item.enabled = bool(r["Enabled"])

    template_items = [it for it in id_to_item.values() if it.parent is None]
    item_id_map = {it.id: it for it in id_to_item.values()}
    task_counter = max(item_id_map.keys()) if item_id_map else 0

    # Add "Client Review" tasks to every engineering discipline's design phases.
    #
    # This used to be an allow-list of three names (civil / electrical /
    # structural), which silently skipped any discipline Castillo added later —
    # Substation, BESS, and anything invented next. The PM then had to hand-add
    # every Client Review row, and the section looked like the app "didn't
    # recognise" it. Inverted to a deny-list so a new discipline works by
    # default: what disqualifies a root section is being administrative, not
    # being absent from a list nobody remembers to update.
    non_disciplines = ("project initiation", "project closeout",
                       "additional services", "record drawings",
                       "client review", "assumptions", "exclusions")

    for root_item in template_items:
        root_name = (root_item.name or "").lower()
        if root_item.is_milestone and not any(k in root_name for k in non_disciplines):
            for child in root_item.children:
                # Skip adding client review under Additional Services
                if child.is_milestone and child.children and "additional services" not in child.name.lower():
                    has_client_review = any(
                        "client review" in grandchild.name.lower() for grandchild in child.children)
                    if not has_client_review:
                        task_counter += 1
                        client_review_task = ProposalItem(
                            name="Client Review",
                            duration=5,
                            price=0,
                            is_milestone=False,
                            indent_level=child.indent_level + 1,
                            id=task_counter,
                        )
                        client_review_task.parent = child
                        client_review_task.parent_id = child.id
                        client_review_task.enabled = True
                        if child.children:
                            last_child = child.children[-1]
                            if last_child.id in item_id_map:
                                client_review_task.predecessor_id = last_child.id
                                client_review_task.predecessor_type = "FS"
                                client_review_task.lag = 0
                        child.children.append(client_review_task)
                        item_id_map[client_review_task.id] = client_review_task

            # Add "Record Drawings" milestone as the last child (disabled by default)
            has_record_drawings = any(
                "record drawings" in child.name.lower() for child in root_item.children)
            if not has_record_drawings:
                task_counter += 1
                record_drawings_milestone = ProposalItem(
                    name="Record Drawings",
                    duration=0,
                    price=0,
                    is_milestone=True,
                    indent_level=root_item.indent_level + 1,
                    id=task_counter,
                )
                record_drawings_milestone.parent = root_item
                record_drawings_milestone.parent_id = root_item.id
                record_drawings_milestone.enabled = False
                root_item.children.append(record_drawings_milestone)
                item_id_map[record_drawings_milestone.id] = record_drawings_milestone

    # Apply Client-Review-as-predecessor and Electrical-studies-FS defaults
    apply_default_link_rules(template_items)
    # Default PI rows' Show Start / Show End to off
    apply_pi_show_defaults(template_items)

    return template_items, item_id_map, task_counter


# ============================================================
# The scheduling engine
# ============================================================
def calculate_all_dates(template_items, item_id_map, cfg: ScheduleConfig, unpin_all: bool = False):
    """Port of ProposalGenerator.calculate_all_dates. Mutates items in place and
    returns template_items. Raises CircularDependencyError on a predecessor cycle."""
    # Re-assert the Electrical-studies-FS default each recalc (type defaults only,
    # so manual CR wiring sticks).
    apply_default_link_rules(template_items, only_type_defaults=True)

    if unpin_all:
        for item in item_id_map.values():
            item.is_start_pinned = False

    for item in item_id_map.values():
        if not item.is_start_pinned:
            item.start_date = ""
            item.end_date = ""

    # Exclude price-only items from date calculations
    all_tasks = [item for item in item_id_map.values()
                 if item.enabled and not item.is_milestone and not item.price_only]

    graph = {item.id: [] for item in all_tasks}
    in_degree = {item.id: 0 for item in all_tasks}
    for item in all_tasks:
        if item.predecessor_id and item.predecessor_id in item_id_map:
            pred = item_id_map[item.predecessor_id]
            if pred.price_only:
                pass
            elif pred.enabled:
                if item.predecessor_id in graph:
                    graph[item.predecessor_id].append(item.id)
                    in_degree[item.id] += 1
                else:
                    item.predecessor_id = None

    queue = deque(item_id for item_id in in_degree if in_degree[item_id] == 0)
    sorted_order = []
    while queue:
        u_id = queue.popleft()
        sorted_order.append(u_id)
        for v_id in graph.get(u_id, []):
            in_degree[v_id] -= 1
            if in_degree[v_id] == 0:
                queue.append(v_id)

    if len(sorted_order) != len(all_tasks):
        raise CircularDependencyError(
            "A circular dependency was detected. Please fix the predecessors.")

    project_start = cfg.project_start

    global_util_pct = cfg.utilization_percent
    if global_util_pct <= 0:
        global_util_pct = 100.0

    for item_id in sorted_order:
        item = item_id_map[item_id]

        is_cr = "client review" in (item.name or "").lower()
        task_util = getattr(item, "task_utilization", None)
        if task_util is not None:
            util_pct = float(task_util) if float(task_util) > 0 else 100.0
        else:
            util_pct = global_util_pct

        if (util_pct != 100.0
                and not is_in_project_initiation(item)
                and not is_cr):
            adj_dur = math.ceil(item.duration / (util_pct / 100.0))
        else:
            adj_dur = item.duration

        if not item.is_start_pinned:
            pred_item = item_id_map.get(item.predecessor_id) if item.predecessor_id else None
            if pred_item and pred_item.price_only:
                pred_item = None

            if pred_item and pred_item.enabled and pred_item.end_date:
                if is_cr and adj_dur == 0:
                    # A zero-day Client Review is a marker that sits ON its
                    # predecessor's end date: both start and end equal the
                    # dependent task/milestone's end (no "next business day"
                    # FS offset). end_date below resolves to the same date since
                    # add_business_days(pred_end, 0) == pred_end.
                    item.start_date = pred_item.end_date
                elif item.predecessor_type == "FS":
                    fs_offset = 2 if cfg.fs_start_next_day else 1
                    item.start_date = add_business_days(pred_item.end_date, item.lag + fs_offset, cfg)
                elif item.predecessor_type == "SS":
                    item.start_date = add_business_days(pred_item.start_date, item.lag, cfg)
                elif item.predecessor_type == "FF":
                    finish_date = add_business_days(pred_item.end_date, item.lag, cfg)
                    item.start_date = add_business_days(finish_date, -adj_dur + 1, cfg)
                elif item.predecessor_type == "SF":
                    finish_date = add_business_days(pred_item.start_date, item.lag, cfg)
                    item.start_date = add_business_days(finish_date, -adj_dur + 1, cfg)
            else:
                item.start_date = project_start

        item.end_date = add_business_days(item.start_date, adj_dur, cfg)

    # Price-only descendants of "Project Initiation" inherit project start
    def _seed_pi_dates(node):
        for c in node.children:
            if not c.is_milestone and c.price_only:
                c.start_date = project_start
                c.end_date = project_start
            if c.children:
                _seed_pi_dates(c)

    # Unchanged selection (first top-level milestone named "Project Initiation",
    # then stop) — routed through the shared resolver, see project_initiation_roots.
    pi_root = find_project_initiation_root(template_items)
    if pi_root is not None:
        _seed_pi_dates(pi_root)

    def calculate_milestone_rollup(items):
        for item in items:
            if not (item.enabled and item.is_milestone):
                continue
            if item.children:
                calculate_milestone_rollup(item.children)
            enabled_children = [c for c in item.children if c.enabled]
            if enabled_children:
                valid_starts = [datetime.strptime(c.start_date, "%m/%d/%y")
                                for c in enabled_children if c.start_date]
                valid_ends = [datetime.strptime(c.end_date, "%m/%d/%y")
                              for c in enabled_children if c.end_date]
                if valid_starts:
                    item.start_date = min(valid_starts).strftime("%m/%d/%y")
                if valid_ends:
                    item.end_date = max(valid_ends).strftime("%m/%d/%y")
                item.duration = business_days_between(item.start_date, item.end_date, cfg)
                item.price = sum(c.price for c in enabled_children)
            else:
                item.price = 0

    calculate_milestone_rollup(template_items)

    project_end = get_project_end_date(item_id_map)
    if project_end:
        for item in template_items:
            if (item.name.strip().lower() == "project closeout"
                    and item.is_milestone and item.indent_level == 0):
                item.start_date = project_end
                item.end_date = project_end
                break

    return template_items
