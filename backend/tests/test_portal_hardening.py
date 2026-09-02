"""Hardening added after the adversarial review of the password login.

Each test here is a reproduction of a confirmed finding, kept as the
regression test for its fix:

  * the lockout counter was a read-increment-write and lost updates under
    concurrent requests — twelve parallel guesses, no lock;
  * /change-password re-verified the current password with none of the login
    controls, making a stolen session an unthrottled password oracle;
  * there was no per-source throttle at all, so unknown emails burned a full
    argon2 verify each and a single source could keep one account locked
    forever with five requests per fifteen minutes;
  * a Pydantic max_length on the password fields echoed the rejected password
    back in the 422 body;
  * the session label overflowed its String(120) column for long emails
    (silently on SQLite, a 500 on Postgres);
  * reset-password on a disabled account handed the admin a credential that
    could not be used;
  * a portal token presented to an internal route was printed in full to the
    process log by the auth debug line.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from api import portal as portal_api
from db.models import ClientPortalAccount, ClientPortalToken


# ---------------------------------------------------------------- helpers
# Duplicated from test_portal_accounts on purpose: tests/ is not a package.

def _create(client, world, email, **extra):
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


def _change(client, headers, current, new):
    return client.post("/api/portal/change-password", headers=headers,
                       json={"current_password": current, "new_password": new})


def _row(db, email) -> ClientPortalAccount:
    db.expire_all()
    return db.query(ClientPortalAccount).filter_by(email=email).one()


# ---------------------------------------------------------------- atomic counter

def test_concurrent_wrong_passwords_still_lock(app, client, world, as_client_manager, db):
    """Twelve wrong passwords at once. Before the fix every request read
    failed_attempts=0 during its ~50 ms verify and wrote back 1; the account
    was never locked. The increment now happens in SQL."""
    portal_api.login_ip_limiter.limit = 1000     # this test is ABOUT the counter
    portal_api.login_email_limiter.limit = 1000
    email = "race@utopian.example"
    _create(client, world, email=email)

    def attempt(i: int) -> int:
        c = TestClient(app)          # one client per thread, as separate browsers would be
        return c.post("/api/portal/login", json={"email": email, "password": f"wrong-{i}"}).status_code

    with ThreadPoolExecutor(max_workers=12) as ex:
        codes = list(ex.map(attempt, range(12)))
    assert codes == [401] * 12

    row = _row(db, email)
    assert row.locked_until is not None and row.locked_until > datetime.utcnow(), \
        f"12 failures, failed_attempts={row.failed_attempts}, no lock"


# ---------------------------------------------------------------- change-password controls

def test_change_password_misses_count_lock_and_revoke_the_guessing_session(client, world, as_client_manager, db):
    email = "oracle@utopian.example"
    a = _create(client, world, email=email)
    temp = a["temporary_password"]
    guessing, _ = _session(client, email, temp)
    owner, _ = _session(client, email, temp)

    for i in range(4):
        assert _change(client, guessing, f"guess-{i}", "a-perfectly-fine-one").status_code == 400
    assert _row(db, email).failed_attempts == 4
    assert client.get("/api/portal/me", headers=guessing).status_code == 200   # not yet

    # Fifth miss trips the lock. A session guessing at its own password is the
    # signal of theft, so EVERY session dies, the guessing one included.
    assert _change(client, guessing, "guess-4", "a-perfectly-fine-one").status_code == 400
    row = _row(db, email)
    assert row.locked_until is not None and row.locked_until > datetime.utcnow()
    assert client.get("/api/portal/me", headers=guessing).status_code == 401
    assert client.get("/api/portal/me", headers=owner).status_code == 401
    # ...and the real password is refused at the door while the lock holds.
    assert _login(client, email, temp).status_code == 401


def test_change_password_refused_while_locked(client, world, as_client_manager, db):
    email = "locked@utopian.example"
    a = _create(client, world, email=email)
    temp = a["temporary_password"]
    h, _ = _session(client, email, temp)           # minted BEFORE the lock
    for _ in range(5):
        assert _login(client, email, "not-the-password").status_code == 401

    r = _change(client, h, temp, "a-perfectly-fine-one")
    assert r.status_code == 429 and r.headers.get("retry-after")

    row = _row(db, email)
    row.locked_until = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    assert _change(client, h, temp, "a-perfectly-fine-one").status_code == 204


def test_bad_new_password_never_confirms_a_guess(client, world, as_client_manager, db):
    """The oracle: 400 for a wrong current password, 422 for a right one with
    a bad new password — a free yes/no on the guess. Now policy runs first, so
    a bad new password is 422 whatever the current one is, and no verify runs
    (the counter does not move)."""
    email = "noracle@utopian.example"
    a = _create(client, world, email=email)
    h, _ = _session(client, email, a["temporary_password"])
    assert _change(client, h, "wrong-guess", "short").status_code == 422
    assert _change(client, h, a["temporary_password"], "short").status_code == 422
    assert _row(db, email).failed_attempts == 0


# ---------------------------------------------------------------- throttle

def test_login_is_throttled_per_source(client, world, as_client_manager):
    portal_api.login_ip_limiter.limit = 3
    codes = [_login(client, f"nobody{i}@utopian.example", "whatever-password").status_code for i in range(4)]
    assert codes == [401, 401, 401, 429]
    r = _login(client, "nobody9@utopian.example", "whatever-password")
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1
    assert r.json()["detail"]


def test_login_is_throttled_per_email_whether_or_not_it_exists(client, world, as_client_manager):
    portal_api.login_email_limiter.limit = 2
    a = _create(client, world, email="real@utopian.example")
    real = [_login(client, "real@utopian.example", "wrong").status_code for _ in range(3)]
    fake = [_login(client, "fake@utopian.example", "wrong").status_code for _ in range(3)]
    assert real == fake == [401, 401, 429]          # identical shape: the throttle cannot enumerate
    # Throttled requests never reach the counter.
    assert _login(client, "REAL@utopian.example", a["temporary_password"]).status_code == 429


def test_last_forwarded_for_entry_is_the_source(client, world, as_client_manager):
    """Behind the ingress the LAST X-Forwarded-For entry is the real peer; the
    first is whatever the client sent. Spoofing the first must not buy a
    fresh bucket."""
    portal_api.login_ip_limiter.limit = 2
    def go(spoof):
        return client.post("/api/portal/login",
                           json={"email": "x@utopian.example", "password": "whatever-password"},
                           headers={"X-Forwarded-For": f"{spoof}, 203.0.113.9"}).status_code
    assert [go("10.0.0.1"), go("10.0.0.2"), go("10.0.0.3")] == [401, 401, 429]


# ---------------------------------------------------------------- no echo, no overflow

def test_overlong_passwords_are_refused_without_being_echoed(client, world, as_client_manager):
    pw = "P" * 300
    r = _login(client, "someone@utopian.example", pw)
    assert r.status_code == 401 and pw not in r.text

    a = _create(client, world, email="echo@utopian.example")
    h, _ = _session(client, "echo@utopian.example", a["temporary_password"])
    r = _change(client, h, a["temporary_password"], "N" * 300)
    assert r.status_code == 422 and "N" * 300 not in r.text
    r = _change(client, h, "C" * 300, "a-perfectly-fine-one")
    assert r.status_code == 400 and "C" * 300 not in r.text


def test_session_label_fits_its_column(client, world, as_client_manager, db):
    email = "a" * 200 + "@utopian.example"
    a = _create(client, world, email=email)
    _session(client, email, a["temporary_password"])
    db.expire_all()
    tok = (db.query(ClientPortalToken).filter_by(kind="session")
           .order_by(ClientPortalToken.id.desc()).first())
    assert tok is not None and len(tok.label) <= ClientPortalToken.label.type.length


# ---------------------------------------------------------------- admin

def test_reset_on_disabled_account_is_refused(client, world, as_client_manager):
    a = _create(client, world, email="off@utopian.example")
    assert client.post(f"/api/portal-admin/accounts/{a['id']}/deactivate").status_code == 200
    r = client.post(f"/api/portal-admin/accounts/{a['id']}/reset-password")
    assert r.status_code == 409 and "temporary_password" not in r.text
    assert client.post(f"/api/portal-admin/accounts/{a['id']}/activate").status_code == 200
    assert client.post(f"/api/portal-admin/accounts/{a['id']}/reset-password").status_code == 200


# ---------------------------------------------------------------- logging

def test_portal_token_on_an_internal_route_is_not_logged(client, world, capsys):
    r = client.get("/api/clients", headers=world.headers())
    assert r.status_code == 401
    out = capsys.readouterr().out
    assert world.raw_a not in out
    assert "malformed Authorization header" in out       # the line still fires, shape only
