"""Change orders snapshot the Castillo job number.

Revision ID: pn2b3c4d5e6f7
Revises: pn1a2b3c4d5e6
Create Date: 2026-09-09

WHY A SNAPSHOT AND NOT A LIVE READ
----------------------------------
`pn1a2b3c4d5e6` put the job number on the portfolio. The change order PDF could
have read it through the relationship — but every other value in that PDF's
header is a column on `change_orders`, not a live read: `client_name`,
`project_name`, `location`, `state`, `size_mw` are all snapshots, and the model
says so ("snapshot for the PDF + History").

That is not an accident. A change order gets signed. If a PM corrects a
portfolio's job number a year from now — a typo, or a renumbering — a live read
would silently re-write the header of an already-executed money document, and
the PDF a client holds would stop matching the PDF the system generates. So the
number is copied onto the CO at creation and edited there afterwards.

WHAT IT DOES TO EXISTING CHANGE ORDERS
--------------------------------------
Nothing. The column is NULL on every existing row, and the PDF renders an empty
value for the new "Job No." line rather than failing. Nothing is backfilled:
guessing which job number was current when a CO was signed is exactly the
inference this design exists to avoid. A PM can fill it in on any CO that needs
it, and every new CO picks it up automatically from its portfolio.

SAFETY
------
One ADD COLUMN, nullable, no server_default, no index (the CO header is reached
by `change_orders.id`; nobody searches change orders by job number). On Postgres
that is metadata-only — no rewrite, no backfill, and nothing touching
`total_amount` or any other money field.

Same `lock_timeout` guard as pn1a2b3c4d5e6, for the same reason: env.py runs the
upgrade in one transaction, and a queued ACCESS EXCLUSIVE on `change_orders`
would block reads behind it while the previous revision is still serving.
"""
from alembic import op
import sqlalchemy as sa


revision: str = "pn2b3c4d5e6f7"
down_revision: str = "pn1a2b3c4d5e6"
branch_labels = None
depends_on = None


def _fail_fast_on_lock() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET lock_timeout = '5s'")


def upgrade() -> None:
    _fail_fast_on_lock()
    op.add_column(
        "change_orders", sa.Column("project_number", sa.String(length=50), nullable=True),
    )


def downgrade() -> None:
    _fail_fast_on_lock()
    op.drop_column("change_orders", "project_number")
