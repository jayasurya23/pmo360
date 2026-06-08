"""add timeline_resources.available_from (placeholder potential start date)

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-06-08 17:20:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('timeline_resources') as batch:
        batch.add_column(sa.Column('available_from', sa.Date(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('timeline_resources') as batch:
        batch.drop_column('available_from')
