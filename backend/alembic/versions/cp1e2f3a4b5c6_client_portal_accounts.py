"""Client portal accounts: username/password login that mints a portal session.

Revision ID: cp1e2f3a4b5c6
Revises: cp0a1b2c3d4e5
Create Date: 2026-09-02

WHY THIS BUILDS ON THE INVITE TOKEN RATHER THAN BESIDE IT
---------------------------------------------------------
A successful password login does not create a new kind of credential. It
mints a ``client_portal_tokens`` row of ``kind = 'session'`` — the same row
type an invite link is — and hands the raw token to the browser exactly as an
invite link would. Every scope rule, every allowlist and every test written
for the portal therefore applies to logged-in clients unchanged. There is one
principal type on the portal side, reached by two doors.

WHAT THE ACCOUNT TABLE DOES AND DOES NOT DO
-------------------------------------------
  password_hash        argon2id via argon2-cffi. Never anything weaker.
  failed_attempts /    Per-account lockout: five consecutive failures locks
  locked_until         for fifteen minutes. The lock is NOT extended by further
                       attempts made while it holds; sustained re-locking is
                       bounded by the per-source throttle on the login route.
  must_change_password Set on admin-issued temporary passwords; the portal
                       refuses everything but change-password until cleared.
  is_active            Deactivation is immediate: the auth dependency checks it
                       on every request, not only at login.

There is deliberately NO self-service password reset in this revision. That
is an email-based surface with its own attack shape; resets are admin-driven
(a new temporary password, shown once) until that surface is designed.

``client_portal_tokens.kind`` distinguishes invite links from sessions so the
admin screen can show them apart and so "revoke all sessions for this account"
never touches an invite link issued to the same client.
"""
from alembic import op
import sqlalchemy as sa

revision = "cp1e2f3a4b5c6"
down_revision = "cp0a1b2c3d4e5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "client_portal_accounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_id", sa.Integer(), sa.ForeignKey("clients.id"), nullable=False),
        sa.Column("contact_id", sa.Integer(), sa.ForeignKey("client_contacts.id"), nullable=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("display_name", sa.String(200), nullable=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("failed_attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("locked_until", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("last_login_at", sa.DateTime(), nullable=True),
        sa.Column("password_changed_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("email", name="uq_client_portal_accounts_email"),
    )
    op.create_index("ix_client_portal_accounts_client_id", "client_portal_accounts", ["client_id"])

    op.add_column("client_portal_tokens", sa.Column("account_id", sa.Integer(), nullable=True))
    op.create_index("ix_client_portal_tokens_account_id", "client_portal_tokens", ["account_id"])
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_client_portal_tokens_account_id", "client_portal_tokens",
            "client_portal_accounts", ["account_id"], ["id"],
        )
    op.add_column(
        "client_portal_tokens",
        sa.Column("kind", sa.String(16), nullable=False, server_default="invite"),
    )


def downgrade() -> None:
    op.drop_column("client_portal_tokens", "kind")
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint("fk_client_portal_tokens_account_id", "client_portal_tokens", type_="foreignkey")
    op.drop_index("ix_client_portal_tokens_account_id", table_name="client_portal_tokens")
    op.drop_column("client_portal_tokens", "account_id")
    op.drop_index("ix_client_portal_accounts_client_id", table_name="client_portal_accounts")
    op.drop_table("client_portal_accounts")
