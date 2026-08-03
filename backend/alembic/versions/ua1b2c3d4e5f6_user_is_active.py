"""users.is_active — offboarding flag for the admin User management screen

Revision ID: ua1b2c3d4e5f6
Revises: co8e9f0a1b2c3
Create Date: 2026-08-03

Additive, NOT NULL, `server_default=true` so every pre-existing row lands
ACTIVE. Getting that default wrong would offboard the entire company on the
next deploy (prestart.py runs this at container boot), so the default is a
dialect-compiled `sa.true()` rather than a literal: Postgres rejects
`DEFAULT 1` on a boolean column, and a failed ALTER here fails the boot.

The default is deliberately NOT dropped after the backfill — it lets the
seed scripts and raw INSERTs keep omitting the column, same as `is_admin`.

Plain op.add_column (no batch_alter_table): SQLite supports ALTER TABLE ADD
COLUMN natively as long as the new column has a default, and batch mode would
needlessly recreate `users` along with every FK that points at it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "ua1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "co8e9f0a1b2c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.true(),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "is_active")
