"""add timeline_timeoff (blocked / out-of-office ranges per resource)

Revision ID: a1b2c3d4e5f6
Revises: f3a7c1d9e2b4
Create Date: 2026-06-08 14:40:00.000000

A blocked date range for a resource — OOO, PTO, holiday, training. Reduces
the resource's available capacity in the workload view; does not count as
project work.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = 'f3a7c1d9e2b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'timeline_timeoff',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('resource_id', sa.Integer(), nullable=False),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=False),
        sa.Column('reason', sa.String(length=80), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ['resource_id'], ['timeline_resources.id'],
            name='fk_timeline_timeoff_resource',
        ),
        sa.ForeignKeyConstraint(
            ['created_by_id'], ['users.id'],
            name='fk_timeline_timeoff_created_by',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_timeline_timeoff'),
    )


def downgrade() -> None:
    op.drop_table('timeline_timeoff')
