"""Project-level location / state / size_mw (reusable project facts)

Revision ID: p1a2b3c4d5e6
Revises: co5b6c7d8e9f0
Create Date: 2026-06-29 17:00:00.000000

Stores Location / State / Size (MW) on the project (portfolio) so they're entered
once and reused (e.g. the Change Order header pre-fills from them) rather than
re-typed per document. Additive, nullable.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'p1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'co5b6c7d8e9f0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('projects') as batch:
        batch.add_column(sa.Column('location', sa.String(length=200), nullable=True))
        batch.add_column(sa.Column('state', sa.String(length=50), nullable=True))
        batch.add_column(sa.Column('size_mw', sa.String(length=50), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('projects') as batch:
        batch.drop_column('size_mw')
        batch.drop_column('state')
        batch.drop_column('location')
