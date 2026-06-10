"""add optimistic-concurrency version to timeline_projects + timeline_assignments

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-06-10 14:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, Sequence[str], None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ("timeline_projects", "timeline_assignments"):
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("version", sa.Integer(), nullable=False, server_default="1"))


def downgrade() -> None:
    for table in ("timeline_assignments", "timeline_projects"):
        with op.batch_alter_table(table) as batch:
            batch.drop_column("version")
