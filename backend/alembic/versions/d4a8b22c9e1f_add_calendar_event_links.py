"""add CalendarEventLink table

Revision ID: d4a8b22c9e1f
Revises: f97f25aa6b4c
Create Date: 2026-05-27 13:00:00.000000

Persistent manual matches between Microsoft Graph calendar event ids and
PMO 360 portfolios. /api/calendar/match consults this table first; the
attendee-email and subject-substring heuristics are only used when no
manual link exists for the event id.

Schema:
  - graph_event_id (UNIQUE, NOT NULL) — Microsoft Graph event id
  - project_id (FK projects, NOT NULL)
  - linked_by_id (FK users, NULL allowed for backfills)
  - linked_at, updated_at (timestamps)

Named constraints throughout so SQLite batch ALTER works for future migrations.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4a8b22c9e1f'
down_revision: Union[str, Sequence[str], None] = 'f97f25aa6b4c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'calendar_event_links',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('graph_event_id', sa.String(length=300), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('linked_by_id', sa.Integer(), nullable=True),
        sa.Column('linked_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ['linked_by_id'], ['users.id'],
            name='fk_calendar_event_links_linked_by',
        ),
        sa.ForeignKeyConstraint(
            ['project_id'], ['projects.id'],
            name='fk_calendar_event_links_project',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_calendar_event_links'),
        sa.UniqueConstraint(
            'graph_event_id',
            name='uq_calendar_event_links_graph_event_id',
        ),
    )


def downgrade() -> None:
    op.drop_table('calendar_event_links')
