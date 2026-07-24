"""Change Order editable project label: project_name snapshot column

Revision ID: co7d8e9f0a1b2
Revises: pp1a2b3c4d5e6
Create Date: 2026-07-24 20:00:00.000000

Adds an editable Project label to a change order (snapshot for the PDF +
History), pre-filled from the portfolio name on create but overridable. Falls
back to the portfolio name when null (legacy rows). Additive, nullable.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'co7d8e9f0a1b2'
down_revision: Union[str, Sequence[str], None] = 'pp1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.add_column(sa.Column('project_name', sa.String(length=200), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.drop_column('project_name')
