"""Client portal: identity, scoping, allowlists, and the four surfaces.

The properties under test, in order of how expensive it would be to get wrong:

  1. A token sees exactly one client's portfolios — never another's, and a
     miss is 404, not 403.
  2. A portal token cannot reach an internal route; an internal Bearer cannot
     reach a portal route.
  3. Absent, unknown, revoked and expired tokens are indistinguishable.
  4. Every response is an exact allowlist — the key set is asserted, so a
     column added to a model cannot silently appear.
  5. Every surface is computed from ISSUED data only: drafts, unsent change
     orders, and other clients' rows never leak into a count or a list.
  6. The raw token crosses the wire once, on issue, and never on list.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from auth.portal import hash_token, new_raw_token
from db.models import ActionItem, ChangeOrder, ClientPortalToken, Meeting, MeetingRFI


# ---------------------------------------------------------------- seeding

def seed_surfaces(db, w):
    """Issued + unissued data for client A, and a mirror for client B."""
    A, B = w.portfolio_a.id, w.portfolio_b.id
    sent = Meeting(project_id=A, meeting_date=date(2026, 8, 20), title="Weekly coordination", stage="sent")
    older = Meeting(project_id=A, meeting_date=date(2026, 8, 6), title="Earlier weekly", stage="sent")
    draft = Meeting(project_id=A, meeting_date=date(2026, 8, 27), title="DRAFT next week", stage="draft")
    b_sent = Meeting(project_id=B, meeting_date=date(2026, 8, 21), title="Payne weekly", stage="sent")
    db.add_all([sent, older, draft, b_sent])
    db.flush()

    db.add_all([
        ActionItem(project_id=A, originating_meeting_id=sent.id, text="Send updated site plan",
                   owner="Jane", status="open", client_owed=True, due_date=date(2026, 9, 5)),
        ActionItem(project_id=A, originating_meeting_id=sent.id, text="Castillo: revise SLD",
                   owner="JB", status="open"),                              # ours, not client-owed
        ActionItem(project_id=A, originating_meeting_id=draft.id, text="From a draft",
                   owner="Jane", status="open", client_owed=True),           # draft -> never shown
        ActionItem(project_id=A, originating_meeting_id=sent.id, text="Already closed",
                   owner="Jane", status="completed", client_owed=True),      # closed -> not waiting
        ActionItem(project_id=B, originating_meeting_id=b_sent.id, text="PAYNE-ONLY action",
                   owner="Bob", status="open", client_owed=True),            # other client
    ])

    db.add_all([
        # Same RFI on two issued meetings: newest snapshot must win, once.
        MeetingRFI(meeting_id=older.id, monday_item_id=1001, name="Nesler RFI #3", order_index=0,
                   item_equipment="AC Switchboard - Datasheet", status="Assigned",
                   response_owner="Client Data Needed", portfolio_project_id=w.sub_a.id),
        MeetingRFI(meeting_id=sent.id, monday_item_id=1001, name="Nesler RFI #3", order_index=0,
                   item_equipment="AC Switchboard - Datasheet", description="Need the datasheet",
                   status="In Progress", response_owner="Client Data Needed",
                   response_needed_by=date(2026, 9, 12), portfolio_project_id=w.sub_a.id),
        MeetingRFI(meeting_id=sent.id, monday_item_id=1002, name="RFI #4", order_index=1,
                   item_equipment="Fault current study", status="In Progress",
                   response_owner="Castillo Response"),                     # ours -> in rfis, not waiting
        MeetingRFI(meeting_id=sent.id, monday_item_id=1003, name="RFI #1", order_index=2,
                   item_equipment="Module datasheet", status="Completed",
                   response_owner="Client Data Needed"),                    # closed
        MeetingRFI(meeting_id=draft.id, monday_item_id=1004, name="draft-only", order_index=0,
                   item_equipment="NOT ISSUED", status="In Progress",
                   response_owner="Client Data Needed"),                    # draft -> never shown
        MeetingRFI(meeting_id=b_sent.id, monday_item_id=2001, name="Payne RFI", order_index=0,
                   item_equipment="PAYNE-ONLY rfi", status="In Progress",
                   response_owner="Client Data Needed"),                    # other client
    ])

    db.add_all([
        ChangeOrder(project_id=A, co_number=1, status="approved", rate_type="fixed", total_amount=4850.0,
                    title="Utility study re-review", request_date=date(2026, 6, 18),
                    sent_at=datetime(2026, 6, 20)),
        ChangeOrder(project_id=A, co_number=2, status="approved", rate_type="hourly", total_amount=999.0,
                    title="Hourly support", request_date=date(2026, 7, 9),
                    sent_at=datetime(2026, 7, 10)),
        ChangeOrder(project_id=A, co_number=3, status="approved", rate_type="fixed", total_amount=12480.0,
                    title="APPROVED BUT UNSENT", request_date=date(2026, 8, 27)),     # sent_at None
        ChangeOrder(project_id=A, co_number=4, status="draft", rate_type="fixed", total_amount=50000.0,
                    title="DRAFT CO", request_date=date(2026, 8, 30), sent_at=datetime(2026, 8, 30)),
        ChangeOrder(project_id=B, co_number=1, status="approved", rate_type="fixed", total_amount=7777.0,
                    title="PAYNE-ONLY co", request_date=date(2026, 7, 1), sent_at=datetime(2026, 7, 2)),
    ])
    db.commit()


# ---------------------------------------------------------------- identity

def test_me(client, world):
    r = client.get("/api/portal/me", headers=world.headers())
    assert r.status_code == 200
    assert r.json() == {
        "client_name": world.client_a.name, "label": "Utopian — test", "expires_at": None,
        "kind": "invite", "email": None, "must_change_password": False,
    }


def test_projects_scoped_and_allowlisted(client, world):
    r = client.get("/api/portal/projects", headers=world.headers())
    assert r.status_code == 200
    body = r.json()
    assert [p["name"] for p in body] == [world.portfolio_a.name]      # never client B
    assert set(body[0]) == {"id", "name", "location", "state", "size_mw", "projects"}
    assert body[0]["projects"] == [{"id": world.sub_a.id, "name": "Nesler Phase 1"}]


def test_absent_unknown_revoked_expired_are_indistinguishable(client, world, db):
    detail = client.get("/api/portal/me").json()["detail"]
    assert client.get("/api/portal/me", headers=world.headers(world.raw_a + "x")).json()["detail"] == detail

    raw = new_raw_token()
    db.add(ClientPortalToken(client_id=world.client_a.id, label="revoked",
                             token_hash=hash_token(raw), revoked_at=datetime.utcnow()))
    db.commit()
    r = client.get("/api/portal/me", headers=world.headers(raw))
    assert r.status_code == 401 and r.json()["detail"] == detail

    raw = new_raw_token()
    db.add(ClientPortalToken(client_id=world.client_a.id, label="expired",
                             token_hash=hash_token(raw),
                             expires_at=datetime.utcnow() - timedelta(minutes=1)))
    db.commit()
    r = client.get("/api/portal/me", headers=world.headers(raw))
    assert r.status_code == 401 and r.json()["detail"] == detail


def test_schemes_cannot_cross(client, world):
    # An internal Bearer on a portal route is a malformed Portal token.
    assert client.get("/api/portal/me", headers={"Authorization": "Bearer eyJ.fake.jwt"}).status_code == 401
    # A portal token on an internal route is a malformed Bearer -> anonymous ->
    # 401 under AUTH_REQUIRED=true, which is the production configuration.
    assert client.get("/api/clients", headers=world.headers()).status_code == 401


def test_out_of_scope_portfolio_is_404_not_403(client, world):
    r = client.get(f"/api/portal/projects/{world.portfolio_b.id}/dashboard", headers=world.headers())
    assert r.status_code == 404


def test_last_used_is_stamped(client, world, db):
    client.get("/api/portal/me", headers=world.headers())
    db.refresh(world.token_a)
    assert world.token_a.last_used_at is not None


# ---------------------------------------------------------------- surfaces

def test_dashboard_counts_only_issued_data(client, world, db):
    seed_surfaces(db, world)
    r = client.get(f"/api/portal/projects/{world.portfolio_a.id}/dashboard", headers=world.headers())
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {
        "portfolio_name", "last_issued_meeting", "open_actions", "waiting_on_you", "approved_change_orders",
    }
    assert body["last_issued_meeting"] == {"meeting_date": "2026-08-20", "title": "Weekly coordination"}
    assert body["open_actions"] == 2          # two open actions on SENT minutes; the draft one is invisible
    assert body["waiting_on_you"] == 2        # 1 client-owed open action + 1 client-owned open RFI
    assert body["approved_change_orders"] == {"count": 2, "approved_total": 4850.0, "hourly_count": 1}


def test_rfis_are_issued_deduped_and_allowlisted(client, world, db):
    seed_surfaces(db, world)
    r = client.get(f"/api/portal/projects/{world.portfolio_a.id}/rfis", headers=world.headers())
    assert r.status_code == 200
    rows = r.json()
    assert [x["item"] for x in rows] == [
        "AC Switchboard - Datasheet", "Fault current study", "Module datasheet",
    ]                                        # open first; closed last; draft-only absent; deduped
    assert set(rows[0]) == {"item", "description", "needed_by", "is_open", "project_name"}
    assert rows[0]["description"] == "Need the datasheet"      # newest snapshot won
    assert rows[0]["needed_by"] == "2026-09-12"
    assert rows[0]["project_name"] == "Nesler Phase 1"
    assert rows[2]["is_open"] is False
    blob = r.text.lower()
    for forbidden in ("response_owner", "castillo response", "client data needed", "monday", "assigned_to", "not issued"):
        assert forbidden not in blob, forbidden


def test_waiting_on_you_is_the_client_owed_subset(client, world, db):
    seed_surfaces(db, world)
    r = client.get(f"/api/portal/projects/{world.portfolio_a.id}/waiting-on-you", headers=world.headers())
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"rfis", "actions", "note"}
    assert [x["item"] for x in body["rfis"]] == ["AC Switchboard - Datasheet"]
    assert body["actions"] == [{"text": "Send updated site plan", "due_date": "2026-09-05", "is_open": True}]
    assert body["note"] is None
    assert "From a draft" not in r.text and "Already closed" not in r.text


def test_change_orders_issued_only_no_numbers_no_lines(client, world, db):
    seed_surfaces(db, world)
    r = client.get(f"/api/portal/projects/{world.portfolio_a.id}/change-orders", headers=world.headers())
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"items", "summary", "amounts_due", "note"}
    assert [x["title"] for x in body["items"]] == ["Utility study re-review", "Hourly support"]
    assert set(body["items"][0]) == {"title", "request_date", "total", "is_hourly"}
    assert body["items"][0]["total"] == 4850.0
    assert body["items"][1] == {"title": "Hourly support", "request_date": "2026-07-09", "total": None, "is_hourly": True}
    assert body["summary"] == {"count": 2, "approved_total": 4850.0, "hourly_count": 1}
    assert body["amounts_due"] is None
    blob = r.text
    for forbidden in ("co_number", "co_version", "pmo_pct", "admin_pct", "UNSENT", "DRAFT CO", "12480", "50000"):
        assert forbidden not in blob, forbidden


def test_other_client_never_appears_on_any_surface(client, world, db):
    seed_surfaces(db, world)
    pid = world.portfolio_a.id
    for path in ("dashboard", "rfis", "waiting-on-you", "change-orders"):
        r = client.get(f"/api/portal/projects/{pid}/{path}", headers=world.headers())
        assert r.status_code == 200, path
        assert "PAYNE-ONLY" not in r.text, path
        assert world.portfolio_b.name not in r.text, path


# ---------------------------------------------------------------- issuance

def test_issue_requires_client_mgmt(client, world, as_plain_user):
    r = client.post(f"/api/portal-admin/clients/{world.client_a.id}/tokens", json={"label": "x"})
    assert r.status_code == 403


def test_issue_returns_raw_once_and_list_never(client, world, as_client_manager):
    r = client.post(f"/api/portal-admin/clients/{world.client_a.id}/tokens",
                    json={"label": "Utopian — Jane", "contact_id": world.contact_a.id, "expires_in_days": 30})
    assert r.status_code == 201, r.text
    issued = r.json()
    assert issued["raw_token"] and issued["is_live"] is True
    assert issued["contact_name"] == "Jane Smith"

    # The freshly issued token works for the portal…
    assert client.get("/api/portal/me", headers={"Authorization": f"Portal {issued['raw_token']}"}).status_code == 200

    # …and the list carries metadata only.
    r = client.get(f"/api/portal-admin/clients/{world.client_a.id}/tokens")
    assert r.status_code == 200
    assert all("raw_token" not in row for row in r.json())
    assert issued["raw_token"] not in r.text


def test_contact_from_other_client_is_404(client, world, as_client_manager):
    r = client.post(f"/api/portal-admin/clients/{world.client_a.id}/tokens",
                    json={"label": "cross", "contact_id": world.contact_b.id})
    assert r.status_code == 404


def test_expiry_is_capped(client, world, as_client_manager):
    r = client.post(f"/api/portal-admin/clients/{world.client_a.id}/tokens",
                    json={"label": "forever", "expires_in_days": 3650})
    assert r.status_code == 422


def test_revoke_then_401(client, world, as_client_manager):
    r = client.post(f"/api/portal-admin/clients/{world.client_a.id}/tokens", json={"label": "short-lived"})
    issued = r.json()
    h = {"Authorization": f"Portal {issued['raw_token']}"}
    assert client.get("/api/portal/me", headers=h).status_code == 200
    assert client.delete(f"/api/portal-admin/tokens/{issued['id']}").status_code == 204
    assert client.get("/api/portal/me", headers=h).status_code == 401
    # Idempotent: revoking again is fine.
    assert client.delete(f"/api/portal-admin/tokens/{issued['id']}").status_code == 204
