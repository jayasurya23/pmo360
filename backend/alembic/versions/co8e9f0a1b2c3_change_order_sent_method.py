"""Change Order delivery provenance: how the CO was sent (graph | outlook | manual)

Revision ID: co8e9f0a1b2c3
Revises: fb1a2b3c4d5e6
Create Date: 2026-07-30

Additive, nullable, no server_default. NULL is meaningful here — it reads as
"sent before we tracked the method", a real state distinct from all three
values — so the column must not be defaulted.

The backfill is safe because the Graph send was historically the ONLY path that
could stamp sent_at: the mailto/Outlook fallback never called mark-sent. So
every pre-existing sent_at row was, by construction, a Graph send.

Plain op.add_column (no batch_alter_table): SQLite supports ALTER TABLE ADD
COLUMN natively for a nullable column, and batch mode would needlessly recreate
change_orders and its FKs.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "co8e9f0a1b2c3"
down_revision: Union[str, Sequence[str], None] = "fb1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "change_orders",
        sa.Column("sent_method", sa.String(length=20), nullable=True),
    )
    # op.execute (not op.get_bind().execute) so the backfill also renders under
    # `alembic upgrade --sql` offline review. Dialect-neutral SQL: identical on
    # SQLite and Postgres.
    op.execute(
        "UPDATE change_orders SET sent_method = 'graph' "
        "WHERE sent_at IS NOT NULL AND sent_method IS NULL"
    )


def downgrade() -> None:
    op.drop_column("change_orders", "sent_method")
