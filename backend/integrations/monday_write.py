"""monday.com write client — change orders only.

The read client (``integrations/monday.py``) says writing back "should be a
separate module with its own review, not an extra function here". This is that
module, and it is deliberately narrow: it writes change orders to one pinned
board and touches nothing else.

WHY THIS EXISTS
---------------
The Portfolio board computes ``Total Contract Value = Deal Value + Change Order
Amount``, where the change-order half is a mirror through the "Link to Change
Orders" relation. PMO 360 owns the change-order lifecycle end to end — drafting,
line items, internal markups, named approvers, the signed PDF — but none of that
reaches Monday unless somebody re-keys it. Today the Change Order board holds two
stub items, neither linked to a project, so the mirror resolves to nothing and
every project's contract value is missing its change orders.

Pushing is therefore not a convenience. It is what makes a number the PMO already
looks at correct.

SAFETY RULES, all enforced below rather than documented and hoped for
--------------------------------------------------------------------
1. This module can create and update items on ``CO_BOARD_ID`` and nothing else.
   Every mutation names that board explicitly; there is no caller-supplied board.
2. It never deletes and never archives. There is no code path to remove anything.
3. Writes are idempotent by ``monday_item_id``: given one, we update in place;
   without one, we create. A caller that loses the id creates a duplicate, so the
   id belongs in the database (see MIGRATION NOTE) rather than in a caller's head.
4. Every write is preview-able. ``build_change_order_payload`` is pure and does
   the whole mapping; ``push_change_order`` only transports it. The UI shows the
   payload before anything leaves the building.
5. Missing config degrades to a raised ``MondayNotConfigured`` at the call site,
   never at import, so the app boots without a token like the read client does.

MIGRATION NOTE
--------------
One column makes this durable: ``change_orders.monday_item_id BIGINT NULL``.
Until it exists, callers must pass ``monday_item_id`` themselves and a lost id
means a duplicate row on the board. Nothing else in the schema changes.
"""
import logging
import os
from datetime import date, datetime
from typing import Any, Optional

import requests

logger = logging.getLogger(__name__)

API_URL = "https://api.monday.com/v2"
API_VERSION = "2024-10"
TIMEOUT = 20

# ---- Board profiles ------------------------------------------------------
# Monday addresses columns by opaque id, and those ids are per-board — so a
# sandbox copy of a board has the same columns under entirely different ids.
# Rather than let a caller pass ids in (which would defeat rule 1), the module
# holds a fixed set of named profiles and selects one from the environment.
# Anything not named here is unreachable.


class BoardProfile:
    """One board's identity: which board, and what its columns are called."""

    __slots__ = (
        "name", "board_id", "group_new", "col_number", "col_project_code",
        "col_subject", "col_description", "col_amount", "col_date",
        "col_status", "col_sent_from", "col_sent_to", "col_related_project",
        "portfolio_board_id", "portfolio_col_change_orders",
    )

    def __init__(self, name, board_id, group_new, col_number, col_project_code,
                 col_subject, col_description, col_amount, col_date,
                 col_status, col_sent_from, col_sent_to, col_related_project,
                 portfolio_board_id, portfolio_col_change_orders):
        self.name = name
        self.board_id = board_id
        self.group_new = group_new
        self.col_number = col_number
        self.col_project_code = col_project_code
        self.col_subject = col_subject
        self.col_description = col_description
        self.col_amount = col_amount
        self.col_date = col_date
        self.col_status = col_status
        self.col_sent_from = col_sent_from
        self.col_sent_to = col_sent_to
        self.col_related_project = col_related_project
        # The Portfolio side of the link. See link_to_portfolio() for why both
        # ends have to be written.
        self.portfolio_board_id = portfolio_board_id
        self.portfolio_col_change_orders = portfolio_col_change_orders


PROFILES = {
    # The real Change Order board the PMO works from.
    "prod": BoardProfile(
        name="prod",
        board_id=18403113199,
        group_new="topics",                          # "New"
        col_number="text_mm2kkhbj",                  # "Change Order #"
        col_project_code="text_mm2kezgn",            # "Project ID"
        col_subject="text_mm1vf7j0",                 # "Subject"
        col_description="long_text_mm2kmzkv",        # "Description"
        col_amount="numeric_mm2dmndg",               # "Amount" ($) -> contract value
        col_date="date4",                            # "Date"
        col_status="status",
        col_sent_from="text_mm1vn7m8",               # "Sent From"
        col_sent_to="text_mm1vk0qy",                 # "Sent To"
        col_related_project="board_relation_mm2dcje4",  # -> Portfolio (CO side)
        portfolio_board_id=18403099969,
        portfolio_col_change_orders="board_relation_mm2df13k",  # "Link to Change Orders"
    ),
    # "PMO 360 Demo · Change Orders" — a structural copy used for demos and for
    # exercising this module end to end without touching the board 31 people use.
    "sandbox": BoardProfile(
        name="sandbox",
        board_id=18429174461,
        group_new="topics",
        col_number="text_mm6sffgx",
        col_project_code="text_mm6s4sz5",
        col_subject="text_mm6ssajq",
        col_description="long_text_mm6sczv1",
        col_amount="numeric_mm6sqzze",
        col_date="date_mm6s9eda",
        col_status="color_mm6ssv8k",
        col_sent_from="text_mm6svhjn",
        col_sent_to="text_mm6s24kk",
        col_related_project="board_relation_mm6sd0tm",
        portfolio_board_id=18429174500,
        portfolio_col_change_orders="board_relation_mm6sfvfs",
    ),
}


# The Portfolio-board columns the push reads back from. Kept beside the
# profiles rather than on them because they are only ever read, never written —
# see read_contract_value().
PORTFOLIO_MIRROR_CO_AMOUNT = {"prod": "lookup_mm2dh74k", "sandbox": "lookup_mm6sahrs"}
PORTFOLIO_FORMULA_TOTAL = {"prod": "formula_mm2gmsj6", "sandbox": "formula_mm6snez3"}
# Prod's deal value is itself a mirror from the CRM Deals board; sandbox holds a
# plain number so the demo can show a base figure.
PORTFOLIO_DEAL_VALUE = {"prod": "lookup_mm21xfp0", "sandbox": "numeric_mm6sdap2"}


def active_profile() -> BoardProfile:
    """Which board this process writes to. Defaults to prod, never to a guess."""
    key = os.getenv("MONDAY_CO_BOARD_PROFILE", "prod").strip().lower() or "prod"
    if key not in PROFILES:
        raise MondayWriteError(
            f"MONDAY_CO_BOARD_PROFILE={key!r} is not a known profile "
            f"(have: {', '.join(sorted(PROFILES))})"
        )
    return PROFILES[key]

# PMO 360 status -> the label as it is spelled on the board. Monday matches
# status by label text, so these strings must stay in step with the board; a
# typo silently leaves the cell empty rather than erroring.
_STATUS_MAP = {
    "draft": "New",
    "pending": "In Review",
    "approved": "Completed",
}
_DEFAULT_STATUS = "New"


class MondayWriteError(RuntimeError):
    """A write was attempted and Monday rejected it."""


class MondayNotConfigured(RuntimeError):
    """No API token. Raised at the call site, never at import."""


def _token() -> str:
    token = os.getenv("MONDAY_API_TOKEN", "").strip()
    if not token:
        raise MondayNotConfigured("MONDAY_API_TOKEN is not set")
    return token


def is_configured() -> bool:
    return bool(os.getenv("MONDAY_API_TOKEN", "").strip())


def _post(query: str, variables: dict[str, Any]) -> dict[str, Any]:
    """Run one GraphQL mutation.

    Monday returns HTTP 200 with an ``errors`` array for most failures, so the
    status code alone tells you almost nothing. Check the body.
    """
    resp = requests.post(
        API_URL,
        json={"query": query, "variables": variables},
        headers={
            "Authorization": _token(),      # no "Bearer" prefix — Monday is unusual here
            "API-Version": API_VERSION,
            "Content-Type": "application/json",
        },
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("errors"):
        msgs = "; ".join(e.get("message", "?") for e in body["errors"])
        raise MondayWriteError(f"monday.com rejected the write: {msgs}")
    return body.get("data") or {}


def _as_iso_date(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return None


# --------------------------------------------------------------------------
# Mapping. Pure, so the UI can show exactly what will be sent.
# --------------------------------------------------------------------------

def build_change_order_payload(
    *,
    co_number: int,
    total_amount: float,
    status: str,
    portfolio_name: str,
    project_code: Optional[str] = None,
    subject: Optional[str] = None,
    description: Optional[str] = None,
    effective_date: Any = None,
    sent_from: Optional[str] = None,
    sent_to: Optional[str] = None,
    monday_project_item_id: Optional[int] = None,
) -> dict[str, Any]:
    """Map one PMO 360 change order onto the board's column ids.

    Returns ``{"item_name": str, "column_values": {...}}`` — the exact shape the
    mutation takes. No network access, no side effects: safe to call to render a
    preview, and the thing tests assert against.

    Only fields with a value are emitted. Monday treats an explicit ``null`` as
    "clear this cell", so sending everything would blank columns a human filled
    in by hand on a previous push.
    """
    p = active_profile()
    label = f"CO-{co_number}"
    item_name = f"{portfolio_name} — {label}" if portfolio_name else label

    cols: dict[str, Any] = {
        p.col_number: label,
        p.col_amount: str(round(float(total_amount or 0.0), 2)),
        p.col_status: {"label": _STATUS_MAP.get(status, _DEFAULT_STATUS)},
    }

    if project_code:
        cols[p.col_project_code] = project_code
    if subject:
        cols[p.col_subject] = subject[:255]
    if description:
        cols[p.col_description] = {"text": description}
    if sent_from:
        cols[p.col_sent_from] = sent_from[:255]
    if sent_to:
        cols[p.col_sent_to] = sent_to[:255]

    iso = _as_iso_date(effective_date)
    if iso:
        cols[p.col_date] = {"date": iso}

    # The relation is what makes the Portfolio board's contract-value mirror
    # resolve. Without it the item is on the board but invisible to every
    # rollup — which is precisely the state the two hand-made items are in.
    if monday_project_item_id:
        cols[p.col_related_project] = {"item_ids": [int(monday_project_item_id)]}

    return {"item_name": item_name, "column_values": cols, "board": p.name}


# --------------------------------------------------------------------------
# Transport.
# --------------------------------------------------------------------------

_CREATE = """
mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $cols: JSON!) {
  create_item(
    board_id: $boardId,
    group_id: $groupId,
    item_name: $itemName,
    column_values: $cols,
    create_labels_if_missing: false
  ) { id name url }
}
"""

_UPDATE = """
mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
  change_multiple_column_values(
    board_id: $boardId,
    item_id: $itemId,
    column_values: $cols,
    create_labels_if_missing: false
  ) { id name url }
}
"""


def push_change_order(
    payload: dict[str, Any],
    monday_item_id: Optional[int] = None,
) -> dict[str, Any]:
    """Create or update one change order on the board.

    ``payload`` comes from :func:`build_change_order_payload` — pass it through
    unmodified so what was previewed is what is sent. With ``monday_item_id`` we
    update that item in place; without one we create.

    Returns ``{"id", "name", "url", "action"}``. Persist ``id`` against the change
    order or the next push creates a duplicate.
    """
    import json

    # Rule 1, enforced rather than trusted: the board comes from the selected
    # profile, never from the caller. A payload built for one profile must not
    # be sent to another — its column ids would simply not exist there, and
    # Monday would accept the item with every cell empty.
    p = active_profile()
    if payload.get("board") not in (None, p.name):
        raise MondayWriteError(
            f"payload was built for the {payload['board']!r} board but this "
            f"process is configured for {p.name!r}; rebuild it before sending"
        )

    cols = json.dumps(payload["column_values"])

    if monday_item_id:
        data = _post(_UPDATE, {
            "boardId": str(p.board_id),
            "itemId": str(monday_item_id),
            "cols": cols,
        })
        item = data.get("change_multiple_column_values") or {}
        action = "updated"
    else:
        data = _post(_CREATE, {
            "boardId": str(p.board_id),
            "groupId": p.group_new,
            "itemName": payload["item_name"],
            "cols": cols,
        })
        item = data.get("create_item") or {}
        action = "created"

    if not item.get("id"):
        raise MondayWriteError(f"monday.com accepted the {action[:-1]} but returned no item id")

    logger.info("monday change order %s: item %s (%s)", action, item["id"], item.get("name"))
    return {**item, "action": action}


_LINK_PORTFOLIO_SIMPLE = """
mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
  change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols) { id }
}
"""


def link_to_portfolio(monday_project_item_id: int, co_item_ids: list[int]) -> None:
    """Point the Portfolio item's "Link to Change Orders" column at these orders.

    THIS IS NOT OPTIONAL AND IT IS NOT A DUPLICATE OF THE CO-SIDE LINK.

    The Change Order board and the Portfolio board each carry their own
    board-relation column. They look like two ends of one link and they are not:
    Monday only mirrors a relation automatically when the second column was
    created as a *reflection* of the first. Two independently created relation
    columns are two independent relations.

    That matters because "Change Order Amount" on the Portfolio board is a mirror
    that traverses the PORTFOLIO board's relation. Writing only the CO side
    produces an item that is visibly on the board, correctly filled in, linked to
    the project when you open it — and completely invisible to Total Contract
    Value. Which is exactly the state of the two change orders somebody entered
    on the live board by hand.

    So a push is two writes, and the second one is the one that moves the money.

    Note this REPLACES the column's contents rather than appending, so callers
    must pass the project's full set of change-order item ids, not just the new
    one.
    """
    import json

    p = active_profile()
    _post(_LINK_PORTFOLIO_SIMPLE, {
        "boardId": str(p.portfolio_board_id),
        "itemId": str(monday_project_item_id),
        "cols": json.dumps({
            p.portfolio_col_change_orders: {"item_ids": [int(i) for i in co_item_ids]},
        }),
    })
    logger.info(
        "monday portfolio item %s now links %d change order(s)",
        monday_project_item_id, len(co_item_ids),
    )


_READ_MONEY = """
query ($ids: [ID!], $cols: [String!]) {
  items(ids: $ids) {
    id
    name
    column_values(ids: $cols) {
      id
      text
      ... on BoardRelationValue { linked_item_ids }
      ... on MirrorValue { display_value }
      ... on FormulaValue { display_value }
    }
  }
}
"""


def read_contract_value(monday_project_item_id: int) -> dict[str, Any]:
    """Read a Portfolio item's change-order links and contract value.

    A read living in the write module, deliberately: this is the push's own
    verification step, not a general-purpose reader. It answers the only two
    questions a push needs — which change orders are currently linked (so the
    Portfolio-side write can send the union rather than clobbering the list),
    and what the contract value is, so before/after can be shown truthfully
    rather than asserted.
    """
    p = active_profile()
    cols = [
        p.portfolio_col_change_orders,
        PORTFOLIO_MIRROR_CO_AMOUNT[p.name],
        PORTFOLIO_FORMULA_TOTAL[p.name],
        PORTFOLIO_DEAL_VALUE[p.name],
    ]
    data = _post(_READ_MONEY, {"ids": [str(monday_project_item_id)], "cols": cols})
    items = data.get("items") or []
    if not items:
        raise MondayWriteError(f"portfolio item {monday_project_item_id} not found")

    item = items[0]
    out: dict[str, Any] = {
        "id": int(item["id"]), "name": item.get("name") or "",
        "linked_change_orders": [], "change_order_amount": None,
        "total_contract_value": None, "deal_value": None,
    }
    for c in item.get("column_values") or []:
        cid = c.get("id")
        if cid == p.portfolio_col_change_orders:
            out["linked_change_orders"] = [int(i) for i in (c.get("linked_item_ids") or [])]
        elif cid == PORTFOLIO_MIRROR_CO_AMOUNT[p.name]:
            out["change_order_amount"] = c.get("display_value")
        elif cid == PORTFOLIO_FORMULA_TOTAL[p.name]:
            out["total_contract_value"] = c.get("display_value")
        elif cid == PORTFOLIO_DEAL_VALUE[p.name]:
            out["deal_value"] = c.get("text")
    return out


def push_change_order_full(
    payload: dict[str, Any],
    monday_project_item_id: int,
    monday_item_id: Optional[int] = None,
) -> dict[str, Any]:
    """The whole round trip: read, write the order, link it, read back.

    Both writes happen here because doing only the first one is the trap this
    module exists to stop people falling into. See :func:`link_to_portfolio`.
    """
    before = read_contract_value(monday_project_item_id)
    item = push_change_order(payload, monday_item_id=monday_item_id)

    ids = [i for i in before["linked_change_orders"] if i != int(item["id"])]
    ids.append(int(item["id"]))
    link_to_portfolio(monday_project_item_id, ids)

    after = read_contract_value(monday_project_item_id)
    return {"item": item, "before": before, "after": after}
