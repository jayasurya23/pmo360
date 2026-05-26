"""add version column to Meeting and Agenda

Revision ID: 336cc442b85e
Revises: c7436b2f3a87
Create Date: 2026-05-22 10:39:02.929747

Introduces an integer `version` column for optimistic concurrency control.
Every existing row gets `1`. The application bumps the column on every save
and a 409 is returned when the client's stale value doesn't match.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '336cc442b85e'
down_revision: Union[str, Sequence[str], None] = 'c7436b2f3a87'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # `server_default="1"` backfills existing rows so the NOT NULL constraint
    # can be enforced. We don't strip the default afterwards — keeping it is
    # harmless and lets raw INSERTs (e.g. the seed script) omit the field.
    with op.batch_alter_table('agendas', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'version', sa.Integer(), nullable=False, server_default="1",
        ))

    with op.batch_alter_table('meetings', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'version', sa.Integer(), nullable=False, server_default="1",
        ))


def downgrade() -> None:
    with op.batch_alter_table('meetings', schema=None) as batch_op:
        batch_op.drop_column('version')
    with op.batch_alter_table('agendas', schema=None) as batch_op:
        batch_op.drop_column('version')
