"""Sync monday.com boards into the local cache, and read KPIs back out.

Implements the hybrid strategy:

* **Cached** — KPI rollups and trend series read ``monday_task_snapshots``,
  so a dashboard load costs one Postgres query instead of ~5 monday API calls
  and a chunk of complexity budget.
* **Live** — single-board drill-in can bypass the cache with
  :func:`fetch_live_tasks` when someone needs "what does it say *right now*".

Each sync also writes one :class:`MondayKpiSnapshot` row. That is the only
durable record of what the board looked like on a given day — monday keeps no
history of its formula columns, so a value not stamped at sync time cannot be
recovered later.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from config import monday_config, monday_is_configured
from db.models import MondayBoardLink, MondayKpiSnapshot, MondayTaskSnapshot

from .boards import fetch_board_meta, fetch_board_tasks
from .client import MondayClient, MondayError, get_monday_client
from .columns import MondayTask
from .kpis import BoardKpis, compute_board_kpis

logger = logging.getLogger(__name__)


class MondayNotConfigured(RuntimeError):
    """Raised when a monday operation is attempted with no token set."""


def _require_client(client: Optional[MondayClient]) -> MondayClient:
    if client is not None:
        return client
    if not monday_is_configured():
        raise MondayNotConfigured(
            "monday.com is not configured. Set MONDAY_API_TOKEN to enable it."
        )
    return get_monday_client()


# ---------------------------------------------------------------- snapshot IO
def _snapshot_to_task(row: MondayTaskSnapshot, board_id: str) -> MondayTask:
    """Rehydrate a cached row into the same dataclass the live path yields,
    so KPI code has exactly one input type."""
    return MondayTask(
        item_id=row.monday_item_id,
        name=row.name or "(unnamed task)",
        board_id=board_id,
        group_title=row.group_title,
        url=row.url,
        status=row.status,
        phase=row.phase,
        disciplines=list(row.disciplines_json or []),
        owner=row.owner,
        start_date=row.start_date,
        end_date=row.end_date,
        completion_date=row.completion_date,
        planned_duration_days=row.planned_duration_days,
        actual_duration_days=row.actual_duration_days,
        schedule_variance_days=row.schedule_variance_days,
        planned_hours=row.planned_hours,
        actual_hours=row.actual_hours,
        hours_variance=row.hours_variance,
        billable_cost=row.billable_cost,
        actual_cost=row.actual_cost,
        qc_status=row.qc_status,
        qc_ready_date=row.qc_ready_date,
        qc_complete_date=row.qc_complete_date,
        qc_cycle_days=row.qc_cycle_days,
    )


def _task_to_snapshot(
    task: MondayTask, link_id: int, synced_at: datetime
) -> MondayTaskSnapshot:
    return MondayTaskSnapshot(
        board_link_id=link_id,
        monday_item_id=task.item_id,
        name=task.name[:500] if task.name else None,
        url=task.url[:500] if task.url else None,
        group_title=task.group_title,
        status=task.status,
        phase=task.phase,
        disciplines_json=list(task.disciplines or []),
        owner=task.owner,
        start_date=task.start_date,
        end_date=task.end_date,
        completion_date=task.completion_date,
        planned_duration_days=task.planned_duration_days,
        actual_duration_days=task.actual_duration_days,
        schedule_variance_days=task.schedule_variance_days,
        planned_hours=task.planned_hours,
        actual_hours=task.actual_hours,
        hours_variance=task.hours_variance,
        billable_cost=task.billable_cost,
        actual_cost=task.actual_cost,
        qc_status=task.qc_status,
        qc_ready_date=task.qc_ready_date,
        qc_complete_date=task.qc_complete_date,
        qc_cycle_days=task.qc_cycle_days,
        synced_at=synced_at,
    )


def _write_kpi_snapshot(
    db: Session, link: MondayBoardLink, kpis: BoardKpis, when: date
) -> None:
    """Upsert today's trend row. Re-syncing the same day overwrites it."""
    existing = (
        db.query(MondayKpiSnapshot)
        .filter_by(board_link_id=link.id, snapshot_date=when)
        .one_or_none()
    )
    row = existing or MondayKpiSnapshot(board_link_id=link.id, snapshot_date=when)

    row.total_tasks = kpis.schedule.total_tasks
    row.completed_tasks = kpis.schedule.completed_tasks
    row.in_progress_tasks = kpis.schedule.in_progress_tasks
    row.blocked_tasks = kpis.schedule.blocked_tasks
    row.overdue_tasks = kpis.schedule.overdue_tasks
    row.completion_rate = kpis.schedule.completion_rate.value
    row.on_time_rate = kpis.schedule.on_time_rate.value
    row.avg_schedule_variance_days = kpis.schedule.avg_schedule_variance_days.value
    row.avg_qc_cycle_days = kpis.qc.avg_cycle_days.value
    row.planned_hours_total = kpis.effort.planned_hours_total.value
    row.actual_hours_total = kpis.effort.actual_hours_total.value
    row.payload_json = kpis.as_dict()

    if existing is None:
        db.add(row)


# ---------------------------------------------------------------- public API
def sync_board(
    db: Session,
    link: MondayBoardLink,
    *,
    client: Optional[MondayClient] = None,
) -> BoardKpis:
    """Pull a board, replace its cached tasks, and stamp a KPI trend row.

    Sync failures are recorded on the link (``last_sync_error``) and re-raised
    — a stale dashboard that looks fresh is worse than a visible error.
    """
    client = _require_client(client)
    cfg = monday_config()
    now = datetime.utcnow()

    try:
        meta = fetch_board_meta(client, link.board_id)
        tasks = fetch_board_tasks(
            client, link.board_id, page_size=cfg["page_size"]
        )
    except MondayError as exc:
        link.last_sync_error = str(exc)[:2000]
        link.updated_at = now
        db.flush()
        logger.exception("monday: sync failed for board %s", link.board_id)
        raise

    # Replace the mirror wholesale: a task deleted in monday must disappear
    # here too, which a row-by-row upsert would not achieve.
    #
    # synchronize_session="fetch" (not False) so the session's identity map
    # drops the deleted rows. With False, previously-loaded snapshots linger
    # and the replacements collide with them on flush — SQLAlchemy warns and
    # silently swaps identities, which makes a second sync in one request
    # operate on a mix of live and stale objects.
    db.query(MondayTaskSnapshot).filter_by(board_link_id=link.id).delete(
        synchronize_session="fetch"
    )
    db.flush()

    for task in tasks:
        db.add(_task_to_snapshot(task, link.id, now))

    kpis = compute_board_kpis(
        tasks, board_id=str(link.board_id), board_name=meta.get("name"),
    )

    link.board_name = meta.get("name") or link.board_name
    link.last_synced_at = now
    link.last_sync_error = None
    link.last_sync_task_count = len(tasks)
    link.updated_at = now

    _write_kpi_snapshot(db, link, kpis, now.date())
    db.flush()

    logger.info(
        "monday: synced board %s (%s) — %d tasks",
        link.board_id, link.board_name, len(tasks),
    )
    return kpis


def cached_tasks(db: Session, link: MondayBoardLink) -> list[MondayTask]:
    rows = (
        db.query(MondayTaskSnapshot)
        .filter_by(board_link_id=link.id)
        .order_by(MondayTaskSnapshot.id)
        .all()
    )
    return [_snapshot_to_task(r, str(link.board_id)) for r in rows]


def is_cache_stale(link: MondayBoardLink) -> bool:
    if link.last_synced_at is None:
        return True
    ttl = timedelta(minutes=monday_config()["cache_ttl_minutes"])
    return (datetime.utcnow() - link.last_synced_at) > ttl


def get_board_kpis(
    db: Session,
    link: MondayBoardLink,
    *,
    force_refresh: bool = False,
    client: Optional[MondayClient] = None,
) -> BoardKpis:
    """KPIs for one board, from cache unless stale or explicitly refreshed.

    When a refresh fails but a cache exists, the cached numbers are returned
    with the failure noted in ``data_quality`` — a dashboard that still shows
    yesterday's figures and says so beats one that shows an error page.
    """
    should_refresh = force_refresh or is_cache_stale(link)

    if should_refresh:
        try:
            return sync_board(db, link, client=client)
        except (MondayError, MondayNotConfigured) as exc:
            if link.last_synced_at is None:
                raise
            logger.warning(
                "monday: refresh failed for board %s, serving cache: %s",
                link.board_id, exc,
            )
            kpis = _kpis_from_cache(db, link)
            kpis.data_quality.insert(
                0,
                f"Live refresh failed ({exc}). Showing cached data from "
                f"{link.last_synced_at:%Y-%m-%d %H:%M} UTC.",
            )
            return kpis

    return _kpis_from_cache(db, link)


def _kpis_from_cache(db: Session, link: MondayBoardLink) -> BoardKpis:
    tasks = cached_tasks(db, link)
    return compute_board_kpis(
        tasks, board_id=str(link.board_id), board_name=link.board_name,
    )


def fetch_live_tasks(
    link: MondayBoardLink, *, client: Optional[MondayClient] = None
) -> list[MondayTask]:
    """Bypass the cache entirely — the drill-in half of the hybrid strategy."""
    client = _require_client(client)
    return fetch_board_tasks(
        client, link.board_id, page_size=monday_config()["page_size"]
    )


def validate_board(
    board_id: str, *, client: Optional[MondayClient] = None
) -> dict:
    """Confirm a board id is readable before it gets pinned to a portfolio."""
    client = _require_client(client)
    return fetch_board_meta(client, board_id)


def kpi_trend(
    db: Session, link: MondayBoardLink, *, days: int = 90
) -> list[MondayKpiSnapshot]:
    """Historical KPI snapshots, oldest first."""
    cutoff = date.today() - timedelta(days=days)
    return (
        db.query(MondayKpiSnapshot)
        .filter(
            MondayKpiSnapshot.board_link_id == link.id,
            MondayKpiSnapshot.snapshot_date >= cutoff,
        )
        .order_by(MondayKpiSnapshot.snapshot_date)
        .all()
    )
