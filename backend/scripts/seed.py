"""Seed sample data so first-run demos and tests have something to show.

Run from the backend directory:

    python -m scripts.seed
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

# Allow running as a plain script (python scripts/seed.py) too.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import init_db, session_scope
from db.models import (
    Client, Project, ProjectAttendee, Meeting, MeetingAttendee, AgendaItem,
    DiscussionPoint, ActionItem, Deliverable, MeetingDeliverable,
)


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


def _seed_sample_meeting(session, project_id: int):
    """Create one fully-populated meeting so the Preview / History pages
    have something to render on a fresh install."""
    meeting_date = date.today() - timedelta(days=7)
    meeting = Meeting(
        project_id=project_id,
        meeting_date=meeting_date,
        title=f"Weekly coordination — {meeting_date.isoformat()}",
        raw_notes="(sample seed meeting — replace with real notes)",
        stage="draft",
        schedule_version_at_meeting="V1",
        closing_remarks=(
            "Thank you to everyone for attending this meeting. "
            "Your time is very much appreciated."
        ),
    )
    session.add(meeting)
    session.flush()

    # Attendees
    for full_name, initials, org in SAMPLE_ROSTER[:4]:
        session.add(MeetingAttendee(
            meeting_id=meeting.id,
            full_name=full_name, initials=initials, organization=org,
        ))

    # Deliverables
    deliv = Deliverable(
        project_id=project_id,
        project_segment="Snapdragon",
        task="EE 60% Recreation",
        start_status="In Progress",
        delivery_date=meeting_date + timedelta(days=14),
        source="manual",
        schedule_version_added="V1",
    )
    session.add(deliv)
    session.flush()
    session.add(MeetingDeliverable(
        meeting_id=meeting.id, deliverable_id=deliv.id,
        order_index=0, carried_from_prior=False,
    ))

    # Agenda
    for i, (text, disc) in enumerate([
        ("Electrical: cable approval strategy and IE comments.", "Electrical"),
        ("Civil: IDOT comments / status for Snapdragon and Two Blues.", "Civil"),
        ("General: schedule review and next-steps alignment.", "General"),
    ]):
        session.add(AgendaItem(
            meeting_id=meeting.id, order_index=i, text=text, discipline=disc,
        ))

    # Discussion points
    discussion = [
        ("IE methodology change",
         "HDR requested 0% soil moisture at cable periphery, driving higher thermal loads.",
         "Electrical"),
        ("Civil status",
         "Morning IDOT discussion was productive; awaiting District 9 feedback on the substation tie-in.",
         "Civil"),
        ("Schedule check",
         "On track for the 60% deliverable; minor risk around utility coordination.",
         "General"),
    ]
    for i, (label, content, disc) in enumerate(discussion):
        session.add(DiscussionPoint(
            meeting_id=meeting.id, parent_id=None, order_index=i,
            label=label, content=content, discipline=disc, ai_extracted=False,
        ))

    # Action items
    actions = [
        ("Set up call with HDR IE to align on load factor assumptions",
         "CK, KC", meeting_date + timedelta(days=3), "open"),
        ("Resend Heelstone technical specifications and IFR drawings",
         "KC", meeting_date + timedelta(days=2), "completed"),
        ("Draft soil-moisture sensitivity memo for HDR review",
         "AR", meeting_date + timedelta(days=10), "pending"),
    ]
    for text, owner, due, status in actions:
        session.add(ActionItem(
            project_id=project_id,
            originating_meeting_id=meeting.id,
            text=text, owner=owner, due_date=due, status=status,
        ))


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

        _seed_sample_meeting(session, project.id)

        print(
            f"Seeded client {client.name!r} with project "
            f"{project.name!r}, {len(SAMPLE_ROSTER)} roster members, "
            "and one sample meeting."
        )


if __name__ == "__main__":
    seed()
