"""Change Order hourly line: per-person allocations (role/rate/hours list)

Revision ID: co3f4a5b6c7d8
Revises: co2e3f4a5b6c7
Create Date: 2026-06-26 16:00:00.000000

One hourly task can involve several people at different rates. Adds an
`allocations` JSON column to change_order_line_items holding
[{"role", "rate", "hours"}, ...]; the line total is sum(rate*hours). The legacy
single role/hourly_rate/hours columns remain as a fallback. Additive, nullable.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'co3f4a5b6c7d8'
down_revision: Union[str, Sequence[str], None] = 'co2e3f4a5b6c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('change_order_line_items') as batch:
        batch.add_column(sa.Column('allocations', sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('change_order_line_items') as batch:
        batch.drop_column('allocations')
