"""add MeetingTemplate.last_used_at

Revision ID: e7c1f9b03a92
Revises: d4a8b22c9e1f
Create Date: 2026-05-27 17:00:00.000000

Tracks when each recurring-meeting template was last cloned. The Capture
page sorts by this column to surface the PM's most-used templates as
one-click cards above the dropdown. Nullable — existing rows pre-date
the column and get treated as "never cloned" (sort last).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e7c1f9b03a92'
down_revision: Union[str, Sequence[str], None] = 'd4a8b22c9e1f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('meeting_templates') as batch_op:
        batch_op.add_column(
            sa.Column('last_used_at', sa.DateTime(), nullable=True),
        )


def downgrade() -> None:
    with op.batch_alter_table('meeting_templates') as batch_op:
        batch_op.drop_column('last_used_at')
