"""monday.com read client.

RFIs are the first thing pulled through here, not the last. The team is moving
off Smartsheets onto Monday, which will progressively become the source of
record for more of what this app displays — task progress, timelines and cost
KPIs are expected next. New readers belong in this module, joined to our
projects through Project.monday_item_id / PortfolioProject.monday_item_id.

READ ONLY, on purpose, and worth keeping that way: a bug in this file can never
corrupt the board an entire team works from. If writing back is ever needed, it
should be a separate module with its own review, not an extra function here.

Everything degrades to "not configured" rather than raising at import: the app
must keep serving meetings, actions and change orders when the token is absent
or Monday is unreachable. An integration is not allowed to take the product
down with it.

Board and column ids are pinned as constants because Monday addresses columns
by opaque id (``text_mm1gmmry``), not by the title a person sees. Titles are
renameable and ids are not, so the ids are the stable contract — but they are
unreadable, hence the human title in a comment on every one.
"""
import logging
import os
from datetime import date, datetime
from typing import Any, Optional

import requests

logger = logging.getLogger(__name__)

API_URL = "https://api.monday.com/v2"
# Monday requires an explicit API version. Without one they choose for you, and
# the response shape can change under the app without a deploy.
API_VERSION = "2024-10"
TIMEOUT = 20

# ---- Portfolio board: one item per project -------------------------------
PORTFOLIO_BOARD_ID = 18403099969
COL_PROJECT_CODE = "text_mm1gmmry"              # "Project ID"   e.g. 2512-057
COL_CLIENT_NAME = "text_mm631t83"               # "Client Name"
COL_PROJECT_SITE = "text_mm637szg"              # "Project Site"
COL_CONTRACT_STATUS = "portfolio_project_step"  # "Contract Status"

_PORTFOLIO_COLS = [
    COL_PROJECT_CODE, COL_CLIENT_NAME, COL_PROJECT_SITE, COL_CONTRACT_STATUS,
]

# ---- RFI board -----------------------------------------------------------
RFI_BOARD_ID = 18403108095
RFI_COL_PROJECTS = "board_relation_mm1gw01v"   # "Client Projects" -> Portfolio board
RFI_COL_STATUS = "status"                      # Assigned / In Progress / In Review / ...
RFI_COL_OWNER = "color_mm2e75r"                # "RFI Response Owner"  (INTERNAL)
RFI_COL_DISCIPLINE = "dropdown_mm1gp0cp"       # Civil / Electrical / Structural
RFI_COL_EQUIPMENT = "dropdown_mm1gqp7r"        # "Equipment Type"
RFI_COL_QUESTION = "long_text_mm1g5erm"        # "Request / Question"
RFI_COL_DESCRIPTION = "long_text_mm1gmbz0"     # "RFI Overview & Description" (the real content)
RFI_COL_ITEM = "text_mm1g1shd"                 # "Item/Equipment - Castillo Needs"
RFI_COL_CONTEXT = "long_text_mm2p3msw"         # "Context (if needed)"
RFI_COL_ASSIGNED = "person"                    # "Assigned To"
RFI_COL_SUBMITTED = "date4"                    # "Date Submitted"
RFI_COL_NEEDED_BY = "date_mm1gv957"            # "Response Needed By:"
RFI_COL_COMPLETED = "date_mm1ggkth"            # "Date of Completion"


class MondayNotConfigured(RuntimeError):
    """No API token configured."""


def is_configured() -> bool:
    return bool((os.getenv("MONDAY_API_TOKEN") or "").strip())


def _post(query: str, variables: Optional[dict] = None) -> dict:
    token = (os.getenv("MONDAY_API_TOKEN") or "").strip()
    if not token:
        raise MondayNotConfigured(
            "MONDAY_API_TOKEN is not set, so RFIs cannot be pulled from monday.com."
        )
    resp = requests.post(
        API_URL,
        json={"query": query, "variables": variables or {}},
        headers={
            "Authorization": token,
            "Content-Type": "application/json",
            "API-Version": API_VERSION,
        },
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    body = resp.json()
    # Monday answers HTTP 200 with an `errors` array for query problems, so a
    # bare raise_for_status would let a failed read look like an empty board.
    if body.get("errors"):
        raise RuntimeError("monday.com API error: {}".format(body["errors"]))
    return body.get("data") or {}


def _col_map(item: dict) -> dict[str, Any]:
    return {c["id"]: c for c in (item.get("column_values") or [])}


def _text(cols: dict, col_id: str) -> Optional[str]:
    value = (cols.get(col_id) or {}).get("text")
    value = (value or "").strip()
    return value or None


def _date(cols: dict, col_id: str) -> Optional[date]:
    raw = _text(cols, col_id)
    if not raw:
        return None
    try:
        return datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except ValueError:
        # One malformed date must not cost the caller the whole RFI.
        logger.warning("monday: unparseable date %r in column %s", raw, col_id)
        return None


def _portfolio_query() -> str:
    ids = ", ".join('"{}"'.format(c) for c in _PORTFOLIO_COLS)
    return (
        "query Portfolio($board: [ID!], $limit: Int!) {"
        "  boards(ids: $board) {"
        "    items_page(limit: $limit) {"
        "      cursor"
        "      items { id name column_values(ids: [" + ids + "]) { id text } }"
        "    }"
        "  }"
        "}"
    )


def list_projects() -> list[dict]:
    """Every project on Monday's Portfolio board, for the mapping screen."""
    data = _post(_portfolio_query(), {"board": [str(PORTFOLIO_BOARD_ID)], "limit": 200})
    boards = data.get("boards") or []
    if not boards:
        return []
    out = []
    for item in boards[0]["items_page"]["items"]:
        cols = _col_map(item)
        out.append({
            "monday_item_id": int(item["id"]),
            "name": item.get("name") or "",
            "project_code": _text(cols, COL_PROJECT_CODE),
            "client_name": _text(cols, COL_CLIENT_NAME),
            "project_site": _text(cols, COL_PROJECT_SITE),
            "contract_status": _text(cols, COL_CONTRACT_STATUS),
        })
    return out


_RFI_QUERY = """
query Rfis($board: [ID!], $limit: Int!, $cursor: String) {
  boards(ids: $board) {
    items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
        id
        name
        column_values {
          id
          text
          ... on BoardRelationValue { linked_item_ids }
        }
      }
    }
  }
}
"""


def list_rfis() -> list[dict]:
    """Every RFI on the board, with the Monday project ids each is linked to.

    The whole board is fetched and filtered by the caller rather than filtered
    server-side: it is ~50 items, one round trip beats a query per project, and
    an RFI linked to several projects has to appear under each of them.
    """
    out: list[dict] = []
    cursor = None
    while True:
        data = _post(_RFI_QUERY, {
            "board": [str(RFI_BOARD_ID)], "limit": 200, "cursor": cursor,
        })
        boards = data.get("boards") or []
        if not boards:
            break
        page = boards[0]["items_page"]
        for item in page["items"]:
            cols = _col_map(item)
            rel = cols.get(RFI_COL_PROJECTS) or {}
            linked = [int(x) for x in (rel.get("linked_item_ids") or [])]
            out.append({
                "monday_item_id": int(item["id"]),
                "name": item.get("name") or "",
                "linked_project_ids": linked,
                # description carries the text in practice; question is blank
                # on every RFI on the board today, so nothing may rely on it.
                "item_equipment": _text(cols, RFI_COL_ITEM),
                "description": _text(cols, RFI_COL_DESCRIPTION),
                "question": _text(cols, RFI_COL_QUESTION),
                "context": _text(cols, RFI_COL_CONTEXT),
                "status": _text(cols, RFI_COL_STATUS),
                "response_owner": _text(cols, RFI_COL_OWNER),
                "discipline": _text(cols, RFI_COL_DISCIPLINE),
                "equipment_type": _text(cols, RFI_COL_EQUIPMENT),
                "assigned_to": _text(cols, RFI_COL_ASSIGNED),
                "date_submitted": _date(cols, RFI_COL_SUBMITTED),
                "response_needed_by": _date(cols, RFI_COL_NEEDED_BY),
                "date_completed": _date(cols, RFI_COL_COMPLETED),
            })
        cursor = page.get("cursor")
        if not cursor:
            break
    return out


# ---- generic board reader -------------------------------------------------
# The two readers above are shaped for specific boards. This one is not: it
# takes a board and a list of column ids and hands back raw cell text, which is
# what a screen that lets somebody choose a board needs. It stays here rather
# than in the write module because it is a read, and the module docstring is
# explicit that new readers belong in this file.

_GENERIC_QUERY = """
query ($board: [ID!], $cols: [String!], $limit: Int!, $cursor: String) {
  boards(ids: $board) {
    id
    name
    items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
        id
        name
        url
        column_values(ids: $cols) {
          id
          text
          ... on BoardRelationValue { linked_item_ids display_value }
          ... on MirrorValue { display_value }
          ... on FormulaValue { display_value }
        }
      }
    }
  }
}
"""


def read_board_items(
    board_id: int,
    column_ids: list[str],
    limit: int = 200,
) -> dict[str, Any]:
    """Read one board's items, returning ``{"board": name, "items": [...]}``.

    Each item is ``{"id", "name", "url", "cells": {column_id: value}}``. A cell
    is the column's ``text`` where it has one; for mirrors and formulas that is
    always ``None``, so ``display_value`` is used instead — the single most
    common way to conclude a mirror is unreadable when it is not. Board
    relations come back as a list of linked item ids.
    """
    out: list[dict[str, Any]] = []
    board_name = ""
    cursor: Optional[str] = None

    while True:
        data = _post(_GENERIC_QUERY, {
            "board": [str(board_id)],
            "cols": column_ids,
            "limit": min(limit, 100),
            "cursor": cursor,
        })
        boards = data.get("boards") or []
        if not boards:
            break
        board_name = boards[0].get("name") or ""
        page = boards[0].get("items_page") or {}

        for item in page.get("items") or []:
            cells: dict[str, Any] = {}
            for c in item.get("column_values") or []:
                cid = c.get("id")
                if "linked_item_ids" in c:
                    cells[cid] = [int(i) for i in (c.get("linked_item_ids") or [])]
                elif c.get("text"):
                    cells[cid] = c["text"]
                else:
                    # Mirrors and formulas carry no `text` at all.
                    cells[cid] = c.get("display_value") or None
            out.append({
                "id": int(item["id"]),
                "name": item.get("name") or "",
                "url": item.get("url") or "",
                "cells": cells,
            })

        cursor = page.get("cursor")
        if not cursor or len(out) >= limit:
            break

    return {"board": board_name, "items": out[:limit]}
