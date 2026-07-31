"""Offline self-test for the monday.com integration.

Exercises the parser, the KPI maths and the client's error handling with **no
network access** — the fixtures below are real payloads recorded from the
Nesler board (18424062924), including the malformed ones, plus synthetic
completed tasks that the live board does not yet contain.

Matches the repo's existing convention of runnable scripts rather than a
pytest suite (see ``full_coverage_test.py``); no new dependency needed.

Run from the backend dir:
    cd backend
    python -m scripts.monday_selftest
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from integrations.monday.client import (  # noqa: E402
    MondayAuthError, MondayClient, MondayQueryError, MondayRateLimitError,
)
from integrations.monday.columns import (  # noqa: E402
    coerce_date, coerce_float, coerce_labels, coerce_timeline, parse_task,
)
from integrations.monday.kpis import compute_board_kpis  # noqa: E402

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))
        FAILURES.append(label)


# ---------------------------------------------------------------- fixtures
# Verbatim from the live board — every awkward value here was actually
# returned by monday, not invented.
REAL_ITEMS = [
    {
        # Completion date stamped while status is still "Not Started" (bulk
        # import artifact), and a formula column returning the STRING "null".
        "id": "12376363166",
        "name": "Deposit & Contract Signed",
        "url": "https://castillope.monday.com/boards/18424062924/pulses/12376363166",
        "group": {"id": "group_mm5pnkqb", "title": "Import"},
        "column_values": {
            "dropdown_mm4jygv4": "PMO",
            "project_owner": None,
            "project_status": "Not Started",
            "project_timeline": "2026-04-24 - 2026-04-27",
            "project_duration": "2.0",
            "project_planned_effort": None,
            "project_task_completion_date": "2026-06-26",
            "color_mm4j79qe": "Project Initiation",
            "date_mm4kzjjk": "2026-04-24",
            "formula_mm4k8230": "63",
            "formula_mm4kqacx": "0",
            "formula_mm4k4zg5": "-61",
            "formula_mm4kf7zp": "0",
            "formula_mm4k6jkt": "0",
            "formula_mm4kysj8": "0",
            "color_mm522b42": None,
            "date_mm53dfe4": None,
            "date_mm53twpc": None,
            "formula_mm536xnp": "",
        },
    },
    {
        # Multi-select discipline; formula columns returning literal "null".
        "id": "12376363168",
        "name": "Kickoff Meeting",
        "group": {"title": "Import"},
        "column_values": {
            "dropdown_mm4jygv4": "PMO, Civil, Electrical",
            "project_status": "Not Started",
            "project_timeline": "2026-04-24 - 2026-04-24",
            "project_duration": "0.125",
            "project_planned_effort": "0.0",
            "project_task_completion_date": None,
            "color_mm4j79qe": "Project Initiation",
            "date_mm4kzjjk": "2026-04-24",
            "formula_mm4k8230": "null",
            "formula_mm4k4zg5": "null",
            "formula_mm536xnp": "",
        },
    },
    {
        # INVERTED timeline: end (05-08) precedes start (05-11).
        "id": "12376363170",
        "name": "Electrical Start",
        "group": {"title": "Import"},
        "column_values": {
            "dropdown_mm4jygv4": "Electrical",
            "project_status": "Not Started",
            "project_timeline": "2026-05-11 - 2026-05-08",
            "project_duration": "1",
            "date_mm4kzjjk": "2026-05-11",
            "color_mm4j79qe": "Project Initiation",
            "formula_mm4k8230": "null",
            "formula_mm536xnp": "",
        },
    },
]

# The live board has zero completed tasks, so the completion / on-time / QC
# paths need synthetic rows to be exercised at all.
SYNTHETIC_ITEMS = [
    {
        "id": "9001",
        "name": "60% Electrical Drawings",
        "group": {"title": "60% Design"},
        "column_values": {
            "dropdown_mm4jygv4": "Electrical",
            "project_status": "Completed",
            "color_mm4j79qe": "60%",
            "project_timeline": "2026-06-01 - 2026-06-10",
            "date_mm4kzjjk": "2026-06-01",
            "project_task_completion_date": "2026-06-08",   # 2 days early
            "project_duration": "9",
            "formula_mm4k8230": "7",
            "formula_mm4k4zg5": "2",
            "project_planned_effort": "40",
            "formula_mm4kqacx": "36",
            "formula_mm4kysj8": "4",
            "formula_mm4kf7zp": "6000",
            "formula_mm4k6jkt": "5400",
            "color_mm522b42": "QC Complete",
            "date_mm53dfe4": "2026-06-08",
            "date_mm53twpc": "2026-06-11",
            "formula_mm536xnp": "3",
        },
    },
    {
        "id": "9002",
        "name": "60% Civil Grading Plan",
        "group": {"title": "60% Design"},
        "column_values": {
            "dropdown_mm4jygv4": "Civil",
            "project_status": "Completed",
            "color_mm4j79qe": "60%",
            "project_timeline": "2026-06-01 - 2026-06-10",
            "date_mm4kzjjk": "2026-06-01",
            "project_task_completion_date": "2026-06-15",   # 5 days late
            "project_duration": "9",
            "formula_mm4k8230": "14",
            "formula_mm4k4zg5": "-5",
            "project_planned_effort": "30",
            "formula_mm4kqacx": "45",
            "formula_mm4kysj8": "-15",
            "formula_mm4kf7zp": "4500",
            "formula_mm4k6jkt": "6750",
            "color_mm522b42": "QC Complete",
            "date_mm53dfe4": "2026-06-15",
            "date_mm53twpc": "2026-06-22",
            "formula_mm536xnp": "7",
        },
    },
    {
        "id": "9003",
        "name": "90% Structural Review",
        "group": {"title": "90% / IFP"},
        "column_values": {
            "dropdown_mm4jygv4": "Structural",
            "project_status": "In Progress",
            "color_mm4j79qe": "90%",
            "project_timeline": "2026-07-01 - 2026-07-15",
            "date_mm4kzjjk": "2026-07-01",
            "project_planned_effort": "20",
            "formula_mm4kqacx": "8",
            "color_mm522b42": "In QC",
        },
    },
    {
        # N/A must be excluded from completion ratios entirely.
        "id": "9004",
        "name": "Battery Storage Layout (not in scope)",
        "group": {"title": "90% / IFP"},
        "column_values": {
            "dropdown_mm4jygv4": "Electrical",
            "project_status": "N/A",
            "color_mm4j79qe": "90%",
        },
    },
    {
        # Overdue: planned end in the past, still open.
        "id": "9005",
        "name": "IFC Stamp Package",
        "group": {"title": "IFC"},
        "column_values": {
            "dropdown_mm4jygv4": "Electrical",
            "project_status": "Requires action",
            "color_mm4j79qe": "IFC",
            "project_timeline": "2026-05-01 - 2026-05-20",
            "date_mm4kzjjk": "2026-05-01",
        },
    },
]


# ---------------------------------------------------------------- transports
class _Resp:
    def __init__(self, body, status_code=200, headers=None):
        self._body = body
        self.status_code = status_code
        self.headers = headers or {}

    def json(self):
        return self._body


class _ScriptedTransport:
    """Replays a queued list of responses; records the requests it saw."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def post(self, url, *, json, headers, timeout):
        self.calls.append({"url": url, "json": json, "headers": headers})
        return self._responses.pop(0)


# ---------------------------------------------------------------- tests
def test_coercion() -> None:
    print("\nValue coercion (the traps in monday's payloads)")
    check("empty string -> None", coerce_float("") is None)
    check('literal "null" -> None', coerce_float("null") is None)
    check("None -> None", coerce_float(None) is None)
    check("float-as-string parses", coerce_float("2.0") == 2.0)
    check("fractional days parse", coerce_float("0.125") == 0.125)
    check("negative variance parses", coerce_float("-61") == -61.0)
    check("currency prefix stripped", coerce_float("$6,000") == 6000.0)
    check("zero survives (not None)", coerce_float("0") == 0.0)

    check("date parses", coerce_date("2026-06-26") == date(2026, 6, 26))
    check("blank date -> None", coerce_date("") is None)

    check(
        "multi-select splits",
        coerce_labels("PMO, Civil, Electrical") == ["PMO", "Civil", "Electrical"],
    )
    check("single label", coerce_labels("Electrical") == ["Electrical"])
    check("blank labels -> []", coerce_labels(None) == [])

    start, end = coerce_timeline("2026-04-24 - 2026-04-27")
    check(
        "timeline range parses",
        start == date(2026, 4, 24) and end == date(2026, 4, 27),
    )
    inv_start, inv_end = coerce_timeline("2026-05-11 - 2026-05-08")
    check(
        "INVERTED timeline discarded",
        inv_start is None and inv_end is None,
        "end-before-start would yield a negative duration",
    )


def test_parsing() -> None:
    print("\nTask parsing")
    tasks = [parse_task(item, "18424062924") for item in REAL_ITEMS]

    deposit = tasks[0]
    check("name parsed", deposit.name == "Deposit & Contract Signed")
    check("group carried", deposit.group_title == "Import")
    check("phase parsed", deposit.phase == "Project Initiation")
    check(
        "completion date present",
        deposit.completion_date == date(2026, 6, 26),
    )
    check(
        "status beats completion date for is_done",
        deposit.is_done is False,
        "status is 'Not Started' — trusting the date would report it delivered",
    )
    check(
        "contradiction blocks on-time maths",
        deposit.finished_on_time is None,
    )

    kickoff = tasks[1]
    check(
        "multi-discipline parsed",
        kickoff.disciplines == ["PMO", "Civil", "Electrical"],
    )
    check(
        '"null" formula -> None, not 0',
        kickoff.actual_duration_days is None,
    )

    electrical = tasks[2]
    check(
        "inverted timeline yields no end date",
        electrical.end_date is None,
    )
    check(
        "explicit start date still recovered",
        electrical.start_date == date(2026, 5, 11),
    )

    na_task = parse_task(SYNTHETIC_ITEMS[3], "b")
    check("N/A task is not countable", na_task.is_countable is False)

    # The raw GraphQL API returns a list, the MCP tools return a dict.
    list_shaped = {
        "id": "1", "name": "List shape",
        "column_values": [
            {"id": "project_status", "text": "Completed"},
            {"id": "dropdown_mm4jygv4", "text": "Civil"},
        ],
    }
    parsed = parse_task(list_shaped, "b")
    check(
        "list-shaped column_values also parse",
        parsed.is_done and parsed.disciplines == ["Civil"],
    )


def test_kpis_with_no_execution_data() -> None:
    print("\nKPIs — board populated but no work started (today's real state)")
    tasks = [parse_task(i, "18424062924") for i in REAL_ITEMS]
    kpis = compute_board_kpis(tasks, board_id="18424062924", today=date(2026, 7, 31))

    check("all tasks counted", kpis.schedule.total_tasks == 3)
    check("nothing completed", kpis.schedule.completed_tasks == 0)
    check(
        "has_execution_data is False",
        kpis.has_execution_data is False,
        "UI must show 'not started', not a wall of zeros",
    )
    check(
        "on-time rate is None, not 0.0",
        kpis.schedule.on_time_rate.value is None,
        "0.0 would read as 'everything late'",
    )
    check(
        "variance sample excludes 'null' rows",
        kpis.schedule.avg_schedule_variance_days.sample_size == 1,
    )
    check(
        "QC cycle is None with no QC records",
        kpis.qc.avg_cycle_days.value is None,
    )
    check(
        "data-quality flags the stamped-but-unstarted row",
        any("Not Started" in note for note in kpis.data_quality),
    )


def test_kpis_with_execution_data() -> None:
    print("\nKPIs — with completed work (synthetic)")
    tasks = [parse_task(i, "b") for i in SYNTHETIC_ITEMS]
    kpis = compute_board_kpis(tasks, board_id="b", today=date(2026, 7, 31))
    sched, qc, effort = kpis.schedule, kpis.qc, kpis.effort

    check("execution data detected", kpis.has_execution_data is True)
    check("completed counted", sched.completed_tasks == 2)
    check(
        "N/A excluded from denominator",
        sched.countable_tasks == 4,
        f"got {sched.countable_tasks}, expected 4 of 5",
    )
    check(
        "completion rate = 2/4",
        sched.completion_rate.value == 0.5,
        f"got {sched.completion_rate.value}",
    )
    check(
        "on-time rate = 1/2 (one early, one late)",
        sched.on_time_rate.value == 0.5,
        f"got {sched.on_time_rate.value}",
    )
    # Two: the IFC package (planned end 2026-05-20, still blocked) and the
    # 90% review (planned end 2026-07-15, still in progress) — both past due
    # relative to the pinned "today" of 2026-07-31.
    check(
        "overdue tasks detected",
        sched.overdue_tasks == 2,
        f"got {sched.overdue_tasks}",
    )
    check("in-progress counts 'In Progress' and 'In QC'", sched.in_progress_tasks == 1)
    check("blocked counts 'Requires action'", sched.blocked_tasks == 1)

    check(
        "avg schedule variance = (2 + -5)/2 = -1.5",
        sched.avg_schedule_variance_days.value == -1.5,
        f"got {sched.avg_schedule_variance_days.value}",
    )
    check("phase breakdown present", "60%" in sched.by_phase)
    check(
        "multi-discipline task counted under each",
        "Electrical" in sched.by_discipline and "Civil" in sched.by_discipline,
    )

    check(
        "QC cycle avg = (3 + 7)/2 = 5",
        qc.avg_cycle_days.value == 5.0,
        f"got {qc.avg_cycle_days.value}",
    )
    check("QC complete counted", qc.tasks_qc_complete == 2)

    check(
        "planned hours summed = 90",
        effort.planned_hours_total.value == 90.0,
        f"got {effort.planned_hours_total.value}",
    )
    check(
        "actual hours summed = 89",
        effort.actual_hours_total.value == 89.0,
        f"got {effort.actual_hours_total.value}",
    )
    check(
        "cost ratio = 12150/10500",
        abs((effort.cost_ratio or 0) - (12150 / 10500)) < 1e-9,
        f"got {effort.cost_ratio}",
    )
    # 3 of the 5 tasks carry Targeted Hours — the measure must report that
    # denominator rather than implying it summed the whole board.
    check(
        "coverage reported on thin samples",
        effort.planned_hours_total.population == 5
        and effort.planned_hours_total.sample_size == 3,
        f"population={effort.planned_hours_total.population} "
        f"sample={effort.planned_hours_total.sample_size}",
    )
    check(
        "thin sample flagged low-confidence",
        sched.on_time_rate.is_low_confidence is True,
    )


def test_client_error_handling() -> None:
    print("\nClient error handling")

    # monday returns HTTP 200 with an errors array — the trap that turns a
    # failed query into a silent "zero".
    transport = _ScriptedTransport([
        _Resp({"errors": [{"message": "Board not found",
                           "extensions": {"code": "INVALID_BOARD_ID"}}]})
    ])
    client = MondayClient("tok", api_url="u", api_version="v", max_retries=0,
                          transport=transport, sleep=lambda s: None)
    try:
        client.execute("query {}")
        check("HTTP 200 + errors raises", False, "no exception raised")
    except MondayQueryError:
        check("HTTP 200 + errors raises MondayQueryError", True)
    except Exception as exc:  # noqa: BLE001
        check("HTTP 200 + errors raises MondayQueryError", False, repr(exc))

    # 401 -> auth error, no retry.
    transport = _ScriptedTransport([_Resp({}, status_code=401)])
    client = MondayClient("tok", api_url="u", api_version="v", max_retries=3,
                          transport=transport, sleep=lambda s: None)
    try:
        client.execute("query {}")
        check("401 raises", False)
    except MondayAuthError:
        check("401 raises MondayAuthError", True)
        check("401 is not retried", len(transport.calls) == 1,
              f"made {len(transport.calls)} calls")

    # Complexity budget: retried, then succeeds.
    slept: list[float] = []
    transport = _ScriptedTransport([
        _Resp({"errors": [{"message": "Complexity budget exhausted",
                           "extensions": {"code": "COMPLEXITY_BUDGET_EXHAUSTED"}}]},
              headers={"Retry-After": "7"}),
        _Resp({"data": {"boards": []}}),
    ])
    client = MondayClient("tok", api_url="u", api_version="v", max_retries=2,
                          transport=transport, sleep=slept.append)
    result = client.execute("query {}")
    check("complexity error retried then succeeded", result == {"boards": []})
    check("honoured Retry-After of 7s", slept == [7.0], f"slept {slept}")

    # Retries exhausted -> raises rate-limit error.
    transport = _ScriptedTransport([_Resp({}, status_code=429)] * 3)
    client = MondayClient("tok", api_url="u", api_version="v", max_retries=2,
                          transport=transport, sleep=lambda s: None)
    try:
        client.execute("query {}")
        check("exhausted retries raise", False)
    except MondayRateLimitError:
        check("exhausted retries raise MondayRateLimitError", True)

    # Auth header + pinned API version.
    transport = _ScriptedTransport([_Resp({"data": {"ok": 1}})])
    client = MondayClient("secret-token", api_url="https://api.monday.com/v2",
                          api_version="2025-01", transport=transport,
                          sleep=lambda s: None)
    client.execute("query {}")
    sent = transport.calls[0]["headers"]
    check("Authorization header set", sent.get("Authorization") == "secret-token")
    check("API-Version pinned", sent.get("API-Version") == "2025-01")


def test_sync_round_trip() -> None:
    """Full path: fake API -> cache tables -> KPIs read back from cache."""
    print("\nSync round-trip (in-memory SQLite, fake transport)")

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from db.models import (
        Base, Client, MondayBoardLink, MondayKpiSnapshot, MondayTaskSnapshot,
        Project,
    )
    from integrations.monday.sync import cached_tasks, sync_board

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()

    client_row = Client(name="Self-test Client")
    db.add(client_row)
    db.flush()
    project = Project(client_id=client_row.id, name="Self-test Portfolio")
    db.add(project)
    db.flush()
    link = MondayBoardLink(
        project_id=project.id, board_id="18424062924", kind="schedule",
    )
    db.add(link)
    db.flush()

    # Two pages, then the board metadata query — mirrors real pagination.
    all_items = REAL_ITEMS + SYNTHETIC_ITEMS
    transport = _ScriptedTransport([
        _Resp({"data": {"boards": [{
            "id": "18424062924", "name": "Nesler", "items_count": len(all_items),
            "workspace": {"id": "14604029", "name": "PMO - Project Management"},
        }]}}),
        _Resp({"data": {"boards": [{
            "id": "18424062924", "name": "Nesler",
            "items_page": {"cursor": "CURSOR1", "items": all_items[:4]},
        }]}}),
        _Resp({"data": {"boards": [{
            "id": "18424062924", "name": "Nesler",
            "items_page": {"cursor": None, "items": all_items[4:]},
        }]}}),
    ])
    api = MondayClient("tok", api_url="u", api_version="2025-01",
                       transport=transport, sleep=lambda s: None)

    kpis = sync_board(db, link, client=api)
    db.commit()

    check("board name captured from API", link.board_name == "Nesler")
    check(
        "all pages pulled",
        link.last_sync_task_count == len(all_items),
        f"got {link.last_sync_task_count} of {len(all_items)}",
    )
    check("sync timestamp stamped", link.last_synced_at is not None)
    check("no error recorded", link.last_sync_error is None)

    rows = db.query(MondayTaskSnapshot).filter_by(board_link_id=link.id).all()
    check("tasks cached", len(rows) == len(all_items), f"got {len(rows)}")

    multi = next(r for r in rows if r.name == "Kickoff Meeting")
    check(
        "multi-select persisted as JSON list",
        multi.disciplines_json == ["PMO", "Civil", "Electrical"],
    )
    nulled = next(r for r in rows if r.name == "Electrical Start")
    check(
        "inverted timeline stored as NULL end_date",
        nulled.end_date is None,
    )
    check(
        '"null" formula stored as NULL, not 0',
        nulled.actual_duration_days is None,
    )

    trend = db.query(MondayKpiSnapshot).filter_by(board_link_id=link.id).all()
    check("KPI trend row written", len(trend) == 1)
    check(
        "trend row carries the rollup",
        trend[0].completed_tasks == kpis.schedule.completed_tasks,
    )
    check("trend row keeps full payload", bool(trend[0].payload_json))

    # Re-syncing the same day must overwrite, not duplicate.
    transport2 = _ScriptedTransport([
        _Resp({"data": {"boards": [{"id": "18424062924", "name": "Nesler",
                                    "items_count": 1, "workspace": {}}]}}),
        _Resp({"data": {"boards": [{"id": "18424062924", "name": "Nesler",
                                    "items_page": {"cursor": None,
                                                   "items": SYNTHETIC_ITEMS[:1]}}]}}),
    ])
    api2 = MondayClient("tok", api_url="u", api_version="2025-01",
                        transport=transport2, sleep=lambda s: None)
    sync_board(db, link, client=api2)
    db.commit()

    check(
        "re-sync replaces cache wholesale (deleted tasks disappear)",
        db.query(MondayTaskSnapshot).filter_by(board_link_id=link.id).count() == 1,
    )
    check(
        "same-day re-sync overwrites trend row, not duplicates",
        db.query(MondayKpiSnapshot).filter_by(board_link_id=link.id).count() == 1,
    )

    restored = cached_tasks(db, link)
    check(
        "cache rehydrates into MondayTask",
        len(restored) == 1 and restored[0].is_done,
    )

    # A failing refresh must record the error and re-raise.
    failing = _ScriptedTransport([
        _Resp({"errors": [{"message": "Board not found",
                           "extensions": {"code": "INVALID_BOARD_ID"}}]})
    ])
    api3 = MondayClient("tok", api_url="u", api_version="2025-01", max_retries=0,
                        transport=failing, sleep=lambda s: None)
    try:
        sync_board(db, link, client=api3)
        check("failed sync raises", False)
    except MondayQueryError:
        check("failed sync raises MondayQueryError", True)
        check(
            "failure recorded on the link",
            bool(link.last_sync_error),
            "a silently-stale dashboard is worse than a visible error",
        )

    db.close()


def main() -> int:
    print("=" * 66)
    print("monday.com integration self-test (offline — no network)")
    print("=" * 66)

    test_coercion()
    test_parsing()
    test_kpis_with_no_execution_data()
    test_kpis_with_execution_data()
    test_client_error_handling()
    test_sync_round_trip()

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s):")
        for name in FAILURES:
            print(f"  - {name}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
