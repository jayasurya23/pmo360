"""Column mapping and value coercion for Castillo's monday.com project boards.

monday returns every column value as a **string**, and the strings are not
uniform. Values observed on the live Nesler board (18424062924) that break
naive parsing:

===========================  ====================================  ==============
Raw value                    Column                                Trap
===========================  ====================================  ==============
``"null"``                   Actual Duration (formula)             literal 4-char
                                                                   string, not None
``""``                       Total QC Cycle Time (formula)         empty ≠ zero
``"2.0"`` / ``"0.125"``      Duration (numbers)                    float-as-string,
                                                                   fractional days
``"2026-05-11 - 2026-05-08"``Timeline                              **end < start**
``"PMO, Civil, Electrical"`` Discipline (dropdown)                 multi-select
                                                                   joined by ", "
===========================  ====================================  ==============

``float("null")`` raises, ``float("")`` raises, and an inverted timeline
yields a negative duration that would quietly corrupt a schedule-variance
average. Every accessor here is total: it returns ``None`` for anything it
cannot read, and never raises on bad input. A KPI that cannot be computed
must be absent, not silently zero — zero is a claim about the project,
``None`` is a claim about the data.

Column IDs are hard-coded because they are stable per board template and the
workspace has duplicate board *names*. If Castillo revises the template, only
this module changes.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------- column ids
# Task-level columns on a project schedule board (Nesler / Template 5.0).
class TaskColumns:
    STATUS = "project_status"
    OWNER = "project_owner"
    DISCIPLINE = "dropdown_mm4jygv4"        # multi-select
    PHASE = "color_mm4j79qe"                # Due Diligence / 10% / 30% / …
    ROLE = "dropdown_mm4kq562"

    TIMELINE = "project_timeline"           # "YYYY-MM-DD - YYYY-MM-DD"
    START_DATE = "date_mm4kzjjk"
    COMPLETION_DATE = "project_task_completion_date"   # automation-stamped

    PLANNED_DURATION_DAYS = "project_duration"
    ACTUAL_DURATION_DAYS = "formula_mm4k8230"          # DAYS(completion, start)
    SCHEDULE_VARIANCE_DAYS = "formula_mm4k4zg5"        # planned - actual

    PLANNED_HOURS = "project_planned_effort"           # "Targeted Hours"
    ACTUAL_HOURS = "formula_mm4kqacx"
    HOURS_VARIANCE = "formula_mm4kysj8"                # planned - actual

    PAY_RATE = "numeric_mm4jjwdh"
    BILLABLE_COST = "formula_mm4kf7zp"
    ACTUAL_COST = "formula_mm4k6jkt"
    BUDGET = "project_budget"

    QC_STATUS = "color_mm522b42"
    QC_READY_DATE = "date_mm53dfe4"
    QC_COMPLETE_DATE = "date_mm53twpc"
    QC_CYCLE_DAYS = "formula_mm536xnp"                 # board-declared "Primary KPI"
    QC_REVIEWER = "multiple_person_mm537jw6"

    DD_STATUS = "color_mm4jz948"
    DEPENDENCY_DUE_DATE = "date_mm4knhb7"


#: Every column we pull. Passed as ``columnIds`` so monday returns a narrow
#: payload — the full board is ~50 columns and wastes complexity budget.
TASK_COLUMN_IDS: list[str] = [
    getattr(TaskColumns, name)
    for name in vars(TaskColumns)
    if not name.startswith("_")
]

#: Status labels that mean "this task is finished". Anything else counts as
#: outstanding. ``N/A`` is deliberately excluded from both numerator and
#: denominator by :func:`is_countable` — it is a not-applicable marker, and
#: counting it as incomplete would drag completion rates down permanently.
DONE_STATUSES = {"completed"}
NOT_APPLICABLE_STATUSES = {"n/a", "na"}


# ---------------------------------------------------------------- coercion
#: Sentinels monday emits for "no value". ``"null"`` is a real 4-character
#: string returned by formula columns whose inputs are blank.
#:
#: Deliberately excludes ``"n/a"``: on a *status* column ``N/A`` is a real
#: label meaning "out of scope for this project", not a missing value. Nulling
#: it would hide those tasks from :data:`NOT_APPLICABLE_STATUSES` and sweep
#: them back into completion denominators, understating the completion rate.
#: Numeric and date parsing reject ``"n/a"`` on their own, so it costs nothing
#: to keep here.
_NULLISH = {"", "null", "none"}


def _clean(raw: Any) -> Optional[str]:
    if raw is None:
        return None
    text = str(raw).strip()
    if text.lower() in _NULLISH:
        return None
    return text


def coerce_float(raw: Any) -> Optional[float]:
    """Parse a monday numeric/formula value. ``None`` when unreadable.

    Handles ``"null"``, ``""``, thousands separators and currency prefixes —
    all of which appear in formula output.
    """
    text = _clean(raw)
    if text is None:
        return None
    text = text.replace(",", "").replace("$", "").strip()
    try:
        value = float(text)
    except (TypeError, ValueError):
        logger.debug("monday: unparseable numeric %r", raw)
        return None
    # NaN/inf would poison any average it touches.
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def coerce_int(raw: Any) -> Optional[int]:
    value = coerce_float(raw)
    return None if value is None else int(value)


def coerce_date(raw: Any) -> Optional[date]:
    """Parse a monday date value (``YYYY-MM-DD``, optionally with a time)."""
    text = _clean(raw)
    if text is None:
        return None
    text = text.split("T")[0].strip()
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        logger.debug("monday: unparseable date %r", raw)
        return None


def coerce_labels(raw: Any) -> list[str]:
    """Split a multi-select dropdown (``"PMO, Civil, Electrical"``)."""
    text = _clean(raw)
    if text is None:
        return []
    return [part.strip() for part in text.split(",") if part.strip()]


def coerce_timeline(raw: Any) -> tuple[Optional[date], Optional[date]]:
    """Parse a timeline range into ``(start, end)``.

    Returns ``(None, None)`` when the range is inverted (end before start).
    The live board contains such rows — e.g. ``"2026-05-11 - 2026-05-08"`` —
    and treating them as valid produces negative durations that skew any
    average they land in. Dropping them is the honest reading: the range is
    not usable, so it should not vote.
    """
    text = _clean(raw)
    if text is None:
        return None, None
    parts = [p.strip() for p in text.split(" - ") if p.strip()]
    if len(parts) != 2:
        # A single date is a degenerate but readable range.
        single = coerce_date(text)
        return (single, single) if single else (None, None)

    start, end = coerce_date(parts[0]), coerce_date(parts[1])
    if start and end and end < start:
        logger.debug("monday: inverted timeline %r — discarding", raw)
        return None, None
    return start, end


# ---------------------------------------------------------------- task model
@dataclass
class MondayTask:
    """One monday board item, normalized.

    Every metric field is ``Optional`` — see the module docstring on why an
    absent value must not collapse to zero.
    """

    item_id: str
    name: str
    board_id: str
    group_title: Optional[str] = None
    url: Optional[str] = None

    status: Optional[str] = None
    phase: Optional[str] = None
    disciplines: list[str] = field(default_factory=list)
    owner: Optional[str] = None

    start_date: Optional[date] = None
    end_date: Optional[date] = None
    completion_date: Optional[date] = None

    planned_duration_days: Optional[float] = None
    actual_duration_days: Optional[float] = None
    schedule_variance_days: Optional[float] = None

    planned_hours: Optional[float] = None
    actual_hours: Optional[float] = None
    hours_variance: Optional[float] = None

    billable_cost: Optional[float] = None
    actual_cost: Optional[float] = None

    qc_status: Optional[str] = None
    qc_ready_date: Optional[date] = None
    qc_complete_date: Optional[date] = None
    qc_cycle_days: Optional[float] = None

    # -- derived ---------------------------------------------------------
    @property
    def is_done(self) -> bool:
        """Whether the task counts as complete.

        Status is authoritative, **not** the completion date. The live board
        has rows stamped with a ``Completion Date`` while still sitting at
        ``Not Started`` (a side effect of the bulk import), so trusting the
        date alone would report unstarted work as delivered.
        """
        return (self.status or "").strip().lower() in DONE_STATUSES

    @property
    def is_countable(self) -> bool:
        """False for ``N/A`` tasks, which belong in no completion ratio."""
        return (self.status or "").strip().lower() not in NOT_APPLICABLE_STATUSES

    @property
    def has_trustworthy_completion(self) -> bool:
        """True when status and completion date agree.

        Used to gate on-time-delivery maths so imported contradictions don't
        enter the numerator.
        """
        return self.is_done and self.completion_date is not None

    @property
    def finished_on_time(self) -> Optional[bool]:
        """Did it land on or before its planned end? ``None`` if unknowable."""
        if not self.has_trustworthy_completion or self.end_date is None:
            return None
        return self.completion_date <= self.end_date


def parse_task(item: dict, board_id: str) -> MondayTask:
    """Build a :class:`MondayTask` from one raw monday item payload.

    Accepts both response shapes: ``column_values`` as the dict the MCP tools
    return, and as the ``[{id, text, value}]`` list the raw GraphQL API
    returns.
    """
    raw_columns = item.get("column_values") or {}
    if isinstance(raw_columns, list):
        columns = {
            entry.get("id"): entry.get("text")
            for entry in raw_columns
            if isinstance(entry, dict)
        }
    else:
        columns = dict(raw_columns)

    def col(column_id: str) -> Any:
        return columns.get(column_id)

    start, end = coerce_timeline(col(TaskColumns.TIMELINE))
    # The explicit Start Date column wins when present — the timeline may have
    # been discarded as inverted.
    explicit_start = coerce_date(col(TaskColumns.START_DATE))
    if explicit_start:
        start = explicit_start

    group = item.get("group") or {}

    return MondayTask(
        item_id=str(item.get("id", "")),
        name=item.get("name") or "(unnamed task)",
        board_id=str(board_id),
        group_title=group.get("title") if isinstance(group, dict) else None,
        url=item.get("url"),
        status=_clean(col(TaskColumns.STATUS)),
        phase=_clean(col(TaskColumns.PHASE)),
        disciplines=coerce_labels(col(TaskColumns.DISCIPLINE)),
        owner=_clean(col(TaskColumns.OWNER)),
        start_date=start,
        end_date=end,
        completion_date=coerce_date(col(TaskColumns.COMPLETION_DATE)),
        planned_duration_days=coerce_float(col(TaskColumns.PLANNED_DURATION_DAYS)),
        actual_duration_days=coerce_float(col(TaskColumns.ACTUAL_DURATION_DAYS)),
        schedule_variance_days=coerce_float(col(TaskColumns.SCHEDULE_VARIANCE_DAYS)),
        planned_hours=coerce_float(col(TaskColumns.PLANNED_HOURS)),
        actual_hours=coerce_float(col(TaskColumns.ACTUAL_HOURS)),
        hours_variance=coerce_float(col(TaskColumns.HOURS_VARIANCE)),
        billable_cost=coerce_float(col(TaskColumns.BILLABLE_COST)),
        actual_cost=coerce_float(col(TaskColumns.ACTUAL_COST)),
        qc_status=_clean(col(TaskColumns.QC_STATUS)),
        qc_ready_date=coerce_date(col(TaskColumns.QC_READY_DATE)),
        qc_complete_date=coerce_date(col(TaskColumns.QC_COMPLETE_DATE)),
        qc_cycle_days=coerce_float(col(TaskColumns.QC_CYCLE_DAYS)),
    )
