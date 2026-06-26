"""Change Order signatory: Castillo Print Name + Title on the signature block

Revision ID: co2e3f4a5b6c7
Revises: co1d2e3f4a5b6
Create Date: 2026-06-26 14:00:00.000000

Adds signatory_name + signatory_title to change_orders. These pre-fill the
Castillo Engineering Services column of the PDF signature block (Print Name /
Title), chosen in-app from the company's people. Additive, nullable; a fresh DB
gets them via create_all (models.py declares them) and is stamped at this head.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'co2e3f4a5b6c7'
down_revision: Union[str, Sequence[str], None] = 'co1d2e3f4a5b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.add_column(sa.Column('signatory_name', sa.String(length=200), nullable=True))
        batch.add_column(sa.Column('signatory_title', sa.String(length=200), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.drop_column('signatory_title')
        batch.drop_column('signatory_name')
