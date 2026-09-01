"""/api/monday/bridge — a working two-way demo of the monday.com integration.

This is a DEMO SURFACE, not a production feature. It exists so the push and
pull can be shown to somebody rather than described to them, and so the write
path can be exercised end to end against boards nobody works from.

Two things keep it safe:

1. Every write goes through ``integrations.monday_write``, which can only reach
   the board named by ``MONDAY_CO_BOARD_PROFILE``. This router refuses to expose
   its push endpoints at all unless that profile is ``sandbox`` — so pointing a
   deployment at the real board turns the demo off rather than arming it.
2. Reads are limited to the three boards named below. There is no endpoint that
   takes a board id from the caller.

When the integration graduates from demo to feature, the pieces worth keeping
are in ``integrations/`` — this file is the scaffolding around them.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import require_db_user
from integrations import monday, monday_write

router = APIRouter(prefix="/api/monday/bridge", tags=["monday-bridge"])


# The only boards this router will read. Column ids are per-board and opaque,
# so each entry carries its own map; the labels are what the screen shows.
DEMO_BOARDS: dict[str, dict[str, Any]] = {
    "portfolio": {
        "board_id": 18429174500,
        "label": "Portfolio",
        "columns": {
            "project_code": "text_mm6sb3j0",
            "client": "text_mm6s2yz",
            "deal_value": "numeric_mm6sdap2",
            "contract_status": "color_mm6svvfa",
            "linked_change_orders": "board_relation_mm6sfvfs",
            "change_order_amount": "lookup_mm6sahrs",
            "total_contract_value": "formula_mm6snez3",
        },
    },
    "rfis": {
        "board_id": 18429174531,
        "label": "RFIs",
        "columns": {
            "item": "text_mm6s7yvq",
            "status": "color_mm6s1m8x",
            "response_owner": "color_mm6s3kg6",
            "discipline": "dropdown_mm6s25f5",
            "date_submitted": "date_mm6s8nq",
            "response_needed_by": "date_mm6skgmj",
            "question": "long_text_mm6sw4g5",
            "project": "board_relation_mm6ssgxz",
        },
    },
    "change_orders": {
        "board_id": 18429174461,
        "label": "Change Orders",
        "columns": {
            "co_number": "text_mm6sffgx",
            "project_code": "text_mm6s4sz5",
            "subject": "text_mm6ssajq",
            "description": "long_text_mm6sczv1",
            "amount": "numeric_mm6sqzze",
            "date": "date_mm6s9eda",
            "status": "color_mm6ssv8k",
            "related_project": "board_relation_mm6sd0tm",
        },
    },
}


def _require_sandbox() -> monday_write.BoardProfile:
    """Writes are only ever offered against the sandbox.

    Deliberately a 409 rather than a 403: nothing is wrong with the caller's
    credentials, the server is simply not configured to allow this.
    """
    profile = monday_write.active_profile()
    if profile.name != "sandbox":
        raise HTTPException(
            409,
            "The bridge demo only pushes to the sandbox board. This deployment is "
            f"configured for the {profile.name!r} board, so pushing is disabled.",
        )
    return profile


# ---------------------------------------------------------------- schemas
class BridgeStatus(BaseModel):
    configured: bool
    profile: str
    can_push: bool
    boards: dict[str, str]
    note: Optional[str] = None


class BoardRow(BaseModel):
    id: int
    name: str
    url: str
    cells: dict[str, Any]


class BoardOut(BaseModel):
    key: str
    label: str
    board_id: int
    columns: dict[str, str]
    rows: list[BoardRow]


class PushRequest(BaseModel):
    monday_project_item_id: int
    co_number: int = Field(ge=1)
    total_amount: float = Field(ge=0)
    status: str = "approved"
    portfolio_name: str
    project_code: Optional[str] = None
    subject: Optional[str] = None
    description: Optional[str] = None
    effective_date: Optional[date] = None
    sent_to: Optional[str] = None


# ---------------------------------------------------------------- routes
@router.get("/status", response_model=BridgeStatus)
def status(_user=Depends(require_db_user)) -> BridgeStatus:
    configured = monday.is_configured()
    try:
        profile = monday_write.active_profile()
        name = profile.name
    except Exception:
        name = "unknown"

    note = None
    if not configured:
        note = "MONDAY_API_TOKEN is not set on this deployment, so nothing can be read or written."
    elif name != "sandbox":
        note = f"Configured for the {name!r} board — reads work, pushing is disabled."

    return BridgeStatus(
        configured=configured,
        profile=name,
        can_push=configured and name == "sandbox",
        boards={k: v["label"] for k, v in DEMO_BOARDS.items()},
        note=note,
    )


@router.get("/board/{key}", response_model=BoardOut)
def read_board(key: str, _user=Depends(require_db_user)) -> BoardOut:
    spec = DEMO_BOARDS.get(key)
    if not spec:
        raise HTTPException(404, f"Unknown board {key!r}")
    if not monday.is_configured():
        raise HTTPException(503, "monday.com is not configured on this deployment.")

    cols = list(spec["columns"].values())
    try:
        data = monday.read_board_items(spec["board_id"], cols, limit=200)
    except monday.MondayNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # network, GraphQL error, anything upstream
        raise HTTPException(502, f"monday.com read failed: {exc}") from exc

    return BoardOut(
        key=key,
        label=spec["label"],
        board_id=spec["board_id"],
        columns=spec["columns"],
        rows=[BoardRow(**row) for row in data["items"]],
    )


@router.post("/preview")
def preview(req: PushRequest, _user=Depends(require_db_user)) -> dict[str, Any]:
    """Show exactly what would be sent. Pure mapping, no network call."""
    _require_sandbox()
    payload = monday_write.build_change_order_payload(
        co_number=req.co_number,
        total_amount=req.total_amount,
        status=req.status,
        portfolio_name=req.portfolio_name,
        project_code=req.project_code,
        subject=req.subject,
        description=req.description,
        effective_date=req.effective_date,
        sent_from="Castillo Engineering",
        sent_to=req.sent_to,
        monday_project_item_id=req.monday_project_item_id,
    )
    return {"payload": payload}


@router.post("/push")
def push(req: PushRequest, _user=Depends(require_db_user)) -> dict[str, Any]:
    """Create the change order, link it from the Portfolio side, read back.

    Both writes and both reads, so the response can show the contract value
    actually moving rather than claiming it did.
    """
    _require_sandbox()
    payload = monday_write.build_change_order_payload(
        co_number=req.co_number,
        total_amount=req.total_amount,
        status=req.status,
        portfolio_name=req.portfolio_name,
        project_code=req.project_code,
        subject=req.subject,
        description=req.description,
        effective_date=req.effective_date,
        sent_from="Castillo Engineering",
        sent_to=req.sent_to,
        monday_project_item_id=req.monday_project_item_id,
    )
    try:
        result = monday_write.push_change_order_full(
            payload, monday_project_item_id=req.monday_project_item_id
        )
    except monday_write.MondayNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    except monday_write.MondayWriteError as exc:
        raise HTTPException(502, str(exc)) from exc

    return {"payload": payload, **result}


# ---------------------------------------------------------------- rollup
# The aggregate upper management actually asks for. Computed here rather than
# in the browser so the numbers are the same wherever they are shown — a chart
# and a PDF disagreeing about a contract total is worse than having neither.


#: A comma inside a Monday money string is ambiguous: it separates the values of
#: a multi-link mirror ("12480.0, 4850.0, 7200.0") AND groups thousands
#: ("$1,200"). Stripping all commas before splitting silently reads three change
#: orders as zero; splitting without stripping reads $1,200 as 1 + 200. So only
#: remove a comma that sits between a digit and exactly three digits followed by
#: a non-digit or the end — a thousands group and never a list separator, since
#: Monday's list separator is always ", " with a space.
_THOUSANDS_SEP = re.compile(r"(?<=\d),(?=\d{3}(?:\D|$))")


def _num(v: Any) -> float:
    """Total a Monday money cell, whether it holds one value or a mirrored list."""
    if v is None:
        return 0.0
    s = str(v).replace("$", "").strip()
    if not s:
        return 0.0
    s = _THOUSANDS_SEP.sub("", s)
    total = 0.0
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            total += float(part)
        except ValueError:
            continue
    return total


def _age_days(iso: Any, today: date) -> Optional[int]:
    if not iso:
        return None
    try:
        return (today - date.fromisoformat(str(iso)[:10])).days
    except ValueError:
        return None


class ClientRollup(BaseModel):
    client: str
    projects: int
    #: Sum across only the projects that HAVE a value; see projects_priced.
    contract_value: float
    #: How many of this client's projects carry a contract value at all. When
    #: this is 0 the sum above is not "zero dollars", it is "nothing recorded".
    projects_priced: int = 0
    change_order_value: float
    open_rfis: int
    #: Open RFIs whose response owner is the client — the number that turns a
    #: schedule conversation from opinion into evidence.
    rfis_on_client: int
    avg_open_age_days: Optional[float] = None
    oldest_open_age_days: Optional[int] = None
    statuses: dict[str, int] = Field(default_factory=dict)


class ProjectRollup(BaseModel):
    id: int
    name: str
    project_code: Optional[str] = None
    client: Optional[str] = None
    contract_status: Optional[str] = None
    #: None means NOT SET on the board, which is different from zero. The
    #: Portfolio board's contract value comes from a Deals mirror that is empty
    #: for every project today, so most of these are None and the UI must not
    #: draw them as $0.
    contract_value: Optional[float] = None
    change_order_value: float
    open_rfis: int
    oldest_open_age_days: Optional[int] = None


class RollupOut(BaseModel):
    as_of: date
    totals: dict[str, Any]
    by_client: list[ClientRollup]
    by_project: list[ProjectRollup]
    data_quality: dict[str, int]


@router.get("/rollup", response_model=RollupOut)
def rollup(_user=Depends(require_db_user)) -> RollupOut:
    """Client and portfolio aggregates, joined across the Portfolio and RFI boards."""
    if not monday.is_configured():
        raise HTTPException(503, "monday.com is not configured on this deployment.")

    pf_spec = DEMO_BOARDS["portfolio"]
    rfi_spec = DEMO_BOARDS["rfis"]
    pc, rc = pf_spec["columns"], rfi_spec["columns"]

    try:
        pf = monday.read_board_items(pf_spec["board_id"], list(pc.values()), limit=200)
        rfi = monday.read_board_items(rfi_spec["board_id"], list(rc.values()), limit=200)
    except Exception as exc:
        raise HTTPException(502, f"monday.com read failed: {exc}") from exc

    today = date.today()

    # RFIs, bucketed by the portfolio item they link to. An RFI linked to more
    # than one project counts under each — deliberately: a shared RFI blocks
    # every project it is attached to, and hiding it from all but the first
    # would understate exactly the thing this view exists to show.
    open_by_project: dict[int, list[dict[str, Any]]] = {}
    rfis_total = 0
    no_due = 0
    no_question = 0
    for row in rfi["items"]:
        rfis_total += 1
        cells = row["cells"]
        if not cells.get(rc["response_needed_by"]):
            no_due += 1
        if not cells.get(rc["question"]):
            no_question += 1
        if str(cells.get(rc["status"]) or "").lower() == "completed":
            continue
        rec = {
            "owner": cells.get(rc["response_owner"]) or "",
            "age": _age_days(cells.get(rc["date_submitted"]), today),
        }
        for pid in (cells.get(rc["project"]) or []):
            open_by_project.setdefault(int(pid), []).append(rec)

    by_project: list[ProjectRollup] = []
    clients: dict[str, dict[str, Any]] = {}
    no_code = 0
    no_rfis = 0

    for row in pf["items"]:
        cells = row["cells"]
        client = (cells.get(pc["client"]) or "Unassigned").strip() or "Unassigned"
        code = cells.get(pc["project_code"])
        cstatus = cells.get(pc["contract_status"])
        co_val = _num(cells.get(pc["change_order_amount"]))
        total_val = _num(cells.get(pc["total_contract_value"]))
        if not total_val:
            # No formula value yet (nothing linked) — fall back to deal value so
            # a project is not reported as a zero-dollar contract.
            total_val = _num(cells.get(pc["deal_value"]))
        if not code:
            no_code += 1

        opens = open_by_project.get(row["id"], [])
        if not opens:
            no_rfis += 1
        ages = [o["age"] for o in opens if o["age"] is not None]

        # "Priced" means somebody has actually recorded money against this
        # project, through either a deal value or a linked change order. Absent
        # both, the project has no contract value — not a contract value of nil.
        priced = bool(total_val or co_val)

        by_project.append(ProjectRollup(
            id=row["id"], name=row["name"], project_code=code, client=client,
            contract_status=cstatus,
            contract_value=total_val if priced else None,
            change_order_value=co_val, open_rfis=len(opens),
            oldest_open_age_days=max(ages) if ages else None,
        ))

        c = clients.setdefault(client, {
            "projects": 0, "contract_value": 0.0, "change_order_value": 0.0,
            "open_rfis": 0, "rfis_on_client": 0, "ages": [], "statuses": {},
            "projects_priced": 0,
        })
        c["projects"] += 1
        if priced:
            c["contract_value"] += total_val
            c["projects_priced"] += 1
        c["change_order_value"] += co_val
        c["open_rfis"] += len(opens)
        c["rfis_on_client"] += sum(
            1 for o in opens if o["owner"] in ("Client Data Needed", "Client Response")
        )
        c["ages"].extend(ages)
        if cstatus:
            c["statuses"][cstatus] = c["statuses"].get(cstatus, 0) + 1

    by_client = [
        ClientRollup(
            client=name,
            projects=v["projects"],
            contract_value=round(v["contract_value"], 2),
            projects_priced=v["projects_priced"],
            change_order_value=round(v["change_order_value"], 2),
            open_rfis=v["open_rfis"],
            rfis_on_client=v["rfis_on_client"],
            avg_open_age_days=round(sum(v["ages"]) / len(v["ages"]), 1) if v["ages"] else None,
            oldest_open_age_days=max(v["ages"]) if v["ages"] else None,
            statuses=v["statuses"],
        )
        for name, v in clients.items()
    ]
    by_client.sort(key=lambda c: (-c.contract_value, c.client))
    by_project.sort(key=lambda p: (-p.open_rfis, -(p.contract_value or 0.0), p.name))

    total_open = sum(c.open_rfis for c in by_client)
    total_on_client = sum(c.rfis_on_client for c in by_client)

    return RollupOut(
        as_of=today,
        by_client=by_client,
        by_project=by_project,
        totals={
            "clients": len(by_client),
            "projects": len(by_project),
            "contract_value": round(sum(c.contract_value for c in by_client), 2),
            "change_order_value": round(sum(c.change_order_value for c in by_client), 2),
            "rfis_total": rfis_total,
            "rfis_open": total_open,
            "rfis_on_client": total_on_client,
            "pct_on_client": round(total_on_client / total_open * 100) if total_open else 0,
            "projects_priced": sum(c.projects_priced for c in by_client),
        },
        data_quality={
            "projects_without_contract_value":
                len(by_project) - sum(c.projects_priced for c in by_client),
            "projects_without_code": no_code,
            "projects_without_rfis": no_rfis,
            "rfis_without_due_date": no_due,
            "rfis_without_question": no_question,
        },
    )


# ---------------------------------------------------------------- task boards
# Every project on the Portfolio board has its own task board — the real
# schedule, ~380 tasks each, with phase, status, discipline, owner, targeted
# vs actual hours and billable vs actual cost. That is the detail management
# asks for, and none of it exists anywhere in PMO 360.
#
# These reads go against the LIVE boards, not the sandbox, and that is
# deliberate: the sandbox exists to make WRITES safe, and a status dashboard
# built on copied data would be a mock-up. Reading cannot damage a board. The
# board id is still never taken from the caller — it must be one of the ids
# below, which are the boards the Portfolio's "Project Tasks Links" column
# points at.
LIVE_TASK_BOARD_IDS = frozenset({
    18424062924, 18425915159, 18425960038, 18425960070, 18425960122, 18425960165,
    18425974894, 18425974919, 18425974945, 18426025021, 18426025095, 18426025134,
    18426025246, 18426025295, 18426318209, 18426318275, 18426318360, 18426318308,
    18426318429, 18426321668, 18426322197, 18426322212, 18426322617, 18426322628,
    18426322624, 18426323228, 18426323221, 18426323202, 18426323215, 18426323246,
    18426323597, 18426323595, 18426323598, 18426323604, 18426323694, 18426323706,
    18426323699, 18426323693, 18426323786, 18425272063,
})

TASK_COLS = {
    "status": "project_status",              # Not Started / In Progress / Completed / Requires action / In QC / On Hold / N/A / Future steps
    "phase": "color_mm4j79qe",               # Project Initiation / Due Diligence / 10% / 30% / 60% / 90% / IFC / Record Drawings
    "discipline": "dropdown_mm4jygv4",       # Sales / PMO / Civil / Electrical / Structural
    "owner": "project_owner",
    "priority": "project_priority",          # Critical / High / Medium / Low
    "targeted_hours": "project_planned_effort",
    "actual_hours": "formula_mm4kqacx",
    "billable_cost": "formula_mm4kf7zp",
    "actual_cost": "formula_mm4k6jkt",
    "dependency_due": "date_mm4knhb7",       # "External Dependency Due Date"
    "completed_on": "project_task_completion_date",
    "qc_status": "color_mm522b42",
}

#: Statuses that mean the task needs nobody's attention any more. "N/A" counts
#: as settled deliberately — a task marked not-applicable is not outstanding
#: work, and lumping it in with real work overstates what is left.
_DONE_STATUSES = {"completed", "n/a"}
#: Phases in the order a project actually runs, so the phase table reads as a
#: progression rather than alphabetically.
_PHASE_ORDER = [
    "Project Initiation", "Due Diligence", "10%", "30%", "60%", "90%", "IFC",
    "Record Drawings",
]


class PhaseRollup(BaseModel):
    phase: str
    total: int
    done: int
    in_progress: int
    blocked: int
    not_started: int
    pct_complete: int


class TaskFlag(BaseModel):
    id: int
    name: str
    phase: Optional[str] = None
    status: Optional[str] = None
    owner: Optional[str] = None
    discipline: Optional[str] = None
    reason: str
    days_overdue: Optional[int] = None


class TaskBoardOut(BaseModel):
    board_id: int
    board_name: str
    task_count: int
    totals: dict[str, Any]
    by_phase: list[PhaseRollup]
    by_status: dict[str, int]
    by_discipline: dict[str, int]
    by_owner: list[dict[str, Any]]
    flags: list[TaskFlag]


class TaskBoardRef(BaseModel):
    board_id: int
    name: str
    task_count: int


@router.get("/task-boards", response_model=list[TaskBoardRef])
def task_boards(_user=Depends(require_db_user)) -> list[TaskBoardRef]:
    """The live per-project task boards, so the UI can offer a picker."""
    if not monday.is_configured():
        raise HTTPException(503, "monday.com is not configured on this deployment.")
    q = """
    query ($ids: [ID!]) { boards(ids: $ids) { id name items_count } }
    """
    try:
        data = monday._post(q, {"ids": [str(i) for i in sorted(LIVE_TASK_BOARD_IDS)]})
    except Exception as exc:
        raise HTTPException(502, f"monday.com read failed: {exc}") from exc
    out = [
        TaskBoardRef(board_id=int(b["id"]), name=b.get("name") or "",
                     task_count=int(b.get("items_count") or 0))
        for b in (data.get("boards") or [])
    ]
    out.sort(key=lambda b: b.name.lower())
    return out


@router.get("/tasks/{board_id}", response_model=TaskBoardOut)
def tasks(board_id: int, _user=Depends(require_db_user)) -> TaskBoardOut:
    """One project's task board, aggregated for a management view.

    Returns rollups plus a bounded list of tasks that need somebody to look at
    them — never all 380 rows, because a wall of tasks is not a dashboard.
    """
    if board_id not in LIVE_TASK_BOARD_IDS:
        raise HTTPException(404, "Not a known project task board.")
    if not monday.is_configured():
        raise HTTPException(503, "monday.com is not configured on this deployment.")

    try:
        data = monday.read_board_items(board_id, list(TASK_COLS.values()), limit=600)
    except Exception as exc:
        raise HTTPException(502, f"monday.com read failed: {exc}") from exc

    c = TASK_COLS
    today = date.today()
    items = data["items"]

    by_status: dict[str, int] = {}
    by_discipline: dict[str, int] = {}
    owners: dict[str, dict[str, int]] = {}
    phases: dict[str, dict[str, int]] = {}
    flags: list[TaskFlag] = []
    targeted = actual = billable = actual_cost = 0.0
    done_total = 0

    for it in items:
        cells = it["cells"]
        status = (cells.get(c["status"]) or "").strip()
        phase = (cells.get(c["phase"]) or "Unphased").strip() or "Unphased"
        disc = (cells.get(c["discipline"]) or "Unassigned").strip() or "Unassigned"
        owner = (cells.get(c["owner"]) or "Unassigned").strip() or "Unassigned"
        low = status.lower()
        is_done = low in _DONE_STATUSES

        by_status[status or "(not set)"] = by_status.get(status or "(not set)", 0) + 1
        by_discipline[disc] = by_discipline.get(disc, 0) + 1

        targeted += _num(cells.get(c["targeted_hours"]))
        actual += _num(cells.get(c["actual_hours"]))
        billable += _num(cells.get(c["billable_cost"]))
        actual_cost += _num(cells.get(c["actual_cost"]))
        if is_done:
            done_total += 1

        p = phases.setdefault(phase, {"total": 0, "done": 0, "in_progress": 0,
                                      "blocked": 0, "not_started": 0})
        p["total"] += 1
        if is_done:
            p["done"] += 1
        elif low in ("in progress", "in qc"):
            p["in_progress"] += 1
        elif low in ("requires action", "on hold"):
            p["blocked"] += 1
        else:
            p["not_started"] += 1

        o = owners.setdefault(owner, {"total": 0, "open": 0, "blocked": 0})
        o["total"] += 1
        if not is_done:
            o["open"] += 1
        if low in ("requires action", "on hold"):
            o["blocked"] += 1

        # Things worth a manager's attention, in severity order.
        if is_done:
            continue
        overdue = _age_days(cells.get(c["dependency_due"]), today)
        if overdue is not None and overdue > 0:
            flags.append(TaskFlag(
                id=it["id"], name=it["name"], phase=phase, status=status, owner=owner,
                discipline=disc, reason="External dependency overdue", days_overdue=overdue,
            ))
        elif low == "requires action":
            flags.append(TaskFlag(id=it["id"], name=it["name"], phase=phase, status=status,
                                  owner=owner, discipline=disc, reason="Requires action"))
        elif low == "on hold":
            flags.append(TaskFlag(id=it["id"], name=it["name"], phase=phase, status=status,
                                  owner=owner, discipline=disc, reason="On hold"))
        elif (cells.get(c["priority"]) or "").lower().startswith("critical"):
            flags.append(TaskFlag(id=it["id"], name=it["name"], phase=phase, status=status,
                                  owner=owner, discipline=disc, reason="Critical priority"))

    flags.sort(key=lambda f: (-(f.days_overdue or 0), f.reason))

    order = {p: i for i, p in enumerate(_PHASE_ORDER)}
    by_phase = [
        PhaseRollup(
            phase=name, total=v["total"], done=v["done"], in_progress=v["in_progress"],
            blocked=v["blocked"], not_started=v["not_started"],
            pct_complete=round(v["done"] / v["total"] * 100) if v["total"] else 0,
        )
        for name, v in phases.items()
    ]
    by_phase.sort(key=lambda p: (order.get(p.phase, len(order)), p.phase))

    owner_rows = sorted(
        ({"owner": k, **v} for k, v in owners.items()),
        key=lambda r: (-r["open"], -r["total"], r["owner"]),
    )[:12]

    return TaskBoardOut(
        board_id=board_id,
        board_name=data["board"],
        task_count=len(items),
        totals={
            "done": done_total,
            "open": len(items) - done_total,
            "pct_complete": round(done_total / len(items) * 100) if items else 0,
            "targeted_hours": round(targeted, 1),
            "actual_hours": round(actual, 1),
            "hours_variance": round(targeted - actual, 1),
            "billable_cost": round(billable, 2),
            "actual_cost": round(actual_cost, 2),
            "flagged": len(flags),
        },
        by_phase=by_phase,
        by_status=dict(sorted(by_status.items(), key=lambda kv: -kv[1])),
        by_discipline=dict(sorted(by_discipline.items(), key=lambda kv: -kv[1])),
        by_owner=owner_rows,
        flags=flags[:40],
    )
