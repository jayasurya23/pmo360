"""users: per-module write permissions + title/department

Revision ID: pm1a2b3c4d5e6
Revises: ua1b2c3d4e5f6
Create Date: 2026-08-04

Ten additive columns behind the User Management grid: eight permission flags
and the two directory attributes (title, department) the grid shows next to
the name.

THE BACKFILL IS THE DANGEROUS PART, and the two obvious answers are both
wrong on their own:
  - grant nothing  -> every PM loses the ability to do their job the moment
                      this deploys, because prestart.py runs migrations at
                      container boot. That's a self-inflicted outage.
  - grant everything -> the console flags (user_mgmt, client_mgmt) were
                      admin-only before this change. Defaulting them true
                      would hand the entire company the admin console on
                      deploy — a privilege escalation shipped as a "no-op".

So the backfill is split by what the status quo actually was:
  - the six portfolio permissions -> TRUE for every existing row. Everyone
    demonstrably does this work today; effective access is unchanged and the
    feature starts earning its keep the first time an admin unticks a box.
  - user_mgmt / client_mgmt       -> FALSE for every existing row. Admins
    still reach the console through is_admin (the super-role implies every
    permission), so this preserves exactly who could open it yesterday.

Net effect on deploy day: nobody gains access, nobody loses access.

Booleans use sa.true()/sa.false(), never sa.text("1") — Postgres rejects an
integer DEFAULT on a boolean column and the failed ALTER would fail the
container boot. That bit an earlier migration on this branch.

The server_defaults are deliberately NOT dropped after the backfill: they are
what lets seed scripts and raw INSERTs keep omitting these columns, and they
must stay byte-identical to db/models.py because prestart.py builds a FRESH
database with create_all + stamp head and never replays this file.

Plain op.add_column, no batch_alter_table: SQLite supports ALTER TABLE ADD
COLUMN natively when the new column carries a default, and batch mode would
needlessly rebuild `users` along with every FK pointing at it.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "pm1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "ua1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Kept as data so the upgrade and downgrade can't disagree about the column
# list. Order matches the grid columns in auth/permissions.py.
_GRANTED_ON_UPGRADE = (
    "can_meeting_minutes",
    "can_co_creation",
    "can_co_approval",
    "can_agenda",
    "can_proposals",
    "can_timeline",
)
_WITHHELD_ON_UPGRADE = (
    "can_user_mgmt",
    "can_client_mgmt",
)
_DIRECTORY_COLUMNS = ("title", "department")


def upgrade() -> None:
    for name in _GRANTED_ON_UPGRADE:
        op.add_column(
            "users",
            sa.Column(
                name, sa.Boolean(), nullable=False, server_default=sa.true(),
            ),
        )
    for name in _WITHHELD_ON_UPGRADE:
        op.add_column(
            "users",
            sa.Column(
                name, sa.Boolean(), nullable=False, server_default=sa.false(),
            ),
        )
    # Nullable with no default: NULL means "we have never learned this from
    # Entra", which is a real state and distinct from an admin blanking it.
    for name in _DIRECTORY_COLUMNS:
        op.add_column("users", sa.Column(name, sa.String(200), nullable=True))


def downgrade() -> None:
    for name in reversed(
        _GRANTED_ON_UPGRADE + _WITHHELD_ON_UPGRADE + _DIRECTORY_COLUMNS
    ):
        op.drop_column("users", name)
