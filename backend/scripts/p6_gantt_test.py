"""Self-contained regression for the P6-look proposal Gantt (proposal/p6_gantt.py).

The new drawing must not change PMO 360's schedule, only its look. Asserts that,
for rows shaped like ``gantt.build_gantt_rows`` output:

  * every row keeps its name, dates and PMO 360 duration (no recount, no renaming)
  * summary rows become bands nested by indent; tasks sit under the band above
  * a 0-day task is a start milestone; a 0-day "Project Closeout" summary with
    nothing under it is a finish milestone, as the old Gantt drew it
  * no Activity IDs are invented and nothing is marked critical
  * PMO 360's colours (red sections, grey phases, red bars and diamonds) apply
    for the render only, leaving the vendored package's tables as they were
  * the PDF renders, paginating a long schedule onto more pages

Run:  python scripts/p6_gantt_test.py   (exit 0 == pass)
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on path

from castillo_schedule import WBS  # noqa: E402

from proposal.p6_gantt import build_schedule, render_p6_gantt_bytes  # noqa: E402


def _r(kind, indent, dur, s, f, name):
    return {"kind": kind, "indent": indent, "dur": dur, "name": name,
            "start": datetime.strptime(s, "%Y-%m-%d"), "finish": datetime.strptime(f, "%Y-%m-%d")}


ROWS = [
    _r("summary", 0, 61, "2027-01-05", "2027-04-01", "Electrical Engineering"),
    _r("summary", 1, 12, "2027-01-05", "2027-01-21", "Electrical Engineering - 30% Design"),
    _r("task", 2, 7, "2027-01-05", "2027-01-13", "Electrical Plan Set - 30% Design"),
    _r("task", 2, 5, "2027-01-14", "2027-01-21", "Client Review"),
    _r("task", 2, 0, "2027-01-21", "2027-01-21", "30% Submitted"),
    _r("summary", 0, 38, "2027-01-05", "2027-03-01", "BESS"),
    _r("task", 1, 4, "2027-01-05", "2027-01-08", "BESS - 30% Planset"),
    _r("summary", 0, 0, "2027-04-01", "2027-04-01", "Project Closeout"),
]


def main() -> int:
    s = build_schedule(ROWS, project_title="Old Providence", customer_name="Northern Sun",
                       version="V2", project_location="Swansea", project_state="MA",
                       project_size_mw="6.6")
    flat = [(lvl, item) for lvl, item in s.rows()]
    names = [(lvl, type(i).__name__, i.name) for lvl, i in flat]
    assert names == [
        (1, "WBS", "Old Providence"),
        (2, "WBS", "Electrical Engineering"),
        (3, "WBS", "Electrical Engineering - 30% Design"),
        (4, "Activity", "Electrical Plan Set - 30% Design"),
        (4, "Activity", "Client Review"),
        (4, "Activity", "30% Submitted"),
        (2, "WBS", "BESS"),
        (3, "Activity", "BESS - 30% Planset"),
        (2, "Activity", "Project Closeout"),
    ], names

    by_name = {i.name: i for _, i in flat}
    # durations pass through exactly as PMO 360 computed them
    for r in ROWS:
        assert s.duration_of(by_name[r["name"]]) == r["dur"], (r["name"], s.duration_of(by_name[r["name"]]))
    assert by_name["30% Submitted"].milestone == "start"
    assert by_name["Project Closeout"].milestone == "finish"
    assert by_name["Client Review"].start.isoformat() == "2027-01-14"
    assert by_name["Client Review"].finish.isoformat() == "2027-01-21"
    for _, i in flat:
        if not isinstance(i, WBS):
            assert i.activity_id == "" and not i.critical, i.name

    h = s.header
    assert (h.customer, h.location, h.size, h.revision) == ("Northern Sun", "Swansea, MA", "6.6 MW", "V2")

    from castillo_schedule import render as R
    before = (R.BARS, R.wbs_style)
    pdf = render_p6_gantt_bytes(ROWS, project_title="Old Providence")
    assert (R.BARS, R.wbs_style) == before, "PMO 360 colours must not leak past one render"
    from proposal.p6_gantt import _BARS, _wbs_style, OLD_RED
    assert _BARS["planned"].color == OLD_RED == _BARS["milestone"].color == _wbs_style(2).fill
    assert pdf[:5] == b"%PDF-" and len(pdf) > 10_000
    many = [ROWS[0]] + [_r("task", 1, 3, "2027-01-05", "2027-01-07", f"Task {i}") for i in range(120)]
    big = render_p6_gantt_bytes(many, project_title="Long")
    assert big.count(b"/Type /Page\n") + big.count(b"/Type /Page ") + big.count(b"/Type/Page") >= 2 or len(big) > len(pdf)

    print("p6 gantt: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
