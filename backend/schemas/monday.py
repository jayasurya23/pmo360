"""Pydantic shapes for the monday.com integration endpoints."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- board links ----------
class MondayBoardLinkCreate(BaseModel):
    """Pin a monday board to a portfolio.

    ``board_id`` is a string because monday ids exceed 32-bit; taking it as an
    int risks precision loss in JSON on the way in.
    """
    board_id: str = Field(..., min_length=1, max_length=50)
    kind: Literal["schedule", "portfolio"] = "schedule"

    @field_validator("board_id")
    @classmethod
    def _numeric_id(cls, v: str) -> str:
        cleaned = v.strip()
        if not cleaned.isdigit():
            raise ValueError(
                "board_id must be the numeric id from the board URL "
                "(https://<account>.monday.com/boards/<board_id>)"
            )
        return cleaned


class MondayBoardLinkUpdate(BaseModel):
    is_active: Optional[bool] = None
    kind: Optional[Literal["schedule", "portfolio"]] = None


class MondayBoardLinkOut(ORMModel):
    id: int
    project_id: int
    board_id: str
    board_name: Optional[str] = None
    kind: str
    is_active: bool
    last_synced_at: Optional[datetime] = None
    last_sync_error: Optional[str] = None
    last_sync_task_count: Optional[int] = None


# ---------- KPI payloads ----------
class MeasureOut(BaseModel):
    """One KPI number with its coverage.

    ``value is None`` means "not computable from current data" — distinct from
    ``0.0``. The UI must render the two differently: "no data yet" vs "zero".
    """
    value: Optional[float] = None
    sample_size: int = 0
    population: int = 0
    coverage: Optional[float] = None
    unit: str = ""
    low_confidence: bool = False


class ScheduleKpisOut(BaseModel):
    total_tasks: int
    countable_tasks: int
    completed_tasks: int
    not_started_tasks: int
    in_progress_tasks: int
    blocked_tasks: int
    overdue_tasks: int
    completion_rate: MeasureOut
    on_time_rate: MeasureOut
    avg_schedule_variance_days: MeasureOut
    by_phase: dict[str, Any] = Field(default_factory=dict)
    by_discipline: dict[str, Any] = Field(default_factory=dict)


class QcKpisOut(BaseModel):
    tasks_in_qc: int
    tasks_qc_complete: int
    awaiting_qc: int
    avg_cycle_days: MeasureOut
    median_cycle_days: MeasureOut


class EffortKpisOut(BaseModel):
    planned_hours_total: MeasureOut
    actual_hours_total: MeasureOut
    hours_variance_total: MeasureOut
    billable_cost_total: MeasureOut
    actual_cost_total: MeasureOut
    cost_ratio: Optional[float] = None
    by_discipline: dict[str, Any] = Field(default_factory=dict)


class BoardKpisOut(BaseModel):
    board_id: str
    board_name: Optional[str] = None
    #: False when the board is populated but no work has been logged — lets the
    #: UI say "tracking hasn't started" instead of showing a wall of zeros.
    has_execution_data: bool
    schedule: ScheduleKpisOut
    qc: QcKpisOut
    effort: EffortKpisOut
    data_quality: list[str] = Field(default_factory=list)


class PortfolioKpisOut(BaseModel):
    project_id: int
    configured: bool          # is MONDAY_API_TOKEN set at all
    linked: bool              # does this portfolio have an active board
    last_synced_at: Optional[datetime] = None
    boards: list[BoardKpisOut] = Field(default_factory=list)
    #: Set when the integration is off or unlinked, so the frontend can show a
    #: specific call to action rather than a generic empty state.
    message: Optional[str] = None


class KpiTrendPoint(BaseModel):
    snapshot_date: date
    total_tasks: Optional[int] = None
    completed_tasks: Optional[int] = None
    in_progress_tasks: Optional[int] = None
    blocked_tasks: Optional[int] = None
    overdue_tasks: Optional[int] = None
    completion_rate: Optional[float] = None
    on_time_rate: Optional[float] = None
    avg_schedule_variance_days: Optional[float] = None
    avg_qc_cycle_days: Optional[float] = None
    planned_hours_total: Optional[float] = None
    actual_hours_total: Optional[float] = None


class KpiTrendOut(BaseModel):
    board_link_id: int
    board_id: str
    board_name: Optional[str] = None
    points: list[KpiTrendPoint] = Field(default_factory=list)


class MondayTaskOut(BaseModel):
    """A single task, for live drill-in."""
    item_id: str
    name: str
    url: Optional[str] = None
    group_title: Optional[str] = None
    status: Optional[str] = None
    phase: Optional[str] = None
    disciplines: list[str] = Field(default_factory=list)
    owner: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    completion_date: Optional[date] = None
    schedule_variance_days: Optional[float] = None
    planned_hours: Optional[float] = None
    actual_hours: Optional[float] = None
    qc_status: Optional[str] = None
    qc_cycle_days: Optional[float] = None


class MondaySyncResultOut(BaseModel):
    board_link_id: int
    board_id: str
    board_name: Optional[str] = None
    task_count: int
    synced_at: Optional[datetime] = None
    kpis: BoardKpisOut


class MondayBoardValidateOut(BaseModel):
    """Result of checking a board id before pinning it."""
    board_id: str
    name: Optional[str] = None
    items_count: Optional[int] = None
    workspace_name: Optional[str] = None
