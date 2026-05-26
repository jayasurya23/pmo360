"""
Seed a fresh portfolio under TestCo Renewables with attendees who all have
EMAIL addresses on file. Used to demo the new attendee-email picker on Send
and to give the "Your stuff" Home dashboard something to attribute to a
real signed-in user.

Idempotent: run repeatedly. Drops any prior copy of the same portfolio name
before recreating.

Run from backend/:
    python -m scripts.seed_email_portfolio
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.session import get_session_factory, init_db
from db.models import (
    Client, Project, Meeting, MeetingAttendee, AgendaItem,
    DiscussionPoint, ActionItem, ProjectAttendee, GlobalAttendee,
)


TEST_CLIENT_NAME = "TestCo Renewables"
TEST_PORTFOLIO_NAME = "PV Interconnection Study"

# Realistic attendees with emails — mix of Castillo team + client + subcontractors.
# Castillo emails use the user's actual domain (castillope.com) so the directory
# browser test later can match them against the real M365 tenant.
ATTENDEES_WITH_EMAILS = [
    # full_name              initials  organization               email
    ("Jayasurya Bhaskar",    "JB", "Castillo Engineering",     "jbhaskar@castillope.com"),
    ("Arun Ramadass",        "AR", "Castillo Engineering",     "arun@castillope.com"),
    ("Rick Castillo",        "RC", "Castillo Engineering",     "rick@castillope.com"),
    ("Roashaael Mary John",  "RM", "Castillo Engineering",     "roashaael@castillope.com"),
    ("Mark Jordan",          "MJ", "TestCo Renewables",        "mark.jordan@testco-renewables.com"),
    ("Elizabeth Wuest",      "EW", "TestCo Renewables",        "elizabeth.wuest@testco-renewables.com"),
    ("Andrew Proctor",       "AP", "Sunshare Construction",    "aproctor@sunshare.example.com"),
    ("Dylan Wraga",          "DW", "Ampacity Engineering",     "dwraga@ampacity.example.com"),
]


def _purge(session) -> None:
    """Drop the existing test portfolio if it's there."""
    existing = (
        session.query(Project)
        .join(Client)
        .filter(Client.name == TEST_CLIENT_NAME, Project.name == TEST_PORTFOLIO_NAME)
        .first()
    )
    if existing:
        session.delete(existing)
        session.flush()


def main() -> None:
    init_db()
    session = get_session_factory()()
    try:
        _purge(session)

        # Find (or create) TestCo Renewables client
        client = session.query(Client).filter_by(name=TEST_CLIENT_NAME).first()
        if client is None:
            client = Client(name=TEST_CLIENT_NAME, email_domain="testco-renewables.com")
            session.add(client)
            session.flush()

        # New portfolio
        project = Project(
            client_id=client.id,
            name=TEST_PORTFOLIO_NAME,
            scope="Utility interconnection study + protection coordination",
            schedule_version="V1",
        )
        session.add(project)
        session.flush()

        # Seed the project roster (these are the people who'll show up under
        # "Portfolio roster" on the Capture page).
        for full_name, initials, org, email in ATTENDEES_WITH_EMAILS:
            session.add(ProjectAttendee(
                project_id=project.id,
                full_name=full_name, initials=initials,
                organization=org, email=email,
            ))

        # Also ensure Castillo team members are in the GLOBAL roster with
        # their emails (the existing global roster has them without emails).
        for full_name, initials, org, email in ATTENDEES_WITH_EMAILS:
            if org != "Castillo Engineering":
                continue
            existing_global = (
                session.query(GlobalAttendee).filter_by(full_name=full_name).first()
            )
            if existing_global is None:
                session.add(GlobalAttendee(
                    full_name=full_name, initials=initials,
                    organization=org, email=email,
                ))
            else:
                # Backfill the email if the prior seed left it blank.
                if not existing_global.email:
                    existing_global.email = email

        # A single meeting to anchor the portfolio (so it shows up on History
        # and the Send page has someone to email).
        meeting_date = date.today() - timedelta(days=2)
        meeting = Meeting(
            project_id=project.id,
            meeting_date=meeting_date,
            title=f"Kickoff — PV Interconnection Study",
            raw_notes="(seeded by seed_email_portfolio.py)",
            closing_remarks=(
                "Aligned on study scope. Utility coordination call scheduled "
                "for Friday."
            ),
            stage="draft",
            schedule_version_at_meeting="V1",
        )
        session.add(meeting)
        session.flush()

        # Meeting attendees — copy emails through (same path as the live
        # _write_meeting_children helper does).
        for full_name, initials, org, email in ATTENDEES_WITH_EMAILS:
            session.add(MeetingAttendee(
                meeting_id=meeting.id,
                full_name=full_name, initials=initials,
                organization=org, email=email,
            ))

        # A simple agenda + a couple of discussion points + one action
        # so the page isn't empty.
        for idx, (text, disc) in enumerate([
            ("Review utility deliverables list", "General"),
            ("Protection coordination requirements", "Electrical"),
            ("Schedule + permit timeline", "General"),
        ]):
            session.add(AgendaItem(
                meeting_id=meeting.id, order_index=idx,
                text=text, discipline=disc,
            ))

        for idx, (label, content, disc) in enumerate([
            ("Scope", "Confirmed POI at substation 4, single 138kV feeder.", "Electrical"),
            ("Risk", "Awaiting utility's recloser settings — gating item.", "Electrical"),
        ]):
            session.add(DiscussionPoint(
                meeting_id=meeting.id, parent_id=None,
                order_index=idx, label=label, content=content,
                discipline=disc, ai_extracted=False,
            ))

        session.add(ActionItem(
            project_id=project.id,
            originating_meeting_id=meeting.id,
            text="Email utility for recloser settings + protection coordination spec.",
            owner="Roashaael Mary John",
            due_date=date.today() + timedelta(days=5),
            status="open",
        ))

        session.commit()
        print(f"OK -> Portfolio '{TEST_PORTFOLIO_NAME}' created under '{TEST_CLIENT_NAME}'.")
        print(f"     {len(ATTENDEES_WITH_EMAILS)} attendees in the portfolio roster, all with emails.")
        print(f"     Meeting id={meeting.id} dated {meeting_date.isoformat()}.")
        print()
        print("Try it:")
        print(f"  1. Open the app, switch to {TEST_CLIENT_NAME} / {TEST_PORTFOLIO_NAME}")
        print("  2. Click Capture — the Portfolio roster banner should show all 8 people")
        print("  3. Click any attendee chip — they should already have emails (no orange 'Add email' link)")
        print("  4. On Send, the To-checkboxes should be enabled (not disabled) because every attendee has an email")
    finally:
        session.close()


if __name__ == "__main__":
    main()
