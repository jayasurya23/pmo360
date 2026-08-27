"""monday.com project links (many-to-many), plus meeting RFI snapshots.

Revision ID: fb6c7d8e9f0a1
Revises: ea5b6c7d8e9f0
Create Date: 2026-08-27

WHY
---
RFIs are raised and tracked in monday.com, not here, but they get discussed in
client meetings and belong in the minutes alongside action items. To pull the
right RFIs for a meeting, our projects have to be linked to Monday's.

WHY A JOIN TABLE AND NOT A COLUMN
---------------------------------
Monday keeps ONE flat "Portfolio" board; we keep Client -> Portfolio ->
Project. They do not line up, and — this is the part a column cannot express —
they fail to line up in BOTH directions:

  * One Monday project covering SEVERAL of ours. "Highland South (1 & 2)" is a
    single Monday item; we hold Highland South 1 and Highland South 2.
  * One of ours covering SEVERAL Monday projects. Monday tracks Coal City 1, 2
    and 3 IFC as three separate items; one project here must pull all three.

A column on each project row handles only the first. Worse, Monday boards get
merged and split as work is re-scoped, so a column would force a destructive
re-mapping every time that happened, with no record of what changed.

The link points at ONE tier — a portfolio or a project, never both — enforced
by a CHECK constraint. A row with both set would silently double-count RFIs;
a row with neither would be invisible. Both failures look like data, not errors.

This table is the anchor for monday.com integration generally, not an RFI
feature. The team is migrating off Smartsheets; KPI reads (task progress,
timelines, cost) are expected to join through these same rows.

WHY RFIs ARE SNAPSHOTTED
------------------------
meeting_rfis copies the Monday fields in at save time rather than reading live.
Minutes record a conversation on a date: a PDF regenerated next month must
match the one the client received, and a live read would rewrite history every
time somebody edited a status in Monday. The unique constraint on
(meeting_id, monday_item_id, portfolio_project_id) makes re-picking an RFI for
the same sub-project update its snapshot rather than print it twice, while
still allowing one RFI to appear under two sub-projects that both need it.

portfolio_project_id on the snapshot drives the printed layout — meetings are
held at portfolio level, but each project under the portfolio gets its own RFI
table on the minutes. NULL means portfolio-wide, the same default used for
action items and meetings.

SAFETY
------
Two new tables only. No existing table is altered, no column is added to or
removed from anything that already holds data, and nothing changes behaviour
until a project is deliberately linked.
"""
from alembic import op
import sqlalchemy as sa


revision: str = "fb6c7d8e9f0a1"
down_revision: str = "ea5b6c7d8e9f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "monday_project_links",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("monday_item_id", sa.BigInteger(), nullable=False),
        sa.Column("monday_project_code", sa.String(length=60), nullable=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=True),
        sa.Column("portfolio_project_id", sa.Integer(),
                  sa.ForeignKey("portfolio_projects.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
        # NULLs compare as distinct, so each constraint governs only the tier it
        # names — one link per (Monday project, portfolio) and one per
        # (Monday project, project), which is exactly the intent.
        sa.UniqueConstraint("monday_item_id", "project_id", name="uq_monday_link_portfolio"),
        sa.UniqueConstraint("monday_item_id", "portfolio_project_id", name="uq_monday_link_project"),
        sa.CheckConstraint(
            "(project_id IS NULL) <> (portfolio_project_id IS NULL)",
            name="ck_monday_link_exactly_one_target",
        ),
    )
    op.create_index("ix_monday_project_links_monday_item_id",
                    "monday_project_links", ["monday_item_id"])
    op.create_index("ix_monday_project_links_monday_project_code",
                    "monday_project_links", ["monday_project_code"])
    op.create_index("ix_monday_project_links_project_id",
                    "monday_project_links", ["project_id"])
    op.create_index("ix_monday_project_links_portfolio_project_id",
                    "monday_project_links", ["portfolio_project_id"])

    op.create_table(
        "meeting_rfis",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("meeting_id", sa.Integer(), sa.ForeignKey("meetings.id"), nullable=False),
        sa.Column("portfolio_project_id", sa.Integer(),
                  sa.ForeignKey("portfolio_projects.id"), nullable=True),
        sa.Column("monday_item_id", sa.BigInteger(), nullable=True),
        sa.Column("monday_project_code", sa.String(length=60), nullable=True),
        sa.Column("name", sa.String(length=500), nullable=False),
        sa.Column("item_equipment", sa.String(length=300), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("question", sa.Text(), nullable=True),
        sa.Column("context", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=50), nullable=True),
        sa.Column("response_owner", sa.String(length=120), nullable=True),
        sa.Column("discipline", sa.String(length=60), nullable=True),
        sa.Column("equipment_type", sa.String(length=200), nullable=True),
        sa.Column("assigned_to", sa.String(length=200), nullable=True),
        sa.Column("date_submitted", sa.Date(), nullable=True),
        sa.Column("response_needed_by", sa.Date(), nullable=True),
        sa.Column("date_completed", sa.Date(), nullable=True),
        sa.Column("snapshot_at", sa.DateTime(), nullable=True),
        sa.Column("order_index", sa.Integer(), nullable=True),
        # Sub-project is part of the key: the same RFI can legitimately appear
        # under two sub-projects, and each must print in its own table.
        sa.UniqueConstraint(
            "meeting_id", "monday_item_id", "portfolio_project_id",
            name="uq_meeting_rfi_item",
        ),
    )
    op.create_index("ix_meeting_rfis_meeting_id", "meeting_rfis", ["meeting_id"])
    op.create_index("ix_meeting_rfis_portfolio_project_id", "meeting_rfis",
                    ["portfolio_project_id"])
    op.create_index("ix_meeting_rfis_monday_item_id", "meeting_rfis", ["monday_item_id"])


def downgrade() -> None:
    op.drop_index("ix_meeting_rfis_monday_item_id", table_name="meeting_rfis")
    op.drop_index("ix_meeting_rfis_portfolio_project_id", table_name="meeting_rfis")
    op.drop_index("ix_meeting_rfis_meeting_id", table_name="meeting_rfis")
    op.drop_table("meeting_rfis")
    op.drop_index("ix_monday_project_links_portfolio_project_id",
                  table_name="monday_project_links")
    op.drop_index("ix_monday_project_links_project_id", table_name="monday_project_links")
    op.drop_index("ix_monday_project_links_monday_project_code",
                  table_name="monday_project_links")
    op.drop_index("ix_monday_project_links_monday_item_id",
                  table_name="monday_project_links")
    op.drop_table("monday_project_links")
