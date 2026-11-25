"""Castillo Activity ID standard.

Format:  <PHASE>-<NNNN>
    PHASE  = code of the Level 2 WBS (phase), see PHASE_CODES
    NNNN   = discipline slot + 10 x (occurrence - 1)

Discipline slots are the same in every phase, so "-1000" is always Electrical and
"-9000" is always the Review, whatever the phase:

    D30-1000  30% Electrical Design        D60-1000  60% Electrical Design
    D30-2000  30% Structural Design        D60-2000  60% Structural Design
    D30-3000  30% BESS Design              ...
    D30-9000  30% Client Review

Milestones live in the Key Milestones WBS (phase code MS):
    start milestones  MS-1000, MS-1010, ...
    finish milestones MS-9000, MS-9010, ...

Steps of 10 leave room to insert activities later without renumbering.
P6 equivalent: Project > Defaults > Auto-numbering (prefix per phase, increment 10),
saved in the Castillo project template. Discipline and Phase should ALSO be P6 global
activity codes so you can group/filter by them; the ID is for reference, not for logic.
"""
from __future__ import annotations

import re

from .model import WBS, Activity, Schedule

PHASE_CODES = {
    "key milestones": "MS",
    "milestones": "MS",
    "project management": "PM",
    "30% design": "D30",
    "60% design": "D60",
    "90% design": "D90",
    "issued for construction (ifc)": "IFC",
    "issued for construction": "IFC",
    "ifc": "IFC",
    "construction support": "CS",
    "permitting": "PER",
    "procurement": "PRC",
}

# Checked in order; first keyword found in the activity name wins.
DISCIPLINE_SLOTS = (
    ("electrical", 1000),
    ("structural", 2000),
    ("bess", 3000),
    ("civil", 4000),
    ("substation", 5000),
    ("geotech", 6000),
    ("survey", 6100),
    ("permit", 7000),
    ("review", 9000),
)
OTHER_SLOT = 8000
MILESTONE_START_SLOT = 1000
MILESTONE_FINISH_SLOT = 9000

ID_PATTERN = re.compile(r"^[A-Z0-9]{2,4}-\d{4}$")


def phase_code(wbs: WBS) -> str:
    if wbs.code:
        return wbs.code.upper()
    key = wbs.name.strip().lower()
    if key in PHASE_CODES:
        return PHASE_CODES[key]
    m = re.match(r"(\d{2})%", key)
    if m:
        return f"D{m.group(1)}"
    letters = "".join(w[0] for w in re.findall(r"[A-Za-z]+", wbs.name)).upper()
    return (letters or "X")[:3]


def discipline_slot(act: Activity) -> int:
    if act.is_milestone:
        return MILESTONE_FINISH_SLOT if act.milestone == "finish" else MILESTONE_START_SLOT
    n = act.name.lower()
    for kw, slot in DISCIPLINE_SLOTS:
        if kw in n:
            return slot
    return OTHER_SLOT


def assign_ids(schedule: Schedule, overwrite: bool = False) -> dict[str, str]:
    """Fill in Activity IDs using the Castillo standard. Returns {name: id} for logging.
    Existing IDs are kept unless overwrite=True."""
    used: set[str] = {a.activity_id for a in schedule.root.activities() if a.activity_id and not overwrite}
    assigned = {}
    for phase in schedule.root.children:
        groups = [phase] if isinstance(phase, WBS) else []
        loose = [phase] if isinstance(phase, Activity) else []
        for g in groups:
            code = phase_code(g)
            for act in g.activities():
                if act.activity_id and not overwrite:
                    continue
                slot = discipline_slot(act)
                n = slot
                while f"{code}-{n:04d}" in used:
                    n += 10
                act.activity_id = f"{code}-{n:04d}"
                used.add(act.activity_id)
                assigned[act.name] = act.activity_id
        for act in loose:  # activities directly under the project node
            if act.activity_id and not overwrite:
                continue
            n = discipline_slot(act)
            while f"MS-{n:04d}" in used:
                n += 10
            act.activity_id = f"MS-{n:04d}"
            used.add(act.activity_id)
            assigned[act.name] = act.activity_id
    return assigned


def validate_ids(schedule: Schedule) -> list[str]:
    """Return a list of problems (empty list = OK)."""
    problems, seen = [], set()
    for a in schedule.root.activities():
        if not a.activity_id:
            problems.append(f"Missing Activity ID: {a.name}")
        elif not ID_PATTERN.match(a.activity_id):
            problems.append(f"Non-standard Activity ID {a.activity_id!r}: {a.name}")
        if a.activity_id in seen:
            problems.append(f"Duplicate Activity ID {a.activity_id!r}")
        seen.add(a.activity_id)
    return problems
