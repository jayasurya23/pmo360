"""timeline_projects.source_proposal_id (proposal import key)

Revision ID: a7b8c9d0e1f2
Revises: f1a2b3c4d5e6
Create Date: 2026-06-18 17:30:00.000000

Adds the edit-proof key the "Send a proposal to the Timeline" import uses to
find+replace its prior import. A loose reference (plain indexed integer, NOT a
FK) so deleting the source proposal never touches the timeline project; NULL for
hand-built projects. (Fresh DBs get it from models.py via create_all; this
migration covers existing/prod databases.)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, Sequence[str], None] = 'f1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('timeline_projects', sa.Column('source_proposal_id', sa.Integer(), nullable=True))
    op.create_index(
        'ix_timeline_projects_source_proposal_id',
        'timeline_projects', ['source_proposal_id'],
    )


def downgrade() -> None:
    op.drop_index('ix_timeline_projects_source_proposal_id', table_name='timeline_projects')
    op.drop_column('timeline_projects', 'source_proposal_id')
