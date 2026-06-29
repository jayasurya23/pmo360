"""Project tier under Portfolio: portfolio_projects + proposals.project_id

Revision ID: pp1a2b3c4d5e6
Revises: co6c7d8e9f0a1
Create Date: 2026-06-29

Additive + non-destructive. Introduces the real "Project" tier (a site under a
Portfolio) and lets a proposal point at one; the proposal's portfolio is derived
from the project at the app layer. Existing proposals keep project_id NULL and
behave exactly as before.
"""
from alembic import op
import sqlalchemy as sa


revision = "pp1a2b3c4d5e6"
down_revision = "co6c7d8e9f0a1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "portfolio_projects",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("portfolio_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=300), nullable=False),
        sa.Column("location", sa.String(length=200), nullable=True),
        sa.Column("state", sa.String(length=50), nullable=True),
        sa.Column("size_mw", sa.String(length=50), nullable=True),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column("updated_by_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["portfolio_id"], ["projects.id"],
            name="fk_portfolio_projects_portfolio",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_id"], ["users.id"],
            name="fk_portfolio_projects_created_by",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by_id"], ["users.id"],
            name="fk_portfolio_projects_updated_by",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_portfolio_projects"),
    )
    # Plain column everywhere (no batch → no SQLite recreate of the circular-FK
    # proposals table); the real FK only on backends that ALTER in place.
    op.add_column("proposals", sa.Column("project_id", sa.Integer(), nullable=True))
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_proposals_project", "proposals", "portfolio_projects",
            ["project_id"], ["id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        op.drop_constraint("fk_proposals_project", "proposals", type_="foreignkey")
    op.drop_column("proposals", "project_id")
    op.drop_table("portfolio_projects")
