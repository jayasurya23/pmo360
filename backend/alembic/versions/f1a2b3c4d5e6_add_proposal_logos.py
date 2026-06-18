"""add proposal branding logos

Revision ID: f1a2b3c4d5e6
Revises: c5e1a9f4b2d7
Create Date: 2026-06-18 16:00:00.000000

Two nullable Text columns on ``proposals`` holding data-URL images for the
generated deliverable's header band:
  - company_logo : NULL => fall back to the bundled Castillo logo (default).
  - client_logo  : NULL => no client logo rendered (empty unless uploaded).

Set/cleared via PUT /api/proposals/{id}/logos. (Fresh DBs get these straight
from models.py via create_all; this migration covers existing/prod databases.)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'c5e1a9f4b2d7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('proposals', sa.Column('company_logo', sa.Text(), nullable=True))
    op.add_column('proposals', sa.Column('client_logo', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('proposals', 'client_logo')
    op.drop_column('proposals', 'company_logo')
