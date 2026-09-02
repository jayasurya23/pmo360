"""Fixtures for the client-portal tests.

Environment is pinned BEFORE any app module is imported: ``get_engine()`` is a
process-global singleton bound to ``SQLITE_PATH`` on first use, so setting the
variables after an import would silently point the tests at whatever database
the developer last used. The scratch path is asserted never to be the real dev
database.

``AUTH_REQUIRED=true`` on purpose. The property these tests exist to prove —
that a portal token cannot reach an internal route — only holds in production
mode; in dev mode anonymous internal GETs are allowed by design, so a portal
token "reaching" one there would be the anonymous path, not a leak. Test the
configuration that matters.

Schema comes from ``Base.metadata.create_all``, not ``alembic upgrade``: the
migration chain is known not to replay from an empty database (fresh installs
are created at head and stamped), so create_all is the supported fresh-DB path.
"""
from __future__ import annotations

import os
import pathlib
import tempfile
import uuid
from datetime import datetime, timedelta

_TMP = pathlib.Path(tempfile.mkdtemp(prefix="pmo360-portal-tests-"))
os.environ["LOCAL_DEV_MODE"] = "true"
os.environ["AUTH_REQUIRED"] = "true"
os.environ["SQLITE_PATH"] = str(_TMP / "portal_tests.db")
os.environ.setdefault("OPENAI_API_KEY", "test-not-used")
assert "castillo.db" not in os.environ["SQLITE_PATH"], "refusing to touch the real dev database"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from auth import require_db_user  # noqa: E402
from auth.dependencies import get_current_db_user  # noqa: E402
from auth.portal import hash_token, new_raw_token  # noqa: E402
from db.models import (  # noqa: E402
    Base, Client, ClientContact, ClientPortalToken, PortfolioProject, Project, User,
)
from db.session import get_engine, get_session_factory  # noqa: E402
import app as app_module  # noqa: E402


def _uid() -> str:
    return uuid.uuid4().hex[:8]


@pytest.fixture(scope="session")
def app():
    Base.metadata.create_all(bind=get_engine())
    return app_module.create_app()


@pytest.fixture()
def db():
    s = get_session_factory()()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture()
def client(app):
    return TestClient(app)


class World:
    """Two clients, one portfolio and one sub-project each, one live link for A."""

    def __init__(self, db):
        u = _uid()
        self.client_a = Client(name=f"Utopian Power {u}")
        self.client_b = Client(name=f"Montante Solar {u}")
        db.add_all([self.client_a, self.client_b])
        db.flush()

        self.portfolio_a = Project(
            client_id=self.client_a.id, name=f"Nesler {u}",
            location="Nesler, IL", state="IL", size_mw="5",
        )
        self.portfolio_b = Project(
            client_id=self.client_b.id, name=f"Payne {u}",
            location="Payne, IL", state="IL", size_mw="3",
        )
        db.add_all([self.portfolio_a, self.portfolio_b])
        db.flush()

        self.sub_a = PortfolioProject(portfolio_id=self.portfolio_a.id, name="Nesler Phase 1")
        self.sub_b = PortfolioProject(portfolio_id=self.portfolio_b.id, name="Payne Phase 1")
        db.add_all([self.sub_a, self.sub_b])

        self.contact_a = ClientContact(
            client_id=self.client_a.id, first_name="Jane", last_name="Smith",
            email=f"jane.{u}@utopian.example",
        )
        self.contact_b = ClientContact(
            client_id=self.client_b.id, first_name="Bob", last_name="Jones",
            email=f"bob.{u}@montante.example",
        )
        db.add_all([self.contact_a, self.contact_b])

        self.raw_a = new_raw_token()
        self.token_a = ClientPortalToken(
            client_id=self.client_a.id, label="Utopian — test",
            token_hash=hash_token(self.raw_a),
        )
        db.add(self.token_a)
        db.commit()

    def headers(self, raw=None):
        return {"Authorization": f"Portal {raw or self.raw_a}"}


@pytest.fixture()
def world(db):
    return World(db)


def _make_user(db, *, can_client_mgmt: bool) -> User:
    u = _uid()
    row = User(
        oid=f"oid-{u}", email=f"{u}@castillope.com", name=f"Test {u}",
        is_admin=False, is_active=True, can_client_mgmt=can_client_mgmt,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@pytest.fixture()
def as_client_manager(app, db):
    """Act as an internal user holding `client_mgmt`. Overrides both identity
    dependencies so whichever one `require_permission` resolves through sees
    the same row."""
    row = _make_user(db, can_client_mgmt=True)
    app.dependency_overrides[require_db_user] = lambda: row
    app.dependency_overrides[get_current_db_user] = lambda: row
    try:
        yield row
    finally:
        app.dependency_overrides.pop(require_db_user, None)
        app.dependency_overrides.pop(get_current_db_user, None)


@pytest.fixture()
def as_plain_user(app, db):
    """Act as an internal user WITHOUT `client_mgmt`."""
    row = _make_user(db, can_client_mgmt=False)
    app.dependency_overrides[require_db_user] = lambda: row
    app.dependency_overrides[get_current_db_user] = lambda: row
    try:
        yield row
    finally:
        app.dependency_overrides.pop(require_db_user, None)
        app.dependency_overrides.pop(get_current_db_user, None)


__all__ = ["datetime", "timedelta"]
