"""Critical path calculation (P6-style) from the durations and predecessors your tool already has.

    result = apply_cpm(schedule)          # sets activity.total_float and activity.critical
    for w in result.warnings: print(w)

What it does
- Forward pass and backward pass on the schedule's working-day calendar (Mon-Fri, holidays excluded),
  with FS / SS / FF / SF relationships and lags in working days.
- Total Float = Late Finish - Early Finish (P6 default "Finish Float").
- Critical = Total Float <= threshold (P6 default 0), or the Longest Path (P6 option) - see CPMOptions.
- Detects logic loops and predecessors that point at nothing, and names them.

Dates: your tool stays the source of truth.
- update_dates=False (default): the given start of each activity is treated like a P6 "Start On or After"
  floor, so the forward pass reproduces your dates. If your logic would push an activity LATER than the
  date you supplied, or a finish does not match the duration, you get a warning (your dates and your
  logic disagree). Dates are not changed.
- update_dates=True: dates are recalculated from logic + durations (activities with no predecessors keep
  their start). Use this only if you want this package to do the date math.
"""
from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import date

import numpy as np

from .model import Activity, Schedule


class LogicError(ValueError):
    """Raised for logic loops or predecessors that cannot be matched to an activity."""


@dataclass
class CPMOptions:
    method: str = "total_float"        # "total_float" | "longest_path"  (P6: Schedule Options)
    float_threshold: int = 0           # critical if Total Float <= this (working days)
    must_finish_by: date | None = None # P6 project "Must Finish By"; default = calculated early finish
    update_dates: bool = False


@dataclass
class CPMResult:
    project_finish: date
    critical: list = field(default_factory=list)       # activities flagged critical, in display order
    driving_path: list = field(default_factory=list)   # longest path, start -> finish
    warnings: list = field(default_factory=list)


class _Calendar:
    def __init__(self, ref: date, holidays):
        self.h = np.array([np.datetime64(d) for d in holidays], dtype="datetime64[D]")
        self.ref = np.busday_offset(np.datetime64(ref), 0, roll="forward", holidays=self.h)

    def idx(self, d: date) -> int:
        """Working-day index of a date (non-work days roll forward to the next work day)."""
        dd = np.busday_offset(np.datetime64(d), 0, roll="forward", holidays=self.h)
        return int(np.busday_count(self.ref, dd, holidays=self.h)) if dd >= self.ref else \
            -int(np.busday_count(dd, self.ref, holidays=self.h))

    def day(self, i: int) -> date:
        return np.busday_offset(self.ref, i, roll="forward", holidays=self.h).item()


def _build_lookup(acts):
    by = {}
    names = defaultdict(list)
    for a in acts:
        names[a.name.strip().lower()].append(a)
    for a in acts:
        for k in (a.key, a.activity_id):
            if k:
                by[k.strip().lower()] = a
    def find(ref: str, who: Activity) -> Activity:
        r = ref.strip().lower()
        if r in by:
            return by[r]
        hits = names.get(r, [])
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise LogicError(f"Predecessor {ref!r} of {who.name!r} matches {len(hits)} activities by name; "
                             "reference it by key or Activity ID instead.")
        raise LogicError(f"Predecessor {ref!r} of {who.name!r} does not match any activity "
                         "(checked key, Activity ID and name).")
    return find


def _topo(acts, preds):
    indeg = {id(a): len(preds[id(a)]) for a in acts}
    succs = defaultdict(list)
    for a in acts:
        for p, _ in preds[id(a)]:
            succs[id(p)].append(a)
    q = deque(a for a in acts if indeg[id(a)] == 0)
    order = []
    while q:
        a = q.popleft()
        order.append(a)
        for s in succs[id(a)]:
            indeg[id(s)] -= 1
            if indeg[id(s)] == 0:
                q.append(s)
    if len(order) != len(acts):
        stuck = [a.activity_id or a.name for a in acts if indeg[id(a)] > 0]
        raise LogicError("Logic loop (circular predecessors) involving: " + ", ".join(stuck))
    return order, succs


def has_logic(schedule: Schedule) -> bool:
    return any(a.predecessors for a in schedule.root.activities())


def apply_cpm(schedule: Schedule, options: CPMOptions | None = None) -> CPMResult:
    opt = options or CPMOptions()
    acts = list(schedule.root.activities())
    find = _build_lookup(acts)
    preds = {id(a): [(find(l.ref, a), l) for l in a.predecessors] for a in acts}
    order, succs = _topo(acts, preds)
    cal = _Calendar(min(a.start for a in acts), schedule.holidays)
    dur = {id(a): schedule.duration_of(a) for a in acts}
    warnings = []

    # time model: integer working-day boundaries. A task occupies [ES, EF); EF = ES + duration.
    def given_es(a: Activity) -> int:
        if a.milestone == "finish":
            return cal.idx(a.finish) + 1
        return cal.idx(a.start)

    ES, EF = {}, {}
    for a in order:
        d = dur[id(a)]
        floor = given_es(a) if (not opt.update_dates or not preds[id(a)]) else None
        es = floor if floor is not None else -10**9
        for p, l in preds[id(a)]:
            if l.type == "FS":
                es = max(es, EF[id(p)] + l.lag)
            elif l.type == "SS":
                es = max(es, ES[id(p)] + l.lag)
            elif l.type == "FF":
                es = max(es, EF[id(p)] + l.lag - d)
            elif l.type == "SF":
                es = max(es, ES[id(p)] + l.lag - d)
        if es == -10**9:
            es = given_es(a)
        ES[id(a)], EF[id(a)] = es, es + d

        if not opt.update_dates and preds[id(a)] and floor is not None:
            logic_es = max(
                (EF[id(p)] + l.lag) if l.type == "FS" else (ES[id(p)] + l.lag) if l.type == "SS" else
                (EF[id(p)] + l.lag - d) if l.type == "FF" else (ES[id(p)] + l.lag - d)
                for p, l in preds[id(a)])
            if logic_es > floor:
                warnings.append(f"{a.activity_id or a.name}: logic says it cannot start before "
                                f"{cal.day(logic_es) if a.milestone != 'finish' else cal.day(logic_es - 1)}"
                                f", but its date is {a.start if a.milestone != 'finish' else a.finish}.")
        if not a.is_milestone and a.duration is not None:
            if cal.idx(a.finish) + 1 - cal.idx(a.start) != d:
                warnings.append(f"{a.activity_id or a.name}: duration {d} does not match "
                                f"{a.start} - {a.finish} on the calendar.")

    if opt.update_dates:
        for a in acts:
            es, ef = ES[id(a)], EF[id(a)]
            if a.milestone == "finish":
                a.start = a.finish = cal.day(ef - 1)
            elif a.milestone == "start" or dur[id(a)] == 0:
                a.start = a.finish = cal.day(es)
            else:
                a.start, a.finish = cal.day(es), cal.day(ef - 1)

    # backward pass
    pf = max(EF.values())
    if opt.must_finish_by:
        pf = cal.idx(opt.must_finish_by) + 1
    LF, LS = {}, {}
    succ_links = defaultdict(list)
    for a in acts:
        for p, l in preds[id(a)]:
            succ_links[id(p)].append((a, l))
    for a in reversed(order):
        d = dur[id(a)]
        lf = pf
        for s, l in succ_links[id(a)]:
            if l.type == "FS":
                lf = min(lf, LS[id(s)] - l.lag)
            elif l.type == "SS":
                lf = min(lf, LS[id(s)] - l.lag + d)
            elif l.type == "FF":
                lf = min(lf, LF[id(s)] - l.lag)
            elif l.type == "SF":
                lf = min(lf, LF[id(s)] - l.lag + d)
        LF[id(a)], LS[id(a)] = lf, lf - d

    for a in acts:
        a.total_float = LF[id(a)] - EF[id(a)]

    # longest path: walk back from the activities that finish last, through driving relationships
    def drives(p, l, a) -> bool:
        d = dur[id(a)]
        imposed = {"FS": EF[id(p)] + l.lag, "SS": ES[id(p)] + l.lag,
                   "FF": EF[id(p)] + l.lag - d, "SF": ES[id(p)] + l.lag - d}[l.type]
        return imposed == ES[id(a)]
    last = max(EF.values())
    on_path = set()
    stack = [a for a in acts if EF[id(a)] == last]
    while stack:
        a = stack.pop()
        if id(a) in on_path:
            continue
        on_path.add(id(a))
        stack.extend(p for p, l in preds[id(a)] if drives(p, l, a))

    for a in acts:
        if opt.method == "longest_path":
            a.critical = id(a) in on_path
        else:
            a.critical = a.total_float <= opt.float_threshold

    schedule.critical_basis = (
        "Critical path = longest path, calculated from activity logic."
        if opt.method == "longest_path" else
        f"Critical path = Total Float <= {opt.float_threshold} days, calculated from activity logic.")
    return CPMResult(
        project_finish=cal.day(pf - 1),
        critical=[a for a in acts if a.critical],
        driving_path=sorted((a for a in acts if id(a) in on_path), key=lambda a: (ES[id(a)], EF[id(a)])),
        warnings=warnings,
    )
