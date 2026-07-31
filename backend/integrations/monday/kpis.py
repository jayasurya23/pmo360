"""KPI computation over monday.com task data.

Three families, matching what the boards actually instrument:

* **Schedule performance** — on-time completion, schedule variance by phase
  and discipline, slipped tasks.
* **QC / rework** — cycle time from "ready for QC" to "QC complete".
* **Effort & margin** — targeted vs actual hours, billable vs actual cost.

Design rule: **every measure reports its own coverage.** A rate computed from
3 of 438 tasks and a rate computed from 400 of 438 are not the same claim, and
a dashboard that prints "67%" for both is lying by omission. :class:`Measure`
carries ``sample_size`` and ``population`` so the UI can show the denominator
and grey out anything too thin to mean much.

This matters concretely for Castillo right now: at the time of writing all 438
tasks on the Nesler board sit at ``Not Started`` with no QC records, so nearly
every measure here is legitimately ``None``. That must render as "no data yet",
never as "0%" — the latter reads as failure where the truth is "not started".
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from statistics import mean
from typing import Callable, Iterable, Optional

from .columns import MondayTask

#: Below this many contributing tasks a rate is too noisy to act on. The UI
#: shows the number but flags it as low-confidence.
LOW_CONFIDENCE_THRESHOLD = 5


@dataclass
class Measure:
    """One computed number, plus enough context to judge whether to trust it.

    ``value`` is ``None`` when nothing in the population could contribute —
    which is a different statement from ``0.0``.
    """

    value: Optional[float] = None
    sample_size: int = 0
    population: int = 0
    unit: str = ""

    @property
    def coverage(self) -> Optional[float]:
        """Fraction of the population that contributed, 0-1."""
        if not self.population:
            return None
        return self.sample_size / self.population

    @property
    def is_low_confidence(self) -> bool:
        return 0 < self.sample_size < LOW_CONFIDENCE_THRESHOLD

    def as_dict(self) -> dict:
        return {
            "value": self.value,
            "sample_size": self.sample_size,
            "population": self.population,
            "coverage": self.coverage,
            "unit": self.unit,
            "low_confidence": self.is_low_confidence,
        }


def _measure(
    tasks: Iterable[MondayTask],
    extract: Callable[[MondayTask], Optional[float]],
    *,
    unit: str,
    aggregate: Callable[[list[float]], float] = mean,
) -> Measure:
    """Aggregate ``extract`` across ``tasks``, skipping unreadable values."""
    population = 0
    values: list[float] = []
    for task in tasks:
        population += 1
        got = extract(task)
        if got is not None:
            values.append(got)
    return Measure(
        value=aggregate(values) if values else None,
        sample_size=len(values),
        population=population,
        unit=unit,
    )


def _rate(numerator: int, denominator: int, *, unit: str = "ratio") -> Measure:
    return Measure(
        value=(numerator / denominator) if denominator else None,
        sample_size=denominator,
        population=denominator,
        unit=unit,
    )


# ---------------------------------------------------------------- families
@dataclass
class ScheduleKpis:
    total_tasks: int = 0
    countable_tasks: int = 0
    completed_tasks: int = 0
    not_started_tasks: int = 0
    in_progress_tasks: int = 0
    blocked_tasks: int = 0

    completion_rate: Measure = field(default_factory=Measure)
    on_time_rate: Measure = field(default_factory=Measure)
    avg_schedule_variance_days: Measure = field(default_factory=Measure)
    overdue_tasks: int = 0
    #: phase label -> {completed, total, avg_variance_days}
    by_phase: dict = field(default_factory=dict)
    by_discipline: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "total_tasks": self.total_tasks,
            "countable_tasks": self.countable_tasks,
            "completed_tasks": self.completed_tasks,
            "not_started_tasks": self.not_started_tasks,
            "in_progress_tasks": self.in_progress_tasks,
            "blocked_tasks": self.blocked_tasks,
            "overdue_tasks": self.overdue_tasks,
            "completion_rate": self.completion_rate.as_dict(),
            "on_time_rate": self.on_time_rate.as_dict(),
            "avg_schedule_variance_days": self.avg_schedule_variance_days.as_dict(),
            "by_phase": self.by_phase,
            "by_discipline": self.by_discipline,
        }


@dataclass
class QcKpis:
    tasks_in_qc: int = 0
    tasks_qc_complete: int = 0
    avg_cycle_days: Measure = field(default_factory=Measure)
    median_cycle_days: Measure = field(default_factory=Measure)
    awaiting_qc: int = 0

    def as_dict(self) -> dict:
        return {
            "tasks_in_qc": self.tasks_in_qc,
            "tasks_qc_complete": self.tasks_qc_complete,
            "awaiting_qc": self.awaiting_qc,
            "avg_cycle_days": self.avg_cycle_days.as_dict(),
            "median_cycle_days": self.median_cycle_days.as_dict(),
        }


@dataclass
class EffortKpis:
    planned_hours_total: Measure = field(default_factory=Measure)
    actual_hours_total: Measure = field(default_factory=Measure)
    hours_variance_total: Measure = field(default_factory=Measure)
    billable_cost_total: Measure = field(default_factory=Measure)
    actual_cost_total: Measure = field(default_factory=Measure)
    #: actual / billable. >1 means the work cost more than it bills.
    cost_ratio: Optional[float] = None
    by_discipline: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "planned_hours_total": self.planned_hours_total.as_dict(),
            "actual_hours_total": self.actual_hours_total.as_dict(),
            "hours_variance_total": self.hours_variance_total.as_dict(),
            "billable_cost_total": self.billable_cost_total.as_dict(),
            "actual_cost_total": self.actual_cost_total.as_dict(),
            "cost_ratio": self.cost_ratio,
            "by_discipline": self.by_discipline,
        }


@dataclass
class BoardKpis:
    board_id: str
    board_name: Optional[str] = None
    schedule: ScheduleKpis = field(default_factory=ScheduleKpis)
    qc: QcKpis = field(default_factory=QcKpis)
    effort: EffortKpis = field(default_factory=EffortKpis)
    #: Human-readable notes about data problems found while computing.
    data_quality: list[str] = field(default_factory=list)

    @property
    def has_execution_data(self) -> bool:
        """False when the board is populated but nobody has worked it yet.

        Lets the UI show "tracking not started" instead of a wall of zeros.
        """
        return (
            self.schedule.completed_tasks > 0
            or self.schedule.in_progress_tasks > 0
            or self.qc.tasks_qc_complete > 0
            or (self.effort.actual_hours_total.value or 0) > 0
        )

    def as_dict(self) -> dict:
        return {
            "board_id": self.board_id,
            "board_name": self.board_name,
            "has_execution_data": self.has_execution_data,
            "schedule": self.schedule.as_dict(),
            "qc": self.qc.as_dict(),
            "effort": self.effort.as_dict(),
            "data_quality": self.data_quality,
        }


# ---------------------------------------------------------------- compute
def _median(values: list[float]) -> float:
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def compute_schedule_kpis(tasks: list[MondayTask], *, today) -> ScheduleKpis:
    countable = [t for t in tasks if t.is_countable]
    completed = [t for t in countable if t.is_done]

    def _status_is(task: MondayTask, *names: str) -> bool:
        return (task.status or "").strip().lower() in names

    not_started = [t for t in countable if _status_is(t, "not started")]
    in_progress = [t for t in countable if _status_is(t, "in progress", "in qc")]
    blocked = [t for t in countable if _status_is(t, "requires action", "on hold")]

    overdue = [
        t for t in countable
        if not t.is_done and t.end_date is not None and t.end_date < today
    ]

    # On-time is judged only on tasks whose completion we can trust — status
    # says done AND a completion date exists AND a planned end exists.
    on_time_judgeable = [t for t in completed if t.finished_on_time is not None]
    on_time_hits = sum(1 for t in on_time_judgeable if t.finished_on_time)

    by_phase: dict = {}
    grouped_phase: dict[str, list[MondayTask]] = defaultdict(list)
    for task in countable:
        grouped_phase[task.phase or "(unassigned)"].append(task)
    for phase, group in grouped_phase.items():
        variance = _measure(
            group, lambda t: t.schedule_variance_days, unit="days"
        )
        by_phase[phase] = {
            "total": len(group),
            "completed": sum(1 for t in group if t.is_done),
            "avg_schedule_variance_days": variance.as_dict(),
        }

    by_discipline: dict = {}
    grouped_disc: dict[str, list[MondayTask]] = defaultdict(list)
    for task in countable:
        # A task tagged "PMO, Civil, Electrical" counts once under each — it
        # consumes capacity in all three, so per-discipline totals are
        # intentionally not a partition of the board.
        for discipline in (task.disciplines or ["(untagged)"]):
            grouped_disc[discipline].append(task)
    for discipline, group in grouped_disc.items():
        by_discipline[discipline] = {
            "total": len(group),
            "completed": sum(1 for t in group if t.is_done),
            "avg_schedule_variance_days": _measure(
                group, lambda t: t.schedule_variance_days, unit="days"
            ).as_dict(),
        }

    return ScheduleKpis(
        total_tasks=len(tasks),
        countable_tasks=len(countable),
        completed_tasks=len(completed),
        not_started_tasks=len(not_started),
        in_progress_tasks=len(in_progress),
        blocked_tasks=len(blocked),
        overdue_tasks=len(overdue),
        completion_rate=_rate(len(completed), len(countable)),
        on_time_rate=Measure(
            value=(on_time_hits / len(on_time_judgeable)) if on_time_judgeable else None,
            sample_size=len(on_time_judgeable),
            population=len(completed),
            unit="ratio",
        ),
        avg_schedule_variance_days=_measure(
            countable, lambda t: t.schedule_variance_days, unit="days"
        ),
        by_phase=by_phase,
        by_discipline=by_discipline,
    )


def compute_qc_kpis(tasks: list[MondayTask]) -> QcKpis:
    in_qc = [t for t in tasks if (t.qc_status or "").strip().lower() == "in qc"]
    qc_done = [
        t for t in tasks if (t.qc_status or "").strip().lower() == "qc complete"
    ]
    awaiting = [
        t for t in tasks if (t.qc_status or "").strip().lower() == "initiate qc"
    ]

    # Prefer monday's own cycle-time formula; fall back to the raw date pair
    # when the formula column is blank but both stamps exist.
    def cycle(task: MondayTask) -> Optional[float]:
        if task.qc_cycle_days is not None:
            return task.qc_cycle_days
        if task.qc_ready_date and task.qc_complete_date:
            delta = (task.qc_complete_date - task.qc_ready_date).days
            return float(max(delta, 1))  # same-day review counts as 1 day
        return None

    population = qc_done or tasks
    cycle_values = [c for c in (cycle(t) for t in population) if c is not None]

    return QcKpis(
        tasks_in_qc=len(in_qc),
        tasks_qc_complete=len(qc_done),
        awaiting_qc=len(awaiting),
        avg_cycle_days=Measure(
            value=mean(cycle_values) if cycle_values else None,
            sample_size=len(cycle_values),
            population=len(population),
            unit="days",
        ),
        median_cycle_days=Measure(
            value=_median(cycle_values) if cycle_values else None,
            sample_size=len(cycle_values),
            population=len(population),
            unit="days",
        ),
    )


def compute_effort_kpis(tasks: list[MondayTask]) -> EffortKpis:
    def total(extract: Callable[[MondayTask], Optional[float]], unit: str) -> Measure:
        return _measure(tasks, extract, unit=unit, aggregate=sum)

    planned = total(lambda t: t.planned_hours, "hours")
    actual = total(lambda t: t.actual_hours, "hours")
    billable = total(lambda t: t.billable_cost, "usd")
    actual_cost = total(lambda t: t.actual_cost, "usd")

    ratio: Optional[float] = None
    if billable.value:  # guards both None and 0 — no divide-by-zero
        ratio = (actual_cost.value or 0.0) / billable.value

    by_discipline: dict = {}
    grouped: dict[str, list[MondayTask]] = defaultdict(list)
    for task in tasks:
        for discipline in (task.disciplines or ["(untagged)"]):
            grouped[discipline].append(task)
    for discipline, group in grouped.items():
        by_discipline[discipline] = {
            "planned_hours": _measure(
                group, lambda t: t.planned_hours, unit="hours", aggregate=sum
            ).as_dict(),
            "actual_hours": _measure(
                group, lambda t: t.actual_hours, unit="hours", aggregate=sum
            ).as_dict(),
        }

    return EffortKpis(
        planned_hours_total=planned,
        actual_hours_total=actual,
        hours_variance_total=total(lambda t: t.hours_variance, "hours"),
        billable_cost_total=billable,
        actual_cost_total=actual_cost,
        cost_ratio=ratio,
        by_discipline=by_discipline,
    )


def audit_data_quality(tasks: list[MondayTask]) -> list[str]:
    """Flag contradictions that would otherwise silently distort the numbers."""
    notes: list[str] = []

    stamped_but_unstarted = [
        t for t in tasks
        if t.completion_date is not None
        and (t.status or "").strip().lower() == "not started"
    ]
    if stamped_but_unstarted:
        notes.append(
            f"{len(stamped_but_unstarted)} task(s) carry a Completion Date while "
            f"still marked 'Not Started'. Status is treated as authoritative, so "
            f"these are excluded from completion and on-time figures."
        )

    missing_planned_end = [
        t for t in tasks if t.is_done and t.end_date is None
    ]
    if missing_planned_end:
        notes.append(
            f"{len(missing_planned_end)} completed task(s) have no planned end "
            f"date, so they cannot be judged on-time or late."
        )

    no_owner = [t for t in tasks if not t.owner]
    if no_owner and len(no_owner) == len(tasks) and tasks:
        notes.append(
            "No task on this board has an Owner assigned — per-person workload "
            "and throughput KPIs will stay empty until owners are set."
        )

    untagged = [t for t in tasks if not t.disciplines]
    if untagged:
        notes.append(
            f"{len(untagged)} task(s) have no Discipline tag and roll up under "
            f"'(untagged)' in the by-discipline breakdowns."
        )

    return notes


def compute_board_kpis(
    tasks: list[MondayTask],
    *,
    board_id: str,
    board_name: Optional[str] = None,
    today=None,
) -> BoardKpis:
    """Compute all three KPI families for one board's tasks."""
    if today is None:
        from datetime import date as _date

        today = _date.today()

    return BoardKpis(
        board_id=str(board_id),
        board_name=board_name,
        schedule=compute_schedule_kpis(tasks, today=today),
        qc=compute_qc_kpis(tasks),
        effort=compute_effort_kpis(tasks),
        data_quality=audit_data_quality(tasks),
    )
