"""timeline_projects.source_proposal_id unique (one project per proposal)

Revision ID: e1f2a3b4c5d6
Revises: a7b8c9d0e1f2
Create Date: 2026-06-19 15:45:00.000000

Make source_proposal_id UNIQUE so the bulk "Send to Timeline" import and the
milestone palette always resolve the SAME single timeline project per proposal
(no duplicates → get-or-create is unambiguous). Multiple NULLs (hand-built
projects) are still allowed by both SQLite and Postgres unique indexes. Replaces
the plain index added in a7b8c9d0e1f2.
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'e1f2a3b4c5d6'
down_revision: Union[str, Sequence[str], None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index('ix_timeline_projects_source_proposal_id', table_name='timeline_projects')
    op.create_index(
        'ix_timeline_projects_source_proposal_id',
        'timeline_projects', ['source_proposal_id'], unique=True,
    )


def downgrade() -> None:
    op.drop_index('ix_timeline_projects_source_proposal_id', table_name='timeline_projects')
    op.create_index(
        'ix_timeline_projects_source_proposal_id',
        'timeline_projects', ['source_proposal_id'],
    )
