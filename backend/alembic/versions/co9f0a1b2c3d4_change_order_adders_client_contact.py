"""Change Order: PMO/admin cost adders + client signatory contact

Revision ID: co9f0a1b2c3d4
Revises: pm1a2b3c4d5e6
Create Date: 2026-08-04

Four additive columns on change_orders:

  pmo_pct / admin_pct   internal cost adders, percent of the line-item subtotal.
  client_signatory_email / client_signatory_phone
                        the client half of the split signature block, mirroring
                        the Castillo half already added by co5b6c7d8e9f0.

THE ZERO DEFAULT IS THE WHOLE MIGRATION. GET /api/change_orders/{id}/pdf/file
rebuilds every deliverable live from the ORM rather than serving a frozen file,
so these two columns are read on every download of every historical CO. A
non-zero default would re-price change orders that were approved, signed and
emailed months ago — the client would be holding one number and the app would
be printing another. 0 makes this migration a provable no-op for existing rows:
markup of 0% leaves the total and every line exactly where it was.

Float, not Numeric, matching `total_amount` on the same table. The two are
multiplied together on every save; Numeric returns Decimal on Postgres and
Decimal * float is a TypeError, i.e. a 500 on the PDF route. co_pricing.py does
the actual arithmetic in Decimal cents, so precision is protected where it is
spent rather than by a column type that disagrees with its neighbour.

server_default is sa.text("0") — a real SQL numeric default, not a quoted
string. It must stay byte-identical to db/models.py because prestart.py builds
a FRESH database with create_all + stamp head and NEVER replays this file; if
the two drift, a brand-new deploy gets a different schema from a migrated one
and nothing fails loudly.

batch_alter_table, matching co2e3f4a5b6c7 / co4a5b6c7d8e9 / co5b6c7d8e9f0 on
this same table. On Postgres (prod) it is a pass-through to plain ALTERs; on
SQLite it is the rebuild path those three already proved out on change_orders.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'co9f0a1b2c3d4'
down_revision: Union[str, Sequence[str], None] = 'pm1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.add_column(sa.Column(
            'pmo_pct', sa.Float(), nullable=False, server_default=sa.text("0"),
        ))
        batch.add_column(sa.Column(
            'admin_pct', sa.Float(), nullable=False, server_default=sa.text("0"),
        ))
        batch.add_column(sa.Column(
            'client_signatory_email', sa.String(length=200), nullable=True,
        ))
        batch.add_column(sa.Column(
            'client_signatory_phone', sa.String(length=50), nullable=True,
        ))


def downgrade() -> None:
    with op.batch_alter_table('change_orders') as batch:
        batch.drop_column('client_signatory_phone')
        batch.drop_column('client_signatory_email')
        batch.drop_column('admin_pct')
        batch.drop_column('pmo_pct')
