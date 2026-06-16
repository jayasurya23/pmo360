"""Schedule calendar + duration math — pure, framework-free.

Faithful port of the date logic from the legacy Tkinter tool
(Full_proposal_V9.py): inclusive business-day counting (Mon-Fri, US federal
holidays excluded) with a configurable *disabled-holidays* set, Excel-vs-computed
duration resolution, and utilization-adjusted durations.

Kept identical to the desktop tool so generated schedules match exactly:
  - business_days_inclusive  -> Full_proposal_V9.py:191  (np.busday_count, same-day = 1)
  - sheet_duration           -> :135
  - duration_for_table       -> :149
  - adjusted_duration        -> ProposalGenerator.get_adjusted_duration :2409
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Any, Iterable, Mapping, Optional

import numpy as np
import holidays as _holidays_pkg

# Per-year cache of {date: holiday_name}. We keep names (not just dates) so a
# firm that works certain federal holidays can disable them by NAME — exactly
# what holidays_config.json's "disabled_holidays" did in the desktop tool.
_us_hol_year_cache: dict[int, dict] = {}


def _year_holidays(year: int) -> dict:
    if year not in _us_hol_year_cache:
        _us_hol_year_cache[year] = dict(_holidays_pkg.UnitedStates(years=year))
    return _us_hol_year_cache[year]


def us_holiday_array(
    start_year: int,
    end_year: int,
    disabled: Optional[Iterable[str]] = None,
) -> np.ndarray:
    """``datetime64[D]`` array of US federal holidays in [start_year, end_year],
    excluding any whose holiday NAME appears in ``disabled``."""
    disabled_set = {str(d).strip() for d in (disabled or ())}
    dates: list[date] = []
    for y in range(start_year, end_year + 1):
        for d, name in _year_holidays(y).items():
            if name in disabled_set:
                continue
            dates.append(d)
    dates.sort()
    return (
        np.array(dates, dtype="datetime64[D]")
        if dates
        else np.array([], dtype="datetime64[D]")
    )


def _as_date(v: Any) -> date:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return datetime.fromisoformat(str(v)[:19]).date()


def business_days_inclusive(
    start_dt: Any,
    end_dt: Any,
    disabled: Optional[Iterable[str]] = None,
) -> Optional[int]:
    """Inclusive business-day count (Mon-Fri), US federal holidays excluded.

    Same-day returns 1 (not 0). Returns None if either endpoint is missing.
    Mirrors the legacy tool exactly: np.busday_count over the half-open
    [d0, d1 + 1 day) interval so the end day is counted.
    """
    if not start_dt or not end_dt:
        return None
    d0 = _as_date(start_dt)
    d1 = _as_date(end_dt)
    if d1 < d0:
        d0, d1 = d1, d0
    hol = us_holiday_array(d0.year, d1.year, disabled)
    count = np.busday_count(
        np.datetime64(d0, "D"),
        np.datetime64(d1 + timedelta(days=1), "D"),
        holidays=hol,
    )
    return int(count)


def sheet_duration(row: Mapping[str, Any]) -> Optional[int]:
    """Excel-provided duration if present — first non-empty of the day/duration
    keys, coerced to int. Returns None when the sheet didn't specify one."""
    for k in ("days", "Days", "duration", "Duration", "Dur", "dur"):
        if k in row and row[k] not in (None, ""):
            try:
                return int(row[k])
            except Exception:
                try:
                    return int(float(row[k]))
                except Exception:
                    pass
    return None


def duration_for_table(
    row: Mapping[str, Any],
    disabled: Optional[Iterable[str]] = None,
) -> Optional[int]:
    """Source of truth for a row's Duration:
    1) Excel 'Days' verbatim (handles 1-day same-day tasks);
    2) explicit milestone -> 0;
    3) else inclusive business days between start/finish.
    """
    sd = sheet_duration(row)
    if sd is not None:
        return sd
    is_ms = bool(row.get("is_milestone")) or str(row.get("type", "")).lower() == "milestone"
    if is_ms:
        return 0
    return business_days_inclusive(row.get("start"), row.get("finish"), disabled)


def adjusted_duration(
    duration: int,
    *,
    is_milestone: bool,
    in_project_initiation: bool,
    name: str,
    task_utilization: Optional[float],
    project_utilization: float,
) -> int:
    """Utilization-adjusted duration for display/PDF: ``ceil(d / (util/100))``.

    Faithful to ProposalGenerator.get_adjusted_duration: milestones,
    Project-Initiation tasks, and Client-Review tasks are never adjusted; a
    per-task utilization overrides the project rate; and adjustment only applies
    when 0 < util < 100 (at 100% or invalid, the raw duration is returned).
    """
    if is_milestone or in_project_initiation:
        return duration
    if "client review" in (name or "").lower():
        return duration
    if task_utilization is not None:
        util_pct = float(task_utilization) if float(task_utilization) > 0 else 100.0
    else:
        util_pct = float(project_utilization)
    if util_pct <= 0 or util_pct >= 100.0:
        return duration
    return math.ceil(duration / (util_pct / 100.0))


def estimate_text_width_in_days(
    text: str,
    fontsize: float,
    chart_span_days: float,
    chart_width_inches: float,
) -> float:
    """Estimate a label's width in chart day-units (for Gantt label placement).
    Char width ~= 0.6 * fontsize points, +10% safety margin. Port of :210."""
    char_width_inches = (fontsize * 0.6) / 72.0
    text_width_inches = len(text) * char_width_inches
    days_per_inch = chart_span_days / chart_width_inches
    return text_width_inches * days_per_inch * 1.1
