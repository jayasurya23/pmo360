"""Portfolios carry the Castillo job number.

Revision ID: pn1a2b3c4d5e6
Revises: ea5b6c7d8e9f0
Create Date: 2026-09-09

WHY
---
Every Castillo project has a job number ("264-066", "2512-053") — the string an
engineer writes on a drawing and a PM quotes on the phone. PMO 360 had no field
for it, so the number lived only in monday.com and in people's heads, and
nothing here could be looked up the way the business actually refers to it.

monday.com's Portfolio board (18403099969, the column TITLED "Project ID") is
the source of truth; `backend/scripts/sync_projects_from_monday.py` backfills
from it. 38 of the 40 board rows have a number, which is why this is nullable.

WHICH TIER, AND WHY NOT A JOIN TABLE
------------------------------------
It goes on `projects` — which in this codebase IS the Portfolio tier. Every
`portfolio_project_id` in the schema is nullable and sub-projects are opt-in
rows, so a number living only there would be NULL for most real records.
Monday's board is itself a *Portfolio* board, one item per project.

A future `monday_project_links` join table (on the monday-bridge branch) is a
different thing and does not conflict: that table answers "whose RFIs flow into
this record", which is genuinely many-to-many, while this column answers "what
does this record call itself". A record can pull RFIs from three Monday items
and still have one job number. Neither is ever used as a join key.

WHY NOT UNIQUE
--------------
One Monday item can legitimately cover two of our portfolios ("Highland South
(1 & 2)"), which then correctly share a number — UNIQUE makes correct data
unrepresentable. Two of forty board rows are blank, so NULL is normal. And
migrations run inside prestart.py BEFORE uvicorn starts, so a uniqueness
violation on free text typed into Monday would be a container boot loop rather
than a failed write. The sync script reports duplicates instead.

SAFETY
------
One ADD COLUMN, nullable, no server_default, plus its index. On Postgres a
nullable add with no default is metadata-only — no table rewrite, no backfill,
no change to any existing column, and nothing near a money field. `projects`
holds ~40 rows. The new schema is forward-compatible with the previous
application build: the column is nullable and no older code selects it.

HEAD COLLISION — READ BEFORE MERGING monday-bridge OR monday-rfi
----------------------------------------------------------------
`fb6c7d8e9f0a1_monday_rfi.py` (present on monday-bridge and monday-rfi, not on
main) also declares `down_revision = "ea5b6c7d8e9f0"`. Two children of one
parent is two heads, and prestart.py calls `command.upgrade(cfg, "head")` —
singular — which raises "Multiple head revisions are present" before uvicorn
starts.

Resolve it with a real merge revision, NOT by re-pointing fb6c7d8e9f0a1 under
this one. Staging is already stamped at cp1e2f3a4b5c6, downstream of
fb6c7d8e9f0a1; re-pointing would make this revision an ancestor of staging's
current stamp, so `upgrade head` would find nothing to do, `project_number`
would never be created there, and every SELECT against `projects` would 500
against a schema missing a column the model declares. On the merge branch:

    python -m alembic heads     # expect pn1a2b3c4d5e6 and cp1e2f3a4b5c6
    python -m alembic merge -m "merge monday onto project_number" \
        pn1a2b3c4d5e6 cp1e2f3a4b5c6
    python -m alembic heads     # expect exactly one
"""
from alembic import op
import sqlalchemy as sa


revision: str = "pn1a2b3c4d5e6"
down_revision: str = "ea5b6c7d8e9f0"
branch_labels = None
depends_on = None


def _fail_fast_on_lock() -> None:
    """Time out rather than queue behind a reader.

    ADD COLUMN needs ACCESS EXCLUSIVE on `projects`, and env.py runs the whole
    upgrade in one transaction so the lock is held until commit. During a
    rolling deploy the previous revision is still serving (deploy.yml sets
    --min-replicas 1), and once an ACCESS EXCLUSIVE request queues, every
    subsequent read of `projects` queues behind it — an outage caused by a
    migration that is itself trivial. Timing out aborts the transaction,
    prestart exits 1, and the old revision keeps serving the old schema, which
    is a clean no-op deploy. No precedent in this repo's other revisions; it is
    a deliberate addition.
    """
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET lock_timeout = '5s'")


def upgrade() -> None:
    _fail_fast_on_lock()
    op.add_column("projects", sa.Column("project_number", sa.String(length=50), nullable=True))
    # Named to match what create_all() builds from `index=True` on the model,
    # so the migrated and freshly-created schemas converge.
    op.create_index("ix_projects_project_number", "projects", ["project_number"])


def downgrade() -> None:
    _fail_fast_on_lock()
    # Index first: SQLite refuses to DROP an indexed column.
    op.drop_index("ix_projects_project_number", table_name="projects")
    op.drop_column("projects", "project_number")
