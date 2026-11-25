"""Data model and input adapters for the Castillo schedule renderer.

The renderer only understands these classes. Whatever your existing code produces
(hard-coded lists, Excel, CSV, a P6 XER export), convert it with `from_records()`
or build the classes directly. Keep the adapter thin: no styling decisions here.
"""
from __future__ import annotations

import csv
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Union

import numpy as np

DATE_INPUT_FORMATS = ("%Y-%m-%d", "%m/%d/%y", "%m/%d/%Y", "%d-%b-%y", "%d-%b-%Y")


def parse_date(value) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = str(value).strip().rstrip("A* ").strip()  # tolerate P6 "A" / "*" flags
    for fmt in DATE_INPUT_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    raise ValueError(f"Unrecognized date: {value!r}")


@dataclass
class Link:
    """A predecessor relationship. ref = the predecessor's key, Activity ID or (unique) name."""
    ref: str
    type: str = "FS"       # FS | SS | FF | SF
    lag: int = 0           # working days (negative = lead)


# Lag is only read after a type, so IDs like "D30-1000" are never mistaken for a lag.
_LINK_RE = re.compile(r"^(?P<ref>.+?)(?::(?P<type>FS|SS|FF|SF)(?P<lag>[+-]\d+)?)?$", re.I)


def parse_links(value) -> list:
    """Accepts None, a list of Link/dict/str, or a string "A1; A2:SS+2; A3:FF-1"."""
    if value in (None, ""):
        return []
    items = value if isinstance(value, (list, tuple)) else re.split(r"[;,]", str(value))
    links = []
    for it in items:
        if isinstance(it, Link):
            links.append(it)
        elif isinstance(it, dict):
            links.append(Link(str(it.get("ref") or it.get("id") or it.get("activity_id")).strip(),
                              str(it.get("type", "FS")).upper(), int(it.get("lag", 0) or 0)))
        elif str(it).strip():
            m = _LINK_RE.match(str(it).strip())
            links.append(Link(m["ref"].strip(), (m["type"] or "FS").upper(), int(m["lag"] or 0)))
    for ln in links:
        if ln.type not in ("FS", "SS", "FF", "SF"):
            raise ValueError(f"Unknown relationship type {ln.type!r} for predecessor {ln.ref!r}")
    return links


@dataclass
class Activity:
    name: str
    start: date
    finish: date
    activity_id: str = ""
    duration: int | None = None        # working days; computed from calendar if None
    critical: bool = False
    milestone: str | None = None       # None | "start" | "finish"
    total_float: int | None = None
    key: str = ""                      # your tool's own task identifier (optional)
    predecessors: list = field(default_factory=list)   # list[Link]

    @property
    def is_milestone(self) -> bool:
        return self.milestone is not None


@dataclass
class WBS:
    name: str
    code: str = ""
    children: list = field(default_factory=list)   # WBS | Activity, in display order
    duration: int | None = None                      # optional override

    def activities(self) -> Iterable[Activity]:
        for c in self.children:
            if isinstance(c, WBS):
                yield from c.activities()
            else:
                yield c

    @property
    def start(self) -> date:
        return min(a.start for a in self.activities())

    @property
    def finish(self) -> date:
        return max(a.finish for a in self.activities())


@dataclass
class Revision:
    rev: str
    date: date
    description: str
    by: str = ""
    checked: str = ""


@dataclass
class ScheduleHeader:
    customer: str
    project: str
    location: str = ""
    size: str = ""
    project_id: str = ""
    title: str = "Preliminary Project Schedule"
    schedule_date: date = field(default_factory=date.today)
    revision: str = "R00"
    revisions: list = field(default_factory=list)   # list[Revision]


@dataclass
class Schedule:
    header: ScheduleHeader
    root: WBS                                        # Level 1 = the project
    holidays: list = field(default_factory=list)     # list[date]
    critical_basis: str = ""                         # set by apply_cpm(); printed in the Notes box

    # ---- calendar -------------------------------------------------------
    def workdays(self, start: date, finish: date) -> int:
        """Working days from start to finish inclusive (Mon-Fri, holidays excluded)."""
        return int(np.busday_count(start, finish + timedelta(days=1),
                                   holidays=[np.datetime64(h) for h in self.holidays]))

    def duration_of(self, item: Union[Activity, WBS]) -> int:
        if item.duration is not None:
            return item.duration
        if isinstance(item, Activity) and item.is_milestone:
            return 0
        return self.workdays(item.start, item.finish)

    # ---- flatten for drawing -------------------------------------------
    def rows(self):
        """Yield (level, item) in P6 display order. Level 1 = project WBS.
        Activities report the level of their parent WBS + 1."""
        def walk(node: WBS, level: int):
            yield level, node
            for c in node.children:
                if isinstance(c, WBS):
                    yield from walk(c, level + 1)
                else:
                    yield level + 1, c
        yield from walk(self.root, 1)


# --------------------------------------------------------------------------
# Adapters
# --------------------------------------------------------------------------
def _truthy(v) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "y", "x")


def from_records(header: ScheduleHeader, records: Iterable[dict], holidays=()) -> Schedule:
    """Build a Schedule from flat activity records.

    Each record needs: wbs (list of names or "Project > Phase" string), name, start, finish.
    Optional: activity_id, duration, critical, milestone ("start"/"finish"), total_float,
              key (your own task id), predecessors (see parse_links).
    The first wbs element is the Level 1 (project) node. Display order = record order.
    """
    root: WBS | None = None
    index: dict[tuple, WBS] = {}
    for r in records:
        path = r["wbs"]
        if isinstance(path, str):
            path = [p.strip() for p in path.split(">") if p.strip()]
        if root is None:
            root = WBS(path[0])
            index[(path[0],)] = root
        if path[0] != root.name:
            raise ValueError(f"All records must share one Level 1 WBS; got {path[0]!r}")
        parent = root
        for depth in range(2, len(path) + 1):
            key = tuple(path[:depth])
            if key not in index:
                node = WBS(path[depth - 1])
                parent.children.append(node)
                index[key] = node
            parent = index[key]
        ms = (r.get("milestone") or "").strip().lower() or None
        dur = r.get("duration")
        parent.children.append(Activity(
            name=r["name"],
            start=parse_date(r["start"]),
            finish=parse_date(r["finish"]),
            activity_id=(r.get("activity_id") or "").strip(),
            duration=int(dur) if dur not in (None, "") else None,
            critical=_truthy(r.get("critical", False)),
            milestone=ms,
            total_float=int(r["total_float"]) if r.get("total_float") not in (None, "") else None,
            key=str(r.get("key") or "").strip(),
            predecessors=parse_links(r.get("predecessors")),
        ))
    if root is None:
        raise ValueError("No activity records supplied")
    return Schedule(header, root, [parse_date(h) for h in holidays])


def header_from_dict(d: dict) -> ScheduleHeader:
    revs = [Revision(x["rev"], parse_date(x["date"]), x.get("description", ""),
                     x.get("by", ""), x.get("checked", "")) for x in d.get("revisions", [])]
    return ScheduleHeader(
        customer=d["customer"], project=d["project"], location=d.get("location", ""),
        size=d.get("size", ""), project_id=d.get("project_id", ""),
        title=d.get("title", "Preliminary Project Schedule"),
        schedule_date=parse_date(d["schedule_date"]) if d.get("schedule_date") else date.today(),
        revision=d.get("revision", "R00"), revisions=revs,
    )


def load_json(path) -> Schedule:
    """Input file format: see examples/mesquite_flats.json."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return from_records(header_from_dict(data["header"]), data["activities"], data.get("holidays", []))


def load_csv(activities_csv, header_json, holidays=()) -> Schedule:
    """Activities in a CSV (columns: wbs,key,activity_id,name,duration,start,finish,predecessors,critical,milestone)
    with the header block in a small JSON file."""
    with open(activities_csv, newline="", encoding="utf-8-sig") as f:
        records = list(csv.DictReader(f))
    hdr = json.loads(Path(header_json).read_text(encoding="utf-8"))
    return from_records(header_from_dict(hdr["header"] if "header" in hdr else hdr),
                        records, holidays or hdr.get("holidays", []))
