"""New users no longer start with change-order create/approve rights.

Revision ID: cd2e3f4a5b6c7
Revises: ca0b1c2d3e4f5
Create Date: 2026-08-06

WHY
---
`users.can_co_creation` and `users.can_co_approval` shipped defaulting to TRUE,
so anyone signing in for the first time was auto-provisioned (see
auth/dependencies.py::_upsert_user_row) able to create, edit, delete or approve
ANY change order in the company, and to read every one of them including
internal notes and the PMO/Admin markup.

That was survivable while a first sign-in meant a new hire arriving through the
front door. Change-order approval requests (revision ca0b1c2d3e4f5) mail a
sign-in link to named approvers who have never opened the app, so forwarding a
single link now hands the recipient full change-order power from their first
click. An admin grants these in Settings instead — a deliberate act by someone
who knows what it confers.

WHAT THIS DOES AND DOES NOT DO
------------------------------
ALTER COLUMN ... SET DEFAULT only changes what a future INSERT gets when it
omits the column. It does NOT rewrite rows, does NOT validate existing data and
does NOT touch anybody who already has these permissions — every current user
keeps exactly what they have today. There is no table rewrite and nothing here
can fail on existing data.

The ORM-side `default=` in db/models.py must move in the same commit: a fresh
database is built by `create_all` + `alembic stamp head` and never replays
migrations, so the model is the only thing a new deployment sees. The two are
asserted equal at boot by auth.permissions.verify_permission_model(), which
raises rather than let a migrated and a fresh database disagree.

sa.false() rather than sa.text("0"): Postgres rejects an integer default on a
boolean column, and a failed ALTER fails the container boot.
"""
from alembic import op
import sqlalchemy as sa


revision: str = "cd2e3f4a5b6c7"
down_revision: str = "ca0b1c2d3e4f5"
branch_labels = None
depends_on = None

_COLUMNS = ("can_co_creation", "can_co_approval")


def upgrade() -> None:
    for column in _COLUMNS:
        op.alter_column(
            "users",
            column,
            existing_type=sa.Boolean(),
            existing_nullable=False,
            server_default=sa.false(),
        )


def downgrade() -> None:
    for column in _COLUMNS:
        op.alter_column(
            "users",
            column,
            existing_type=sa.Boolean(),
            existing_nullable=False,
            server_default=sa.true(),
        )
