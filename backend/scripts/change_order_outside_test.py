"""Self-contained regression for "Outside PMO 360" change orders.

Runs the real /api/change-orders and /api/dashboard routes against an in-memory
SQLite database (no network, no real storage) and asserts:

  * a CO can be created with NO portfolio when the client and project are typed
    in, and is refused without them
  * its number is typed in, or else the next one for that same client+project
    (matched case-insensitively), independent of any portfolio's numbering
  * the full life cycle works without a portfolio: edit, preview (PDF + Word),
    submit, approve (archived under "Outside PMO 360/<client>/<project>/"),
    send-check, mark-sent
  * it never appears in a portfolio's list, and `outside=false` (what the Home
    rollups ask for) leaves it out, while `outside=true` lists only these
  * Home's "waiting on me" queue still renders with it in, labelled by its
    typed names — a required project_id there used to be a 500 for approvers

Run:  python scripts/change_order_outside_test.py   (exit 0 == pass)
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on path

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

import auth.dependencies as authdeps  # noqa: E402
import api.change_orders as co_api  # noqa: E402
from api.dashboard import router as dashboard_router  # noqa: E402
from core.deps import get_db  # noqa: E402
from db.models import Base, ChangeOrder, Client, Project, User  # noqa: E402


class _MemStorage:
    def __init__(self):
        self.saved = {}

    def save(self, path, content):
        self.saved[path] = content
        return path


def main() -> int:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as s:
        author = User(oid="a", name="Ann Author", email="ann@x.com", can_co_creation=True)
        approver = User(oid="b", name="Bo Approver", email="bo@x.com", can_co_approval=True)
        s.add_all([author, approver])
        cl = Client(name="Real Client")
        s.add(cl)
        s.flush()
        pr = Project(name="Real Portfolio", client_id=cl.id)
        s.add(pr)
        s.flush()
        ids = dict(author=author.id, approver=approver.id, project=pr.id)
        s.commit()

    storage = _MemStorage()
    co_api.get_storage = lambda: storage

    app = FastAPI()
    app.include_router(co_api.router)
    app.include_router(dashboard_router)

    def _db():
        with Session(engine) as s:
            try:
                yield s
                s.commit()
            except Exception:
                s.rollback()
                raise

    who = {"id": ids["author"]}

    def _user():
        with Session(engine) as s:
            u = s.get(User, who["id"])
            s.expunge(u)
            return u

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[authdeps.require_db_user] = _user
    app.dependency_overrides[authdeps.get_current_db_user] = _user
    c = TestClient(app)

    base = {"rate_type": "fixed", "request_date": "2026-11-04", "co_version": "V1",
            "line_items": [{"details": "Legacy scope", "cost": 5000}],
            "signatory_name": "Ann Author", "client_signatory_email": "buyer@legacy.example"}

    # --- refused without typed names
    r = c.post("/api/change-orders", json={**base, "client_name": "Legacy Co"})
    assert r.status_code == 400, r.text
    r = c.post("/api/change-orders", json={**base, "project_name": "Old Job"})
    assert r.status_code == 400, r.text

    # --- typed number honoured; next one follows it for the same client+project
    r = c.post("/api/change-orders", json={**base, "client_name": "Legacy Co",
                                          "project_name": "Old Job", "co_number": 4})
    assert r.status_code == 201, r.text
    first = r.json()
    assert first["project_id"] is None and first["co_number"] == 4
    assert first["client_name"] == "Legacy Co" and first["project_name"] == "Old Job"
    r = c.post("/api/change-orders", json={**base, "client_name": "  legacy co ",
                                          "project_name": "OLD JOB"})
    assert r.status_code == 201 and r.json()["co_number"] == 5, r.text
    r = c.post("/api/change-orders", json={**base, "client_name": "Other Legacy",
                                          "project_name": "Old Job"})
    assert r.json()["co_number"] == 1, "numbering must be per client+project"
    # a portfolio CO still numbers from its own portfolio
    r = c.post("/api/change-orders", json={**base, "project_id": ids["project"]})
    assert r.status_code == 201 and r.json()["co_number"] == 1
    assert r.json()["client_name"] == "Real Client"

    co_id = first["id"]

    # --- edit typed identity while draft
    r = c.patch(f"/api/change-orders/{co_id}", json={"client_name": "Legacy Company",
                                                      "co_number": 7})
    assert r.status_code == 200, r.text
    assert r.json()["client_name"] == "Legacy Company" and r.json()["co_number"] == 7
    r = c.patch(f"/api/change-orders/{co_id}", json={"portfolio_project_id": 1})
    assert r.status_code == 400

    # --- previews work with no portfolio
    payload = {**base, "client_name": "Legacy Co", "project_name": "Old Job"}
    assert c.post("/api/change-orders/preview", json=payload).content[:5] == b"%PDF-"
    r = c.post("/api/change-orders/preview-docx", json=payload)
    assert r.status_code == 200 and r.content[:2] == b"PK"
    assert c.get(f"/api/change-orders/{co_id}/docx").status_code == 200
    assert c.get(f"/api/change-orders/{co_id}/pdf/file").content[:5] == b"%PDF-"

    # --- lists: never in a portfolio's list; outside filter both ways
    in_portfolio = c.get("/api/change-orders", params={"project_id": ids["project"]}).json()
    assert all(x["project_id"] == ids["project"] for x in in_portfolio)
    only_portfolio = c.get("/api/change-orders", params={"outside": "false"}).json()
    assert only_portfolio and all(x["project_id"] is not None for x in only_portfolio)
    only_outside = c.get("/api/change-orders", params={"outside": "true"}).json()
    assert len(only_outside) == 3 and all(x["project_id"] is None for x in only_outside)
    r = c.get("/api/change-orders", params={"client_id": 1}).json()
    assert all(x["project_id"] is not None for x in r)

    # --- life cycle without a portfolio
    assert c.post(f"/api/change-orders/{co_id}/submit").status_code == 200
    who["id"] = ids["approver"]
    work = c.get("/api/dashboard/my-work")
    assert work.status_code == 200, work.text
    rows = [i for i in work.json()["waiting_on_me"]["co_approvals"] if i["id"] == co_id]
    assert rows and rows[0]["project_id"] is None
    assert rows[0]["client_name"] == "Legacy Company" and rows[0]["project_name"] == "Old Job"

    r = c.post(f"/api/change-orders/{co_id}/approve", json={})
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    archived = list(storage.saved)
    assert archived and archived[0].startswith("Outside PMO 360/Legacy_Company/Old_Job/change-orders/"), archived
    assert c.post(f"/api/change-orders/{co_id}/send-check").status_code == 200
    r = c.post(f"/api/change-orders/{co_id}/mark-sent",
               json={"recipients": "buyer@legacy.example", "method": "manual"})
    assert r.status_code == 200 and r.json()["sent_at"], r.text

    with Session(engine) as s:
        assert s.query(ChangeOrder).filter(ChangeOrder.project_id.is_(None)).count() == 3

    print("outside PMO 360 change orders: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
