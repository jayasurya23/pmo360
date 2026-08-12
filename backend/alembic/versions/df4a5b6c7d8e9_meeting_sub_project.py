"""Meetings can be attached to a sub-project, and the actions they raise inherit it.

Revision ID: df4a5b6c7d8e9
Revises: ce3f4a5b6c7d8
Create Date: 2026-08-12

WHY
---
`ce3f4a5b6c7d8` let a single ACTION be filed against a sub-project. That is the
right granularity but the wrong amount of typing: a call that is entirely about
one sub-project meant tagging every action it raised, one at a time.

Tagging the MEETING says it once. Every action raised in that meeting then
defaults to the same sub-project. The inheritance is a default and not a
constraint — an action carrying its own tag keeps it, because a meeting about
one project can still raise an action about another.

WHY THIS IS A NULLABLE ADD AND NOTHING ELSE
-------------------------------------------
Identical shape and identical reasoning to the action-item column. `project_id`
(the portfolio) stays NOT NULL, so every portfolio-scoped query keeps working
untouched and roll-up is free. NULL keeps meaning "the portfolio as a whole",
which is what all existing meetings mean — nothing to backfill, no guess to
make, and no meeting changes behaviour until somebody deliberately tags one.

The rule the schema cannot express — the sub-project must belong to THIS
meeting's portfolio — is two hops away and lives in the API, same as before.

SAFETY
------
One ADD COLUMN, nullable, no default, plus its index. No rewrite, no backfill,
nothing that can fail on existing rows, no change to any existing column.
Postgres adds a nullable column without a table rewrite.
"""
from alembic import op
import sqlalchemy as sa


revision: str = "df4a5b6c7d8e9"
down_revision: str = "ce3f4a5b6c7d8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "meetings",
        sa.Column("portfolio_project_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_meetings_portfolio_project_id",
        "meetings",
        ["portfolio_project_id"],
    )
    # Named so the downgrade can drop it. SQLite cannot ALTER a table to add a
    # constraint, so the FK is created inline there by create_all and skipped
    # here; batch_alter_table would rebuild the table, which is a far bigger
    # risk than this app's SQLite dev DBs are worth.
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_meetings_portfolio_project_id",
            "meetings",
            "portfolio_projects",
            ["portfolio_project_id"],
            ["id"],
        )


def downgrade() -> None:
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint(
            "fk_meetings_portfolio_project_id", "meetings", type_="foreignkey",
        )
    op.drop_index("ix_meetings_portfolio_project_id", table_name="meetings")
    op.drop_column("meetings", "portfolio_project_id")
