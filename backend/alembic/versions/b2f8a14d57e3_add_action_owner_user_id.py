"""add ActionItem.owner_user_id

Revision ID: b2f8a14d57e3
Revises: e7c1f9b03a92
Create Date: 2026-05-27 18:00:00.000000

First-class link from ActionItem to the PM (User row) who owns it. The
freeform ``owner`` string stays — it's still the display source for action
log PDFs + non-PMO owners (vendors, contractors). The new column unlocks:

  - Reliable "actions assigned to me" filtering on the dashboard (was
    doing a substring-match-on-display-name fallback that produced false
    positives e.g. "John Smith" matched any owner containing "John").
  - Future email notifications when an action is created / due tomorrow /
    overdue — needs a User row to send to.

Nullable so existing rows stay valid; the frontend backfills owner_user_id
as PMs interact with the action through the typeahead picker.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2f8a14d57e3'
down_revision: Union[str, Sequence[str], None] = 'e7c1f9b03a92'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('action_items') as batch_op:
        batch_op.add_column(
            sa.Column('owner_user_id', sa.Integer(), nullable=True),
        )
        batch_op.create_foreign_key(
            'fk_action_items_owner_user',
            'users',
            ['owner_user_id'],
            ['id'],
        )


def downgrade() -> None:
    with op.batch_alter_table('action_items') as batch_op:
        batch_op.drop_constraint('fk_action_items_owner_user', type_='foreignkey')
        batch_op.drop_column('owner_user_id')
