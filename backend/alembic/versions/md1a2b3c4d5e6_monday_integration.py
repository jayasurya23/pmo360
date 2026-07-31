"""monday.com integration: board links, task snapshot cache, KPI history

Revision ID: md1a2b3c4d5e6
Revises: co8e9f0a1b2c3
Create Date: 2026-07-31

Purely additive — three new tables, no changes to existing ones. With no
board linked, every query returns empty and the app behaves exactly as before.

`monday_task_snapshots` is a replaceable mirror of current board state.
`monday_kpi_snapshots` is append-only history: monday keeps no record of what
a formula column read yesterday, so if we don't stamp a row per sync the trend
is unrecoverable.
"""
from alembic import op
import sqlalchemy as sa


revision = "md1a2b3c4d5e6"
down_revision = "co8e9f0a1b2c3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "monday_board_links",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        # monday item/board ids exceed 32-bit and arrive as strings.
        sa.Column("board_id", sa.String(length=50), nullable=False),
        sa.Column("board_name", sa.String(length=300), nullable=True),
        sa.Column(
            "kind", sa.String(length=20), nullable=False,
            server_default="schedule",
        ),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default=sa.true(),
        ),
        sa.Column("last_synced_at", sa.DateTime(), nullable=True),
        sa.Column("last_sync_error", sa.Text(), nullable=True),
        sa.Column("last_sync_task_count", sa.Integer(), nullable=True),
        sa.Column("created_by_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name="fk_monday_board_links_project",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_id"], ["users.id"],
            name="fk_monday_board_links_created_by",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_monday_board_links"),
    )
    op.create_index(
        "ix_monday_board_links_project", "monday_board_links", ["project_id"],
    )
    op.create_index(
        "ix_monday_board_links_board", "monday_board_links", ["board_id"],
    )

    op.create_table(
        "monday_task_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("board_link_id", sa.Integer(), nullable=False),
        sa.Column("monday_item_id", sa.String(length=50), nullable=False),
        sa.Column("name", sa.String(length=500), nullable=True),
        sa.Column("url", sa.String(length=500), nullable=True),
        sa.Column("group_title", sa.String(length=200), nullable=True),
        sa.Column("status", sa.String(length=100), nullable=True),
        sa.Column("phase", sa.String(length=100), nullable=True),
        sa.Column("disciplines_json", sa.JSON(), nullable=True),
        sa.Column("owner", sa.String(length=200), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("completion_date", sa.Date(), nullable=True),
        sa.Column("planned_duration_days", sa.Float(), nullable=True),
        sa.Column("actual_duration_days", sa.Float(), nullable=True),
        sa.Column("schedule_variance_days", sa.Float(), nullable=True),
        sa.Column("planned_hours", sa.Float(), nullable=True),
        sa.Column("actual_hours", sa.Float(), nullable=True),
        sa.Column("hours_variance", sa.Float(), nullable=True),
        sa.Column("billable_cost", sa.Float(), nullable=True),
        sa.Column("actual_cost", sa.Float(), nullable=True),
        sa.Column("qc_status", sa.String(length=100), nullable=True),
        sa.Column("qc_ready_date", sa.Date(), nullable=True),
        sa.Column("qc_complete_date", sa.Date(), nullable=True),
        sa.Column("qc_cycle_days", sa.Float(), nullable=True),
        sa.Column("synced_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["board_link_id"], ["monday_board_links.id"],
            name="fk_monday_task_snapshots_link", ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_monday_task_snapshots"),
    )
    op.create_index(
        "ix_monday_task_snapshots_link", "monday_task_snapshots", ["board_link_id"],
    )
    op.create_index(
        "ix_monday_task_snapshots_item", "monday_task_snapshots",
        ["board_link_id", "monday_item_id"],
    )

    op.create_table(
        "monday_kpi_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("board_link_id", sa.Integer(), nullable=False),
        sa.Column("snapshot_date", sa.Date(), nullable=False),
        sa.Column("total_tasks", sa.Integer(), nullable=True),
        sa.Column("completed_tasks", sa.Integer(), nullable=True),
        sa.Column("in_progress_tasks", sa.Integer(), nullable=True),
        sa.Column("blocked_tasks", sa.Integer(), nullable=True),
        sa.Column("overdue_tasks", sa.Integer(), nullable=True),
        sa.Column("completion_rate", sa.Float(), nullable=True),
        sa.Column("on_time_rate", sa.Float(), nullable=True),
        sa.Column("avg_schedule_variance_days", sa.Float(), nullable=True),
        sa.Column("avg_qc_cycle_days", sa.Float(), nullable=True),
        sa.Column("planned_hours_total", sa.Float(), nullable=True),
        sa.Column("actual_hours_total", sa.Float(), nullable=True),
        sa.Column("payload_json", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["board_link_id"], ["monday_board_links.id"],
            name="fk_monday_kpi_snapshots_link", ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_monday_kpi_snapshots"),
    )
    op.create_index(
        "ix_monday_kpi_snapshots_unique", "monday_kpi_snapshots",
        ["board_link_id", "snapshot_date"], unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_monday_kpi_snapshots_unique", table_name="monday_kpi_snapshots")
    op.drop_table("monday_kpi_snapshots")
    op.drop_index("ix_monday_task_snapshots_item", table_name="monday_task_snapshots")
    op.drop_index("ix_monday_task_snapshots_link", table_name="monday_task_snapshots")
    op.drop_table("monday_task_snapshots")
    op.drop_index("ix_monday_board_links_board", table_name="monday_board_links")
    op.drop_index("ix_monday_board_links_project", table_name="monday_board_links")
    op.drop_table("monday_board_links")
