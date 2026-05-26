"""add previous_last_seen_at to users

Revision ID: 91887fae6181
Revises: 0537d6c0fc8a
Create Date: 2026-05-26 14:55:54.846049

Adds a `previous_last_seen_at` column to `users`. Captures the value
`last_seen_at` held BEFORE the auth dependency bumped it on the current
request. The Home "AI briefing" endpoint reads this column as the cutoff
for "what's changed since the PM was last here?". Without it, the
briefing always sees `last_seen_at == now()` (the auth upsert ran first)
and reports zero deltas every time.

SQLite quirk: batch ALTER on `users` is fine here because we're only
adding a nullable column with no FK or constraint, but we keep the batch
context for consistency with the surrounding migrations.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '91887fae6181'
down_revision: Union[str, Sequence[str], None] = '0537d6c0fc8a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("previous_last_seen_at", sa.DateTime(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("previous_last_seen_at")
