"""`client_owed` — the flag that decides whether an action reaches a client.

It is three-valued (null = untriaged, false = ours, true = the client's) and it
is written from two places that must agree: the rolling-actions page (PATCH)
and the meeting editor (a whole-meeting save). The second one is the reason
these tests exist at all — a meeting re-save DELETES and rebuilds its actions
from the payload, so a flag the save path did not carry would be silently
erased every time somebody edited the minutes, emptying the client's "waiting
on you" list with no error anywhere.
"""
from __future__ import annotations

from datetime import date

import pytest

from db.models import ActionItem, Meeting, Project, User


# ---------------------------------------------------------------- fixtures

@pytest.fixture()
def as_pm(app, db):
    """An internal user holding `meeting_minutes` — what action writes need."""
    from auth import require_db_user
    from auth.dependencies import get_current_db_user
    import uuid

    u = uuid.uuid4().hex[:8]
    row = User(
        oid=f"oid-pm-{u}", email=f"pm-{u}@castillope.com", name=f"PM {u}",
        is_admin=False, is_active=True, can_meeting_minutes=True,
    )
    db.add(row)
    db.commit()
    app.dependency_overrides[require_db_user] = lambda: row
    app.dependency_overrides[get_current_db_user] = lambda: row
    try:
        yield row
    finally:
        app.dependency_overrides.pop(require_db_user, None)
        app.dependency_overrides.pop(get_current_db_user, None)


@pytest.fixture()
def meeting(db, world) -> Meeting:
    m = Meeting(project_id=world.portfolio_a.id, meeting_date=date(2026, 9, 1),
                title="Weekly coordination", stage="draft")
    db.add(m)
    db.commit()
    return m


def _action(db, world, meeting, **kw) -> ActionItem:
    row = ActionItem(
        project_id=world.portfolio_a.id,
        originating_meeting_id=meeting.id,
        text=kw.pop("text", "Send us the interconnection agreement"),
        owner=kw.pop("owner", "Jane"),
        status=kw.pop("status", "open"),
        **kw,
    )
    db.add(row)
    db.commit()
    return row


# ---------------------------------------------------------------- read

def test_untriaged_by_default_and_visible_on_the_read(client, db, world, meeting, as_pm):
    a = _action(db, world, meeting)
    assert a.client_owed is None                      # nobody has decided yet
    rows = client.get("/api/actions", params={"project_id": world.portfolio_a.id})
    assert rows.status_code == 200
    row = next(r for r in rows.json() if r["id"] == a.id)
    # Present in the payload, not merely absent-and-defaulted: the control has
    # to be able to tell "ours" from "nobody looked".
    assert "client_owed" in row and row["client_owed"] is None


# ---------------------------------------------------------------- patch

def test_patch_round_trips_all_three_values(client, db, world, meeting, as_pm):
    a = _action(db, world, meeting)

    r = client.patch(f"/api/actions/{a.id}", json={"client_owed": True})
    assert r.status_code == 200 and r.json()["client_owed"] is True

    r = client.patch(f"/api/actions/{a.id}", json={"client_owed": False})
    assert r.status_code == 200 and r.json()["client_owed"] is False

    # null is a VALUE here — "put it back to untriaged" — not an omission.
    r = client.patch(f"/api/actions/{a.id}", json={"client_owed": None})
    assert r.status_code == 200 and r.json()["client_owed"] is None

    db.expire_all()
    assert db.get(ActionItem, a.id).client_owed is None


def test_patching_something_else_leaves_the_flag_alone(client, db, world, meeting, as_pm):
    """The distinction the whole patch handler rests on: a field that is not in
    the request body is untouched, even though its Python value is None."""
    a = _action(db, world, meeting, client_owed=True)
    r = client.patch(f"/api/actions/{a.id}", json={"status": "pending"})
    assert r.status_code == 200
    assert r.json()["status"] == "pending" and r.json()["client_owed"] is True


def test_create_accepts_the_flag(client, db, world, meeting, as_pm):
    r = client.post("/api/actions", json={
        "project_id": world.portfolio_a.id,
        "originating_meeting_id": meeting.id,
        "text": "Confirm the POI location",
        "client_owed": True,
    })
    assert r.status_code == 201 and r.json()["client_owed"] is True


# ---------------------------------------------------------------- meeting save

def test_meeting_resave_preserves_the_flag(db, world, meeting, as_pm):
    """A re-save rebuilds the meeting's actions from the parsed payload. The
    flag has to travel on that payload or it is erased — which is exactly what
    used to happen to the owner link and the sub-project tag."""
    from core.services import _write_meeting_children
    from llm.providers import ParsedActionItem, ParsedMeeting

    parsed = ParsedMeeting(
        attendees=[], agenda_items=[], discussion_points=[],
        action_items=[
            ParsedActionItem(text="Client to send the ICA", owner="Jane",
                             client_owed=True, status="open"),
            ParsedActionItem(text="We reissue the SLD", owner="Arun",
                             client_owed=False, status="open"),
            ParsedActionItem(text="Nobody has triaged this", owner="TBD",
                             status="open"),
        ],
    )
    project = db.get(Project, world.portfolio_a.id)
    _write_meeting_children(db, meeting, project, parsed)
    db.commit()

    rows = {
        r.text: r.client_owed
        for r in db.query(ActionItem).filter_by(originating_meeting_id=meeting.id).all()
    }
    assert rows == {
        "Client to send the ICA": True,
        "We reissue the SLD": False,
        "Nobody has triaged this": None,
    }


def test_flag_reaches_the_client_only_once_the_minutes_are_sent(client, db, world, meeting, as_pm):
    """End to end, and the half a PM most needs to be able to rely on: setting
    the flag does NOT publish anything on its own. The action appears on the
    client's list when — and only when — the meeting reaches `sent`."""
    a = _action(db, world, meeting, client_owed=True)
    pid = world.portfolio_a.id
    h = world.headers()

    waiting = client.get(f"/api/portal/projects/{pid}/waiting-on-you", headers=h)
    assert waiting.status_code == 200 and waiting.json()["actions"] == []

    meeting.stage = "sent"
    db.commit()
    waiting = client.get(f"/api/portal/projects/{pid}/waiting-on-you", headers=h)
    assert [x["text"] for x in waiting.json()["actions"]] == [a.text]

    # ...and clearing the flag takes it straight back off.
    assert client.patch(f"/api/actions/{a.id}", json={"client_owed": None}).status_code == 200
    waiting = client.get(f"/api/portal/projects/{pid}/waiting-on-you", headers=h)
    assert waiting.json()["actions"] == []
