"""Change orders may exist without a portfolio ("Outside PMO 360").

Revision ID: os1a2b3c4d5e6
Revises: pn2b3c4d5e6f7
Create Date: 2026-11-04

WHAT AND WHY
------------
Castillo wants every change order it sends to come out of PMO 360 so they all
look the same — including COs for old clients/projects that are not in the
system and will not be added. Those rows have no portfolio: `project_id` is
NULL, the client and project are the free-text snapshot columns that already
exist (`client_name`, `project_name`), and `co_number` is typed in.

WHAT IT DOES TO EXISTING CHANGE ORDERS
--------------------------------------
Nothing. Every existing row has a project_id; only the constraint is relaxed.

SAFETY
------
Postgres: ALTER COLUMN ... DROP NOT NULL is metadata-only — no rewrite, no
backfill — under the same `lock_timeout` guard as pn1/pn2, because prestart.py
runs this at container boot and a migration that raises takes production down.
SQLite (local dev only) cannot alter a column in place, so it goes through
Alembic's batch mode there.

DOWNGRADE refuses rather than guesses if any portfolio-less CO exists: there is
no portfolio to put it back on.
"""
from alembic import op
import sqlalchemy as sa


revision: str = "os1a2b3c4d5e6"
down_revision: str = "pn2b3c4d5e6f7"
branch_labels = None
depends_on = None


def _alter(nullable: bool) -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("SET lock_timeout = '5s'")
        op.alter_column("change_orders", "project_id",
                        existing_type=sa.Integer(), nullable=nullable)
    else:
        with op.batch_alter_table("change_orders") as batch:
            batch.alter_column("project_id", existing_type=sa.Integer(), nullable=nullable)


def upgrade() -> None:
    _alter(True)


def downgrade() -> None:
    n = op.get_bind().execute(
        sa.text("SELECT COUNT(*) FROM change_orders WHERE project_id IS NULL")
    ).scalar()
    if n:
        raise RuntimeError(
            f"{n} change order(s) have no portfolio (Outside PMO 360); "
            "delete or re-home them before downgrading."
        )
    _alter(False)
