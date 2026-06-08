"""One-off: convert existing OOO/PTO/holiday *assignments* into time-off
blocks (the new model), preserving all other timeline edits. Idempotent.

Run from backend dir (local or with prod DATABASE_URL + LOCAL_DEV_MODE=false):
    python scripts/convert_ooo_to_timeoff.py
"""
from __future__ import annotations

import os
import sys

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

import config  # noqa: F401
from db.session import get_engine, get_session_factory
from db.models import (
    Base, TimelineProject, TimelineAssignment, TimelineTimeOff,
)

TIMEOFF = {"ooo", "out of office", "pto", "vacation", "holiday", "out", "leave"}


def is_timeoff(text: str | None) -> bool:
    n = (text or "").strip().lower()
    return n in TIMEOFF or n.startswith("ooo")


def main() -> None:
    Base.metadata.create_all(get_engine())
    db = get_session_factory()()
    try:
        proj_name = {p.id: p.name for p in db.query(TimelineProject).all()}
        converted = skipped = 0
        for a in db.query(TimelineAssignment).all():
            label = a.label or proj_name.get(a.timeline_project_id)
            if not is_timeoff(label):
                continue
            if a.resource_id is None:
                db.delete(a); skipped += 1; continue
            db.add(TimelineTimeOff(
                resource_id=a.resource_id,
                start_date=a.start_date, end_date=a.end_date,
                reason=(label or "OOO").strip().upper()[:80],
            ))
            db.delete(a)
            converted += 1
        db.flush()
        # drop now-empty OOO-named projects
        removed_projects = 0
        for p in db.query(TimelineProject).all():
            if is_timeoff(p.name) and not p.assignments:
                db.delete(p); removed_projects += 1
        db.commit()
        print(f"Converted {converted} OOO assignments -> time-off, "
              f"removed {removed_projects} empty OOO projects, skipped {skipped} unassigned.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
