"""Change Order v2 fields: header Location/State/Size MW + per-line role

Revision ID: co1d2e3f4a5b6
Revises: co0a1b2c3d4e5
Create Date: 2026-06-26 12:00:00.000000

Adds the PDF-header fields the Castillo "Change Order - Summary of Services"
template carries (location, state, size_mw on change_orders) and the hourly
rate-card role label (role on change_order_line_items). Additive, nullable
columns; batch_alter_table keeps it SQLite-safe. A fresh DB gets these via
create_all (models.py already declares them) and is stamped at this head;
an existing DB picks them up here.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'co1d2e3f4a5b6'
down_revision: Union[str, Sequence[str], None] = 'co0a1b2c3d4e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.add_column(sa.Column('location', sa.String(length=200), nullable=True))
        batch.add_column(sa.Column('state', sa.String(length=50), nullable=True))
        batch.add_column(sa.Column('size_mw', sa.String(length=50), nullable=True))
    with op.batch_alter_table('change_order_line_items') as batch:
        batch.add_column(sa.Column('role', sa.String(length=100), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('change_order_line_items') as batch:
        batch.drop_column('role')
    with op.batch_alter_table('change_orders') as batch:
        batch.drop_column('size_mw')
        batch.drop_column('state')
        batch.drop_column('location')
