"""monday.com integration — read-only.

PMO 360 pulls task status, schedule variance, QC cycle time and effort/cost
figures out of Castillo's PMO workspace. It never writes to monday: the boards
are the team's working surface, and a sync bug should not be able to damage
them.

Layering, outermost first::

    api/monday.py     HTTP routes
    sync.py           cache + trend persistence  (hybrid strategy)
    kpis.py           pure computation over MondayTask
    boards.py         GraphQL documents + pagination
    columns.py        column ids + defensive value coercion
    client.py         HTTP transport, auth, retry

Only ``client.py`` touches the network, and its transport is injectable, so
everything above it is testable offline — see ``scripts/monday_selftest.py``.
"""
from .client import (
    MondayAuthError,
    MondayClient,
    MondayError,
    MondayQueryError,
    MondayRateLimitError,
    get_monday_client,
)
from .columns import MondayTask, TaskColumns, parse_task
from .kpis import BoardKpis, Measure, compute_board_kpis
from .sync import (
    MondayNotConfigured,
    cached_tasks,
    fetch_live_tasks,
    get_board_kpis,
    kpi_trend,
    sync_board,
    validate_board,
)

__all__ = [
    "MondayAuthError",
    "MondayClient",
    "MondayError",
    "MondayQueryError",
    "MondayRateLimitError",
    "MondayNotConfigured",
    "MondayTask",
    "TaskColumns",
    "BoardKpis",
    "Measure",
    "get_monday_client",
    "parse_task",
    "compute_board_kpis",
    "sync_board",
    "get_board_kpis",
    "cached_tasks",
    "fetch_live_tasks",
    "validate_board",
    "kpi_trend",
]
