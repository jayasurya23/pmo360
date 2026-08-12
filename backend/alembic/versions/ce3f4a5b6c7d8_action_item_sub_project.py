"""Action items can be attached to a sub-project, and rolled up.

Revision ID: ce3f4a5b6c7d8
Revises: cd2e3f4a5b6c7
Create Date: 2026-08-12

WHY
---
Action items attached to the PORTFOLIO and nothing finer. PMs asked to be able
to file one against a specific sub-project ("Cobra") while still seeing it in
the portfolio's rolling list.

WHY THIS IS A NULLABLE ADD AND NOTHING ELSE
-------------------------------------------
`project_id` (the portfolio) stays NOT NULL and unchanged, so roll-up needs no
new query, no union and no second code path: a sub-project action is still a
portfolio action, and every existing portfolio-scoped query already returns it.
NULL keeps meaning "the portfolio as a whole", which is what all 000s of
existing rows mean — so there is nothing to backfill and no guess to make.

The constraint that actually matters — the sub-project must belong to THIS
action's portfolio — is a two-hop rule the schema cannot express, so it lives in
the API. Without it an action could roll up under one portfolio while naming a
sub-project of another.

SAFETY
------
One ADD COLUMN, nullable, no default, plus its index. No rewrite, no backfill,
nothing that can fail on existing rows, and no change to any existing column.
Postgres adds a nullable column without a table rewrite.

The index is on the new column only: it serves "actions for this sub-project"
and is cheap. Portfolio-scoped reads keep using the existing project_id path.
"""
from alembic import op
import sqlalchemy as sa


revision: str = "ce3f4a5b6c7d8"
down_revision: str = "cd2e3f4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "action_items",
        sa.Column("portfolio_project_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_action_items_portfolio_project_id",
        "action_items",
        ["portfolio_project_id"],
    )
    # Named so the downgrade can drop it. SQLite cannot ALTER a table to add a
    # constraint, so the FK is created inline there by create_all and skipped
    # here; batch_alter_table would rebuild the table, which is a far bigger
    # risk than this app's SQLite dev DBs are worth.
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_action_items_portfolio_project_id",
            "action_items",
            "portfolio_projects",
            ["portfolio_project_id"],
            ["id"],
        )


def downgrade() -> None:
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint(
            "fk_action_items_portfolio_project_id", "action_items", type_="foreignkey",
        )
    op.drop_index("ix_action_items_portfolio_project_id", table_name="action_items")
    op.drop_column("action_items", "portfolio_project_id")
