"""Seed sample data so first-run demos and tests have something to show.

Run from the backend directory:

    python -m scripts.seed
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow running as a plain script (python scripts/seed.py) too.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import init_db, session_scope
from db.models import Client, Project, ProjectAttendee


SAMPLE_CLIENT = {"name": "Heelstone", "email_domain": "heelstone.com"}
SAMPLE_PROJECT = {
    "name": "Snapdragon and Two Blues",
    "scope": "Electrical Design, Civil Design and Studies",
    "schedule_version": "V1",
}
SAMPLE_ROSTER = [
    ("Arun Ramadass", "AR", "Castillo Engineering"),
    ("Rick Castillo", "RC", "Castillo Engineering"),
    ("Manjil Puri", "MP", "Castillo Engineering"),
    ("Cheyne Matheny", "CM", "Heelstone"),
    ("Jacob Cardin", "JC", "KE Way"),
    ("Kyle Cunningham", "KC", "KE Way"),
]


def seed() -> None:
    init_db()
    with session_scope() as session:
        if session.query(Client).filter_by(name=SAMPLE_CLIENT["name"]).first():
            print(f"Already seeded — {SAMPLE_CLIENT['name']!r} exists.")
            return

        client = Client(**SAMPLE_CLIENT)
        session.add(client)
        session.flush()

        project = Project(client_id=client.id, **SAMPLE_PROJECT)
        session.add(project)
        session.flush()

        for full_name, initials, org in SAMPLE_ROSTER:
            session.add(ProjectAttendee(
                project_id=project.id,
                full_name=full_name,
                initials=initials,
                organization=org,
            ))
        print(
            f"Seeded client {client.name!r} with project "
            f"{project.name!r} and {len(SAMPLE_ROSTER)} roster members."
        )


if __name__ == "__main__":
    seed()
