"""Change Order delivery tracking: archived PDF path + emailed-to/at

Revision ID: co6c7d8e9f0a1
Revises: p1a2b3c4d5e6
Create Date: 2026-06-29 18:00:00.000000

Completes the CO lifecycle (create -> approve -> deliver). On approval the
branded PDF is archived to storage (pdf_storage_path); emailing it to the client
records sent_at + sent_to. Additive, nullable.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'co6c7d8e9f0a1'
down_revision: Union[str, Sequence[str], None] = 'p1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.add_column(sa.Column('pdf_storage_path', sa.String(length=500), nullable=True))
        batch.add_column(sa.Column('sent_at', sa.DateTime(), nullable=True))
        batch.add_column(sa.Column('sent_to', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.drop_column('sent_to')
        batch.drop_column('sent_at')
        batch.drop_column('pdf_storage_path')
