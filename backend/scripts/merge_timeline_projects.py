"""Merge near-duplicate timeline projects the source created into one canonical
project each: reassign every member's assignments to the canonical, set its
client, then delete the now-empty duplicates. Idempotent.

Dry-run by default; pass --apply to write.
    python scripts/merge_timeline_projects.py [--apply]
"""
from __future__ import annotations
import os, sys
BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)
import config  # noqa: F401
from db.session import get_session_factory
from db.models import TimelineProject, TimelineAssignment

# Each group: canonical display name, client, and the member names (any case)
# that should collapse into it.
GROUPS = [
    {
        "canonical": "E-Light",
        "client": "E Light Electric",
        "members": [
            "e-light", "elight",
            "e-light portfolio (raven, waxwing, gonzo and trigo) &beloit",
        ],
    },
    {
        "canonical": "Nesler / E1300",
        "client": "Utopian Power",
        "members": ["nesler", "e1300", "nesler & e1300", "nesler / e1300"],
    },
]


def main() -> None:
    apply = "--apply" in sys.argv
    db = get_session_factory()()
    try:
        for g in GROUPS:
            members = [p for p in db.query(TimelineProject).all()
                       if p.name.strip().lower() in g["members"]]
            if not members:
                print(f"[{g['canonical']}] no members found — skip")
                continue
            # canonical = an existing project already named canonical, else the first member.
            canon = next((p for p in members if p.name.strip().lower() == g["canonical"].lower()), members[0])
            canon.name = g["canonical"]
            canon.client = g["client"]
            moved = 0
            removed = []
            for p in members:
                if p.id == canon.id:
                    continue
                for a in db.query(TimelineAssignment).filter_by(timeline_project_id=p.id).all():
                    a.timeline_project_id = canon.id
                    moved += 1
                removed.append(p.name)
                if apply:
                    db.delete(p)
            print(f"[{g['canonical']}] client={g['client']!r} | merged {len(removed)} dups "
                  f"({', '.join(removed) or 'none'}) | reassigned {moved} assignments")
        if apply:
            db.commit()
        print("APPLIED" if apply else "DRY-RUN (pass --apply to write)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
