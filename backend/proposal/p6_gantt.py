"""The proposal Gantt in the Castillo P6 look (the castillo_schedule package).

LOOK ONLY. The rows are exactly what ``gantt.build_gantt_rows`` already produces
for PMO 360's own Gantt — same names, same dates, same utilization-adjusted
durations, same milestone rule (a task whose adjusted duration is exactly 0 is a
diamond; "Project Closeout" is one too) — and this module only changes how they
are drawn. Deliberately NOT carried over from Proposal360's adapter: renaming
activities, generated Activity IDs and a calculated critical path. Those are
scheduling decisions, and PMO 360's scheduling stays PMO 360's.

How the flat rows become the P6 page: summary rows are WBS bands nested by their
indent (level 1 is the project), every other row is an activity under the nearest
band above it. Durations and band durations are passed through, so the package
never recounts working days on a calendar of its own.

``castillo_schedule`` is vendored unchanged from jayasurya23/proposal360
(vendor/castillo_schedule, commit 968a271); fonts and logo come from
backend/templates, the same files the old Gantt used.
"""
from __future__ import annotations

from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from typing import Optional

from castillo_schedule import WBS, Activity, Revision, Schedule, ScheduleHeader, Theme
from castillo_schedule.render import ScheduleRenderer
from castillo_schedule.theme import CLIENT_PRELIM_COLUMNS, ColumnSpec

_TEMPLATES = Path(__file__).resolve().parent.parent / "templates"
FONTS_DIR = _TEMPLATES / "fonts"
DEFAULT_LOGO = _TEMPLATES / "castillo_logo.png"

# The P6 client layout, with the Activity ID column kept but unlabelled and
# narrow: PMO 360's rows carry no activity IDs (inventing them would be new
# scheduling data, not a new look), yet the P6 bands write their names starting
# in that column and spanning into Activity Name, so dropping it would blank them.
COLUMNS = tuple(
    ColumnSpec("activity_id", "", 0.30, "left") if c.key == "activity_id" else c
    for c in CLIENT_PRELIM_COLUMNS
)


def _d(v) -> Optional[date]:
    if v is None:
        return None
    return v.date() if isinstance(v, datetime) else v


def _is_closeout(name: str) -> bool:
    return (name or "").strip().lower() == "project closeout"


def build_schedule(
    rows: list[dict],
    *,
    title: str = "Project Schedule",
    project_title: str = "",
    customer_name: str = "",
    version: str = "V1",
    project_location: str = "",
    project_state: str = "",
    project_size_mw: str = "",
    schedule_date: Optional[date] = None,
    holidays: Optional[list] = None,
) -> Schedule:
    """``build_gantt_rows`` output -> the package's Schedule, structure only."""
    project = (project_title or "").strip() or "Project"
    root = WBS(project)
    stack: list[tuple[int, WBS]] = [(-1, root)]      # (indent, band)

    def parent_for(indent: int) -> WBS:
        while len(stack) > 1 and stack[-1][0] >= indent:
            stack.pop()
        return stack[-1][1]

    pending: list[tuple[WBS, dict]] = []             # bands that may end up empty
    for r in rows:
        start, finish = _d(r.get("start")), _d(r.get("finish"))
        if start is None or finish is None:
            continue
        indent = int(r.get("indent") or 0)
        dur = r.get("dur")
        dur = int(dur) if isinstance(dur, (int, float)) else None
        parent = parent_for(indent)
        if r.get("kind") == "summary":
            band = WBS(r["name"], duration=dur)
            parent.children.append(band)
            stack.append((indent, band))
            pending.append((band, r))
            continue
        milestone = None
        if dur == 0:
            milestone = "finish" if _is_closeout(r["name"]) else "start"
        parent.children.append(Activity(
            name=r["name"], start=start, finish=finish if milestone is None else start,
            duration=0 if milestone else dur, milestone=milestone,
        ))

    # A band with nothing under it (an undated section header, or Project
    # Closeout drawn as a summary) has no span of its own in the package, which
    # takes a band's span from its activities. Draw it as what the old Gantt
    # drew: a diamond for a 0-day row, else a bar with its own dates.
    def prune(node: WBS):
        for i, child in enumerate(list(node.children)):
            if isinstance(child, WBS):
                prune(child)
                if not any(True for _ in child.activities()):
                    src = next(r for b, r in pending if b is child)
                    s, f = _d(src["start"]), _d(src["finish"])
                    ms = ("finish" if _is_closeout(child.name) else "start") if child.duration == 0 else None
                    node.children[i] = Activity(name=child.name, start=s, finish=s if ms else f,
                                                duration=0 if ms else child.duration, milestone=ms)
    prune(root)
    if not any(True for _ in root.activities()):
        raise ValueError("Nothing to draw")

    location = (project_location or "").strip()
    state = (project_state or "").strip()
    if state and location and not location.upper().endswith(state.upper()):
        location = f"{location}, {state}"
    size = (str(project_size_mw).strip() if project_size_mw else "")
    if size and not size.lower().endswith("mw"):
        size = f"{size} MW"
    today = schedule_date or date.today()
    rev = (version or "V1").strip()
    header = ScheduleHeader(
        customer=customer_name or "", project=project, location=location or state, size=size,
        title=title or "Project Schedule", schedule_date=today, revision=rev,
        revisions=[Revision(rev, today, "Issued with proposal")],
    )
    # Every row brings its own PMO 360 duration; the calendar is only used for
    # the project-level band, which PMO 360's rows do not have — counted on the
    # proposal's own holiday calendar, like every other duration in it.
    return Schedule(header=header, root=root, holidays=list(holidays or []))


def theme(logo_path: str = "") -> Theme:
    logo = Path(logo_path) if logo_path and Path(logo_path).exists() else DEFAULT_LOGO
    return Theme(fonts_dir=FONTS_DIR, logo_path=logo, columns=COLUMNS, show_critical=False)


def render_p6_gantt_bytes(rows: list[dict], *, logo_path: str = "", **header) -> bytes:
    """Every page of the P6-style Gantt as one PDF. Uses the renderer's page
    builder so the pages go to memory rather than a file, as Proposal360 does."""
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_pdf import PdfPages

    s = build_schedule(rows, **header)
    r = ScheduleRenderer(s, theme(logo_path))
    buf = BytesIO()
    n = len(r.pages)
    with PdfPages(buf, metadata={"Title": f"{s.header.title} - {s.header.project}",
                                 "Author": "Castillo Engineering"}) as pdf:
        for i, page_rows in enumerate(r.pages, 1):
            fig = r._page_figure(page_rows, i, n)
            pdf.savefig(fig)
            plt.close(fig)
    return buf.getvalue()
