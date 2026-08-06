"""co_approval_requests: who was asked to approve a CO, and what they said

Purely additive — one CREATE TABLE, no ALTER on anything that exists, so there
is no data to migrate and nothing here that can fail on existing rows. That
matters more than usual: prestart.py runs `alembic upgrade head` at container
BOOT, so a migration that raises does not fail a deploy, it takes production
down.

WHY A TABLE AND NOT MORE COLUMNS ON change_orders. An approval there is four
mutable columns and POST /api/change-orders/{id}/reject NULLs all four, so a CO
that was approved and later sent back carries no record that anyone ever
approved it, or was ever even asked. These rows are the durable half: reject
closes them out by `status` and never deletes one.

NO BOOLEAN COLUMNS, on purpose. `status` carries five outcomes (pending,
approved, rejected, superseded, cancelled) and three of them mean "did not
answer" for three different reasons. Worth stating because the boolean trap on
this project is specific: a boolean added with server_default=sa.text("1") is
accepted by SQLite and REJECTED by Postgres (integer default on a boolean
column), the ALTER fails, prestart exits non-zero and the container never
boots. If a boolean is ever added here, it is sa.true()/sa.false().

This table is built two different ways and they have to agree exactly: an
EXISTING database gets it from this file, a FRESH one from
`Base.metadata.create_all` (prestart.py never replays migrations for a new DB).
Every column below therefore mirrors db/models.py::ChangeOrderApprovalRequest
literally — including the absence of a server_default on `requested_at`, which
the model fills Python-side with `default=datetime.utcnow`, so a
`server_default=now()` here would give a migrated database a DDL default a
fresh one does not have.

CONSTRAINTS ARE DELIBERATELY LEFT UNNAMED, which differs from co0a1b2c3d4e5 and
cc1a2b3c4d5e6 nearby. Those name their primary and foreign keys; `create_all`
does not, and there is no `naming_convention` on `Base.metadata` to make the two
agree — so every table built that way already carries the same constraints under
two different sets of names depending on which path built the database. Since
prod is migrated and every fresh environment is create_all, a later
`op.drop_constraint('fk_co_approval_requests_co', ...)` would succeed on one and
fail on the other, and a failed ALTER here is a container that does not boot.
Matching create_all exactly is the only shape that cannot do that. (Fixing it
the other way — a naming convention on the metadata — would rename constraints
across all 39 existing tables and does not belong in this migration.)

Revision ID: ca0b1c2d3e4f5
Revises: cc1a2b3c4d5e6
Create Date: 2026-08-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'ca0b1c2d3e4f5'
down_revision: Union[str, Sequence[str], None] = 'cc1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'co_approval_requests',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('change_order_id', sa.Integer(), nullable=False),
        # Nullable: an approver picked from the Entra directory may have no
        # `users` row until their first authenticated request, which happens
        # after they were asked. The email below is the required half.
        sa.Column('requested_user_id', sa.Integer(), nullable=True),
        sa.Column('requested_name', sa.String(length=200), nullable=True),
        sa.Column('requested_email', sa.String(length=200), nullable=False),
        sa.Column('requested_by_id', sa.Integer(), nullable=True),
        sa.Column('requested_at', sa.DateTime(), nullable=False),
        # NOT NULL with no default is safe here only because the table is new:
        # there are no existing rows to backfill, and the one write path
        # (POST /{co_id}/request-approval) always snapshots it off the CO.
        sa.Column('co_version_at_request', sa.Integer(), nullable=False),
        sa.Column('total_at_request', sa.Float(), nullable=True),
        sa.Column(
            'status', sa.String(length=20),
            server_default='pending', nullable=False,
        ),
        sa.Column('responded_at', sa.DateTime(), nullable=True),
        sa.Column('responded_by_user_id', sa.Integer(), nullable=True),
        sa.Column('response_note', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(['change_order_id'], ['change_orders.id']),
        sa.ForeignKeyConstraint(['requested_user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['requested_by_id'], ['users.id']),
        sa.ForeignKeyConstraint(['responded_by_user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    # Name matches what `index=True` on the model produces under SQLAlchemy's
    # default naming convention (ix_<table>_<column>), so the migrated and the
    # create_all schema carry the same index under the same name.
    op.create_index(
        'ix_co_approval_requests_change_order_id',
        'co_approval_requests', ['change_order_id'],
    )


def downgrade() -> None:
    # Index first: Postgres would drop it with the table, but SQLite keeps index
    # names in a schema-wide namespace, so dropping it explicitly makes the
    # downgrade re-upgradable on both backends rather than only on one.
    op.drop_index(
        'ix_co_approval_requests_change_order_id',
        table_name='co_approval_requests',
    )
    op.drop_table('co_approval_requests')
