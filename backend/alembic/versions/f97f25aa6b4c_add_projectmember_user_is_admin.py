"""add ProjectMember + User.is_admin

Revision ID: f97f25aa6b4c
Revises: 21337ef77161
Create Date: 2026-05-27 10:34:27.311474

Introduces explicit PM-to-portfolio assignments and an admin escape hatch:

- `project_members` — flat (project_id, user_id) join table. Unique pair.
  Members can fully edit the portfolio and see it on their dashboard.
- `users.is_admin` — when True, the user bypasses ProjectMember filtering
  and implicitly accesses every portfolio. Backfills False for existing
  rows. The auth dependency re-applies the value on each request from the
  ADMIN_EMAILS env var, so it can be flipped without a DB write.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f97f25aa6b4c'
down_revision: Union[str, Sequence[str], None] = '21337ef77161'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'project_members',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ['created_by_id'], ['users.id'],
            name='fk_project_members_created_by',
        ),
        sa.ForeignKeyConstraint(
            ['project_id'], ['projects.id'],
            name='fk_project_members_project',
        ),
        sa.ForeignKeyConstraint(
            ['user_id'], ['users.id'],
            name='fk_project_members_user',
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'project_id', 'user_id',
            name='uq_project_members_project_user',
        ),
    )
    with op.batch_alter_table('users', schema=None) as batch_op:
        # `server_default='0'` (False) backfills every existing row so the
        # NOT NULL constraint passes. We don't strip the default — leaving
        # it lets the seed script + raw INSERTs skip the column.
        batch_op.add_column(sa.Column(
            'is_admin', sa.Boolean(), nullable=False, server_default='0',
        ))


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('is_admin')
    op.drop_table('project_members')
