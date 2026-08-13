"""Change orders can be filed against a sub-project.

Revision ID: ea5b6c7d8e9f0
Revises: df4a5b6c7d8e9
Create Date: 2026-08-13

WHY
---
Third tier in the same rollout: action items (`ce3f4a5b6c7d8`), meetings
(`df4a5b6c7d8e9`), now change orders. A portfolio running several sub-projects
raises COs against one of them, and "which project is this CO for" was only
answerable by reading the free-text title.

WHAT THIS IS NOT
----------------
It does not touch the PDF. The client-facing "Project" line is `project_name`,
a label the PM types; this column is internal filing so COs can be filtered and
rolled up alongside actions and meetings. An internal tag must not change what
prints on a signed money document.

WHY THIS IS A NULLABLE ADD AND NOTHING ELSE
-------------------------------------------
Same shape and same reasoning as the two before it. `project_id` (the
portfolio) stays NOT NULL, so every portfolio-scoped query and every total
keeps working untouched and roll-up is free. NULL keeps meaning "the portfolio
as a whole", which is what all existing change orders mean — nothing to
backfill, no guess to make, and no CO changes behaviour until somebody
deliberately tags one.

The two-hop rule — the sub-project must belong to THIS change order's portfolio
— cannot be expressed in the schema and lives in the API, as before.

SAFETY
------
One ADD COLUMN, nullable, no default, plus its index. No rewrite, no backfill,
no change to any existing column, and nothing touching `total_amount` or any
other money field. Postgres adds a nullable column without a table rewrite.
"""
from alembic import op
import sqlalchemy as sa


revision: str = "ea5b6c7d8e9f0"
down_revision: str = "df4a5b6c7d8e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "change_orders",
        sa.Column("portfolio_project_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_change_orders_portfolio_project_id",
        "change_orders",
        ["portfolio_project_id"],
    )
    # Named so the downgrade can drop it. SQLite cannot ALTER a table to add a
    # constraint, so the FK is created inline there by create_all and skipped
    # here; batch_alter_table would rebuild the table, which is a far bigger
    # risk than this app's SQLite dev DBs are worth.
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_change_orders_portfolio_project_id",
            "change_orders",
            "portfolio_projects",
            ["portfolio_project_id"],
            ["id"],
        )


def downgrade() -> None:
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint(
            "fk_change_orders_portfolio_project_id", "change_orders", type_="foreignkey",
        )
    op.drop_index("ix_change_orders_portfolio_project_id", table_name="change_orders")
    op.drop_column("change_orders", "portfolio_project_id")
