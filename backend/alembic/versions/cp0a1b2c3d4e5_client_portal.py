"""Client portal: a reserved tenancy column on users, and signed invite tokens.

Revision ID: cp0a1b2c3d4e5
Revises: fb6c7d8e9f0a1
Create Date: 2026-09-01

WHY NOW, WHEN NO CLIENT CAN LOG IN YET
--------------------------------------
Leadership wants clients to eventually see a slice of PMO 360 — status, RFIs,
what they owe us, what they owe — while Castillo's margins and internal
tracking stay hidden. Most of that is deferred until a real client asks. Two
pieces are not deferred, because they are nearly free to add now and expensive
to retrofit once a year of features has grown up assuming every user is
internal:

  users.client_id       NULL means "a Castillo employee". Nothing reads it yet.
                        It exists so no new code can silently assume the whole
                        users table is internal.

  client_portal_tokens  The v1 client identity: a signed invite link, not an
                        account. No Entra guest, no directory, no B2C. A token
                        is issued to a client (optionally to a named contact),
                        hashed at rest, and scopes every portal read to that
                        client's portfolios. Revocation is a timestamp.

WHY A SEPARATE PRINCIPAL AND NOT A ROLE ON users
------------------------------------------------
The two identities must be unable to collide. Internal routes accept only
`Authorization: Bearer <Entra JWT>`; portal routes accept only
`Authorization: Portal <token>`. A portal token presented to an internal
route is malformed-Bearer and treated as anonymous; an Entra JWT presented to
a portal route is malformed-Portal and rejected. Neither side has a code path
that can be talked into honouring the other's credential.

WHY THE TOKEN IS HASHED
-----------------------
The raw token is shown exactly once, at issuance, and never stored. A leaked
database dump therefore yields no usable links. SHA-256 is enough: the token
has 256 bits of entropy from secrets.token_urlsafe, so there is nothing for a
rainbow table to find.
"""
from alembic import op
import sqlalchemy as sa

revision = "cp0a1b2c3d4e5"
down_revision = "fb6c7d8e9f0a1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ---- users.client_id --------------------------------------------------
    op.add_column("users", sa.Column("client_id", sa.Integer(), nullable=True))
    op.create_index("ix_users_client_id", "users", ["client_id"])
    # SQLite cannot ALTER a table to add a constraint; the FK is created inline
    # there by create_all and skipped here. Same idiom as df4a5b6c7d8e9.
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_users_client_id", "users", "clients", ["client_id"], ["id"],
        )

    # ---- action_items.client_owed ----------------------------------------
    # The portal's "what we are waiting on from you" list needs to know which
    # actions are the CLIENT's to close. Nothing in the schema records that:
    # ActionItem.owner is free text that may be initials, a comma list or a
    # vendor, and owner_user_id being NULL means "not a Castillo user", which
    # is vendors as well as clients. Deriving client-owed from either would put
    # third-party names on a client screen. So it is an explicit flag a PM sets.
    # NULL/FALSE = not the client's; nothing is client-owed until somebody says
    # so. Three-valued on purpose: NULL reads as "never triaged", which the
    # internal UI can surface, where FALSE would be indistinguishable from it.
    op.add_column("action_items", sa.Column("client_owed", sa.Boolean(), nullable=True))

    # ---- client_portal_tokens --------------------------------------------
    op.create_table(
        "client_portal_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id"), nullable=False),
        sa.Column("contact_id", sa.Integer(), sa.ForeignKey("client_contacts.id"), nullable=True),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("token_hash", name="uq_client_portal_tokens_token_hash"),
    )
    op.create_index(
        "ix_client_portal_tokens_client_id", "client_portal_tokens", ["client_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_client_portal_tokens_client_id", table_name="client_portal_tokens")
    op.drop_table("client_portal_tokens")
    op.drop_column("action_items", "client_owed")
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint("fk_users_client_id", "users", type_="foreignkey")
    op.drop_index("ix_users_client_id", table_name="users")
    op.drop_column("users", "client_id")
