"""add meeting_templates table

Revision ID: 0537d6c0fc8a
Revises: a91e2c4f6b0d
Create Date: 2026-05-26 14:31:15.268799

Introduces the `meeting_templates` table — a reusable boilerplate for
recurring meetings (attendees, agenda topics, default deliverables,
duration). Cloning a template on Capture pre-fills the in-progress draft
so PMs running the same weekly coordination meeting don't retype the 80%
that never changes.

FK constraints are explicitly named to match the convention used by the
512729ab4732 migration — keeps SQLite batch_alter_table happy if we ever
need to alter this table later.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0537d6c0fc8a'
down_revision: Union[str, Sequence[str], None] = 'a91e2c4f6b0d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'meeting_templates',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('attendees_json', sa.JSON(), nullable=True),
        sa.Column('agenda_topics_json', sa.JSON(), nullable=True),
        sa.Column('default_duration_minutes', sa.Integer(), nullable=True),
        sa.Column('default_deliverables_json', sa.JSON(), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ['project_id'], ['projects.id'],
            name='fk_meeting_templates_project_id',
        ),
        sa.ForeignKeyConstraint(
            ['created_by_id'], ['users.id'],
            name='fk_meeting_templates_created_by',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_meeting_templates'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('meeting_templates')
