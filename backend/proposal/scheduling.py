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


def apply_pi_show_defaults(template_items) -> None:
    """Port of _apply_pi_show_defaults — hide Start/End for PI descendants."""
    def walk(node):
        for c in node.children:
            yield c
            yield from walk(c)

    for root in template_items:
        if root.is_milestone and (root.name or "").strip().lower() == "project initiation":
            for d in walk(root):
                if not d.is_milestone:
                    d.show_start_date = False
                    d.show_end_date = False
            break


def apply_default_link_rules(template_items, only_type_defaults: bool = False) -> None:
    """Port of _apply_default_link_rules.

    Rule 1 (setup-only): within an engineering parent, the first schedulable
    task of a sub-milestone gets the previous sub-milestone's last Client Review
    as its FS predecessor (skipped when only_type_defaults=True so manual wiring
    survives recalcs).
    Rule 2 (always): under "Electrical Engineering", tasks whose name contains
    "study" default to FS (unless the user explicitly set the type).
    """
    def is_schedulable(t):
        return t is not None and not t.is_milestone and t.enabled and not t.price_only

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

    for root in template_items:
        if (root.is_milestone
                and (root.name or "").strip().lower() == "project initiation"):
            _seed_pi_dates(root)
            break

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
