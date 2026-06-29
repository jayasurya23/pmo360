"""Change Order: optional client signatory (Print Name + Title)

Revision ID: co4a5b6c7d8e9
Revises: co3f4a5b6c7d8
Create Date: 2026-06-29 14:00:00.000000

Adds client_signatory_name + client_signatory_title to change_orders so the
client column of the PDF signature block can be pre-filled (optional). Additive,
nullable; a fresh DB gets them via create_all and is stamped at this head.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'co4a5b6c7d8e9'
down_revision: Union[str, Sequence[str], None] = 'co3f4a5b6c7d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.add_column(sa.Column('client_signatory_name', sa.String(length=200), nullable=True))
        batch.add_column(sa.Column('client_signatory_title', sa.String(length=200), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.drop_column('client_signatory_title')
        batch.drop_column('client_signatory_name')
