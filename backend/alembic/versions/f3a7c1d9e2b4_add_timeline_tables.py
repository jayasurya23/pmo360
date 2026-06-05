"""add Timeline Estimator tables

Revision ID: f3a7c1d9e2b4
Revises: b2f8a14d57e3
Create Date: 2026-06-05 16:00:00.000000

Standalone resource-loaded capacity planner (not tied to the meeting
Client/Project tables):
  - timeline_resources   : engineer rows (or free-text placeholders), grouped
                           by discipline; optional link to a User.
  - timeline_projects    : standalone projects (name/client/status).
  - timeline_assignments : the bars — project ⨯ resource ⨯ date-range ⨯
                           %utilization ⨯ discipline ⨯ milestone.

Named constraints throughout so SQLite batch ALTER works for future migrations.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f3a7c1d9e2b4'
down_revision: Union[str, Sequence[str], None] = 'b2f8a14d57e3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'timeline_resources',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('discipline', sa.String(length=40), nullable=True),
        sa.Column('title', sa.String(length=80), nullable=True),
        sa.Column('is_placeholder', sa.Boolean(), nullable=True),
        sa.Column('active', sa.Boolean(), nullable=True),
        sa.Column('order_index', sa.Integer(), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], name='fk_timeline_resources_user'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name='fk_timeline_resources_created_by'),
        sa.PrimaryKeyConstraint('id', name='pk_timeline_resources'),
    )
    op.create_table(
        'timeline_projects',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=300), nullable=False),
        sa.Column('client', sa.String(length=200), nullable=True),
        sa.Column('status', sa.String(length=30), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name='fk_timeline_projects_created_by'),
        sa.PrimaryKeyConstraint('id', name='pk_timeline_projects'),
    )
    op.create_table(
        'timeline_assignments',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('timeline_project_id', sa.Integer(), nullable=False),
        sa.Column('resource_id', sa.Integer(), nullable=True),
        sa.Column('discipline', sa.String(length=40), nullable=True),
        sa.Column('milestone', sa.String(length=60), nullable=True),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=False),
        sa.Column('utilization', sa.Float(), nullable=True),
        sa.Column('status', sa.String(length=30), nullable=True),
        sa.Column('label', sa.String(length=200), nullable=True),
        sa.Column('order_index', sa.Integer(), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ['timeline_project_id'], ['timeline_projects.id'],
            name='fk_timeline_assignments_project',
        ),
        sa.ForeignKeyConstraint(
            ['resource_id'], ['timeline_resources.id'],
            name='fk_timeline_assignments_resource',
        ),
        sa.ForeignKeyConstraint(
            ['created_by_id'], ['users.id'],
            name='fk_timeline_assignments_created_by',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_timeline_assignments'),
    )


def downgrade() -> None:
    op.drop_table('timeline_assignments')
    op.drop_table('timeline_projects')
    op.drop_table('timeline_resources')
