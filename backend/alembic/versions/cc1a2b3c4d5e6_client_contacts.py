"""client_contacts: the client-side address book

Purely additive — one new table, no ALTER on anything that exists, so there is
no data to migrate and nothing that can fail on the way up. That matters more
here than usual: prestart.py runs `alembic upgrade head` at container BOOT, so
a migration that raises does not fail a deploy, it takes production down.

NO UNIQUE CONSTRAINT ON `email`, deliberately — the reasoning is on
`db/models.py::ClientContact` and belongs there rather than duplicated here.
The two indexes are non-unique and exist for the `?client_id=` filter and the
duplicate probe on write.

This table is built two different ways and they have to agree exactly: an
EXISTING database gets it from this file, a FRESH one from
`Base.metadata.create_all` (prestart.py never replays migrations for a new
DB). Every column below therefore mirrors the model literally, including the
absence of a server_default on `created_at` — the model uses a Python-side
`default=datetime.utcnow`, so a `server_default=now()` here would give a
migrated database a DDL default that a fresh one does not have.

Revision ID: cc1a2b3c4d5e6
Revises: um1a2b3c4d5e6
"""
from alembic import op
import sqlalchemy as sa


revision = "cc1a2b3c4d5e6"
down_revision = "um1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "client_contacts",
        sa.Column("id", sa.Integer(), nullable=False),
        # Nullable: an import that cannot place somebody by email domain still
        # files them, unparented, for an admin to assign.
        sa.Column("client_id", sa.Integer(), nullable=True),
        sa.Column("first_name", sa.String(length=120), nullable=True),
        sa.Column("last_name", sa.String(length=120), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("email", sa.String(length=200), nullable=True),
        sa.Column("domain", sa.String(length=100), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["client_id"], ["clients.id"], name="fk_client_contacts_client",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_client_contacts"),
    )
    op.create_index(
        "ix_client_contacts_client_id", "client_contacts", ["client_id"],
    )
    op.create_index(
        "ix_client_contacts_email", "client_contacts", ["email"],
    )


def downgrade() -> None:
    # Indexes first: Postgres would drop them with the table, but SQLite keeps
    # index names in a schema-wide namespace, so dropping them explicitly makes
    # the downgrade re-upgradable on both backends rather than only on one.
    op.drop_index("ix_client_contacts_email", table_name="client_contacts")
    op.drop_index("ix_client_contacts_client_id", table_name="client_contacts")
    op.drop_table("client_contacts")
