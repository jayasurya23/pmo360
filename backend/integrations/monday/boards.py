"""GraphQL documents and paginated fetch helpers for monday.com boards.

Item pagination uses ``items_page`` + ``cursor``. The cursor is opaque and
expires (~60s idle), so pages must be pulled in one continuous pass rather
than persisted between requests.
"""
from __future__ import annotations

import logging
from typing import Iterator, Optional

from .client import MondayClient, MondayQueryError
from .columns import TASK_COLUMN_IDS, MondayTask, parse_task

logger = logging.getLogger(__name__)


# `column_values` is queried with an explicit id list — asking for every
# column on a ~50-column board multiplies complexity cost for data we drop.
_BOARD_ITEMS_QUERY = """
query BoardItems($boardId: ID!, $limit: Int!, $cursor: String, $columnIds: [String!]) {
  boards(ids: [$boardId]) {
    id
    name
    items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
        id
        name
        url
        group { id title }
        column_values(ids: $columnIds) {
          id
          text
          value
        }
      }
    }
  }
}
"""

_BOARD_META_QUERY = """
query BoardMeta($boardId: ID!) {
  boards(ids: [$boardId]) {
    id
    name
    description
    items_count
    workspace { id name }
  }
}
"""


def fetch_board_meta(client: MondayClient, board_id: str | int) -> dict:
    """Return id/name/items_count for one board.

    Used to validate a board id before pinning it to a portfolio, so a typo
    surfaces as "board not found" at link time rather than as an empty
    dashboard days later.
    """
    data = client.execute(_BOARD_META_QUERY, {"boardId": str(board_id)})
    boards = data.get("boards") or []
    if not boards:
        raise MondayQueryError(
            f"monday.com board {board_id} not found, or the token cannot read it."
        )
    return boards[0]


def iter_board_tasks(
    client: MondayClient,
    board_id: str | int,
    *,
    page_size: int = 100,
    max_pages: Optional[int] = None,
) -> Iterator[MondayTask]:
    """Yield every task on a board, following cursors until exhausted.

    ``max_pages`` bounds a runaway pull; when it truncates, that fact is
    logged at WARNING rather than passed off as a complete result.
    """
    board_id = str(board_id)
    cursor: Optional[str] = None
    pages = 0

    while True:
        data = client.execute(
            _BOARD_ITEMS_QUERY,
            {
                "boardId": board_id,
                "limit": page_size,
                "cursor": cursor,
                "columnIds": TASK_COLUMN_IDS,
            },
        )
        boards = data.get("boards") or []
        if not boards:
            raise MondayQueryError(
                f"monday.com board {board_id} not found, or the token cannot read it."
            )

        page = boards[0].get("items_page") or {}
        for item in page.get("items") or []:
            yield parse_task(item, board_id)

        cursor = page.get("cursor")
        pages += 1
        if not cursor:
            return
        if max_pages is not None and pages >= max_pages:
            logger.warning(
                "monday: stopped paging board %s after %d pages (max_pages); "
                "results are TRUNCATED and KPIs derived from them are partial.",
                board_id, pages,
            )
            return


def fetch_board_tasks(
    client: MondayClient,
    board_id: str | int,
    *,
    page_size: int = 100,
    max_pages: Optional[int] = None,
) -> list[MondayTask]:
    """Eager form of :func:`iter_board_tasks`."""
    return list(
        iter_board_tasks(client, board_id, page_size=page_size, max_pages=max_pages)
    )
