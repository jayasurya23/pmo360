"""Client portal accounts: username/password login on top of the token model.

Properties under test, most expensive-to-get-wrong first:

  1. Every login failure — unknown email, wrong password, disabled, locked —
     is one identical 401. Nothing tells an attacker which emails exist.
  2. A successful login mints a SESSION token that behaves exactly like an
     invite link everywhere else, and carries the account behind it.
  3. Five wrong passwords lock the account; the lock expires; the correct
     password is refused while locked.
  4. Deactivation kills live sessions immediately, not at next login.
  5. Change-password re-verifies the current password, enforces policy,
     clears must-change, and revokes every OTHER session.
  6. Reset issues a new temporary password once, sets must-change, and
     revokes every session.
  7. Temporary passwords appear on create/reset and never on list.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from db.models import ClientPortalAccount


# ---------------------------------------------------------------- helpers

def _create(client, world, email="jane@utopian.example", **extra):
    r = client.post(
        f"/api/portal-admin/clients/{world.client_a.id}/accounts",
        json={"email": email, "display_name": "Jane Smith", **extra},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _login(client, email, password):
    return client.post("/api/portal/login", json={"email": email, "password": password})


def _session(client, email, password):
    r = _login(client, email, password)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Portal {r.json()['token']}"}, r.json()


# ---------------------------------------------------------------- admin

def test_create_requires_client_mgmt(client, world, as_plain_user):
    r = client.post(f"/api/portal-admin/clients/{world.client_a.id}/accounts",
                    json={"email": "x@y.example"})
    assert r.status_code == 403


def test_create_returns_temp_once_and_list_never(client, world, as_client_manager):
    a = _create(client, world)
    assert a["temporary_password"] and a["must_change_password"] is True and a["is_active"] is True
    assert a["email"] == "jane@utopian.example"
    r = client.get(f"/api/portal-admin/clients/{world.client_a.id}/accounts")
    assert r.status_code == 200
    rows = r.json()
    assert [x["email"] for x in rows] == ["jane@utopian.example"]
    assert all("temporary_password" not in x and "password_hash" not in x for x in rows)
    assert a["temporary_password"] not in r.text


def test_create_rejects_duplicate_bad_email_and_foreign_contact(client, world, as_client_manager):
    _create(client, world, email="dup@utopian.example")
    assert client.post(f"/api/portal-admin/clients/{world.client_a.id}/accounts",
                       json={"email": "DUP@utopian.example"}).status_code == 409   # case-insensitive
    assert client.post(f"/api/portal-admin/clients/{world.client_a.id}/accounts",
                       json={"email": "not-an-email"}).status_code == 422
    assert client.post(f"/api/portal-admin/clients/{world.client_a.id}/accounts",
                       json={"email": "z@utopian.example", "contact_id": world.contact_b.id}).status_code == 404


# ---------------------------------------------------------------- login

def test_login_mints_a_session_that_behaves_like_a_link(client, world, as_client_manager):
    a = _create(client, world, email="s1@utopian.example")
    h, body = _session(client, "S1@Utopian.Example", a["temporary_password"])   # email case-insensitive
    assert body["must_change_password"] is True
    exp = datetime.fromisoformat(body["expires_at"])
    assert timedelta(hours=11) < exp - datetime.utcnow() < timedelta(hours=13)

    me = client.get("/api/portal/me", headers=h)
    assert me.status_code == 200
    assert me.json()["kind"] == "session"
    assert me.json()["email"] == "s1@utopian.example"
    assert me.json()["must_change_password"] is True
    assert me.json()["client_name"] == world.client_a.name

    # Same scope rules as an invite link: own portfolio yes, other client no.
    assert client.get("/api/portal/projects", headers=h).json()[0]["name"] == world.portfolio_a.name
    assert client.get(f"/api/portal/projects/{world.portfolio_b.id}/dashboard", headers=h).status_code == 404


def test_login_failures_are_indistinguishable(client, world, as_client_manager):
    a = _create(client, world, email="f1@utopian.example")
    unknown = _login(client, "nobody@utopian.example", "whatever-password")
    wrong = _login(client, "f1@utopian.example", "wrong-password-here")
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"]

    # Disabled account: same message, even with the right password.
    client.post(f"/api/portal-admin/accounts/{a['id']}/deactivate")
    disabled = _login(client, "f1@utopian.example", a["temporary_password"])
    assert disabled.status_code == 401 and disabled.json()["detail"] == wrong.json()["detail"]


def test_lockout_after_five_failures_then_expires(client, world, as_client_manager, db):
    a = _create(client, world, email="lock@utopian.example")
    for _ in range(5):
        assert _login(client, "lock@utopian.example", "definitely-wrong-pw").status_code == 401
    # Correct password refused while locked, with the same message.
    locked = _login(client, "lock@utopian.example", a["temporary_password"])
    assert locked.status_code == 401
    row = db.query(ClientPortalAccount).filter_by(email="lock@utopian.example").one()
    assert row.locked_until is not None and row.locked_until > datetime.utcnow()

    # Lock expires -> login works again and counters reset.
    row.locked_until = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    h, _ = _session(client, "lock@utopian.example", a["temporary_password"])
    assert client.get("/api/portal/me", headers=h).status_code == 200
    db.refresh(row)
    assert row.failed_attempts == 0 and row.locked_until is None and row.last_login_at is not None


def test_deactivate_kills_live_sessions_immediately(client, world, as_client_manager):
    a = _create(client, world, email="d1@utopian.example")
    h, _ = _session(client, "d1@utopian.example", a["temporary_password"])
    assert client.get("/api/portal/me", headers=h).status_code == 200
    assert client.post(f"/api/portal-admin/accounts/{a['id']}/deactivate").status_code == 200
    assert client.get("/api/portal/me", headers=h).status_code == 401
    assert _login(client, "d1@utopian.example", a["temporary_password"]).status_code == 401
    assert client.post(f"/api/portal-admin/accounts/{a['id']}/activate").status_code == 200
    assert _login(client, "d1@utopian.example", a["temporary_password"]).status_code == 200


def test_logout_revokes_this_session_only(client, world, as_client_manager):
    a = _create(client, world, email="lo@utopian.example")
    h1, _ = _session(client, "lo@utopian.example", a["temporary_password"])
    h2, _ = _session(client, "lo@utopian.example", a["temporary_password"])
    assert client.post("/api/portal/logout", headers=h1).status_code == 204
    assert client.get("/api/portal/me", headers=h1).status_code == 401
    assert client.get("/api/portal/me", headers=h2).status_code == 200


# ---------------------------------------------------------------- change password

def test_change_password_flow(client, world, as_client_manager):
    a = _create(client, world, email="cp@utopian.example")
    temp = a["temporary_password"]
    h, _ = _session(client, "cp@utopian.example", temp)
    other, _ = _session(client, "cp@utopian.example", temp)

    # Invite links have no account behind them.
    r = client.post("/api/portal/change-password", headers=world.headers(),
                    json={"current_password": "x", "new_password": "y" * 12})
    assert r.status_code == 400

    # Wrong current password, then too-short new one.
    assert client.post("/api/portal/change-password", headers=h,
                       json={"current_password": "not-it", "new_password": "a-perfectly-fine-one"}).status_code == 400
    assert client.post("/api/portal/change-password", headers=h,
                       json={"current_password": temp, "new_password": "short"}).status_code == 422
    assert client.post("/api/portal/change-password", headers=h,
                       json={"current_password": temp, "new_password": "cp@utopian.example"}).status_code == 422

    new_pw = "correct horse battery staple"
    assert client.post("/api/portal/change-password", headers=h,
                       json={"current_password": temp, "new_password": new_pw}).status_code == 204

    # This session survives; the other one is revoked; old password is dead.
    me = client.get("/api/portal/me", headers=h)
    assert me.status_code == 200 and me.json()["must_change_password"] is False
    assert client.get("/api/portal/me", headers=other).status_code == 401
    assert _login(client, "cp@utopian.example", temp).status_code == 401
    assert _login(client, "cp@utopian.example", new_pw).status_code == 200


def test_reset_password_revokes_sessions_and_requires_change(client, world, as_client_manager):
    a = _create(client, world, email="rs@utopian.example")
    h, _ = _session(client, "rs@utopian.example", a["temporary_password"])
    r = client.post(f"/api/portal-admin/accounts/{a['id']}/reset-password")
    assert r.status_code == 200
    fresh = r.json()
    assert fresh["temporary_password"] and fresh["temporary_password"] != a["temporary_password"]
    assert fresh["must_change_password"] is True
    assert client.get("/api/portal/me", headers=h).status_code == 401           # old session dead
    assert _login(client, "rs@utopian.example", a["temporary_password"]).status_code == 401
    h2, body = _session(client, "rs@utopian.example", fresh["temporary_password"])
    assert body["must_change_password"] is True
    assert client.get("/api/portal/me", headers=h2).status_code == 200
