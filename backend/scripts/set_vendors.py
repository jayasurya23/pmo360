"""Reassign the vendor resources to a 'Vendors' discipline. Idempotent."""
from __future__ import annotations
import os, sys
BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)
import config  # noqa: F401
from db.session import get_session_factory
from db.models import TimelineResource

VENDORS = {"solvida", "gers", "finulent", "bobby", "brandon"}


def main() -> None:
    db = get_session_factory()()
    try:
        moved = []
        for r in db.query(TimelineResource).all():
            if r.name.strip().lower() in VENDORS and r.discipline != "Vendors":
                r.discipline = "Vendors"
                moved.append(r.name)
        db.commit()
        print(f"Moved to Vendors: {moved or 'none (already set / not found)'}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
