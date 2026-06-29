"""Change Order: preparer contact (phone + email) for the back-cover PREPARED BY

Revision ID: co5b6c7d8e9f0
Revises: co4a5b6c7d8e9
Create Date: 2026-06-29 16:00:00.000000

Adds signatory_phone + signatory_email to change_orders. With signatory_name /
signatory_title these drive the dynamic "PREPARED BY" block overlaid on the
back cover (page 4) of the deliverable. Additive, nullable.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'co5b6c7d8e9f0'
down_revision: Union[str, Sequence[str], None] = 'co4a5b6c7d8e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.add_column(sa.Column('signatory_phone', sa.String(length=50), nullable=True))
        batch.add_column(sa.Column('signatory_email', sa.String(length=200), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.drop_column('signatory_email')
        batch.drop_column('signatory_phone')
