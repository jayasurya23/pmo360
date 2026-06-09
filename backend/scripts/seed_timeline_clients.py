"""Seed timeline_clients from the Contracts sheet's distinct 'Company Name'
values. Idempotent — only inserts names not already present.

Usage (path optional; defaults to the Downloads copy):
    python scripts/seed_timeline_clients.py ["C:\\path\\Contracts Sheet.xlsx"]
"""
from __future__ import annotations
import os, sys
BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)
import config  # noqa: F401
import openpyxl
from db.session import get_engine, get_session_factory
from db.models import Base, TimelineClient

DEFAULT_XLSX = os.path.join(os.path.expanduser("~"), "Downloads", "Contracts Sheet.xlsx")
SKIP = {"none", "n/a", "na", "tbd", "-", ""}


def distinct_companies(path: str) -> list[str]:
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb["Contracts Sheet"] if "Contracts Sheet" in wb.sheetnames else wb[wb.sheetnames[0]]
    rows = ws.iter_rows(values_only=True)
    header = [str(c).strip() if c is not None else "" for c in next(rows)]
    ci = header.index("Company Name")
    seen: dict[str, str] = {}
    for r in rows:
        v = r[ci] if ci < len(r) else None
        if v is None:
            continue
        s = str(v).strip()
        if s and s.lower() not in SKIP:
            seen.setdefault(s.lower(), s)  # first-seen casing
    return sorted(seen.values(), key=str.lower)


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_XLSX
    companies = distinct_companies(path)
    Base.metadata.create_all(get_engine())
    db = get_session_factory()()
    try:
        have = {c.name.strip().lower() for c in db.query(TimelineClient).all()}
        added = 0
        for name in companies:
            if name.lower() not in have:
                db.add(TimelineClient(name=name))
                have.add(name.lower())
                added += 1
        db.commit()
        print(f"Clients in sheet: {len(companies)} | added {added} new | total now {len(have)}.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
