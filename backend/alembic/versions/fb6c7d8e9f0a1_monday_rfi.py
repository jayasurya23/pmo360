"""monday.com link on both project tiers, plus meeting RFI snapshots.

Revision ID: fb6c7d8e9f0a1
Revises: ea5b6c7d8e9f0
Create Date: 2026-08-27

WHY
---
RFIs are raised and tracked in monday.com, not here, but they get discussed in
client meetings and belong in the minutes alongside action items. To pull the
right RFIs for a meeting, our projects have to be linked to Monday's.

WHY THE LINK IS ON BOTH TIERS
-----------------------------
Monday keeps ONE flat "Portfolio" board — 39 items, each a project with a human
Project ID. That single list maps onto BOTH of our tiers: some Monday projects
are our portfolios (Payne, Girard, Modern Landfill), and others are
sub-projects inside one (Gonzo, Raven, Waxwing and Trigo Sol all sit under the
Sunshare portfolio). Putting the link on only one tier would strand every RFI
belonging to the other.

Neither column is unique, on purpose: "Highland South (1 & 2)" is a single
Monday project covering two of our sub-projects, so both rows carry the same
monday_item_id. A unique index would refuse a mapping that is simply true.

monday_item_id is the join key because it is stable. monday_project_code is
stored alongside it for display and search, NOT as a key — it is free text in
Monday and two of the 39 projects had none at all.

WHY RFIs ARE SNAPSHOTTED
------------------------
meeting_rfis copies the Monday fields in at save time rather than reading them
live. Minutes are a record of a conversation on a date: a PDF regenerated next
month must match the one the client received, and a live read would rewrite
history every time somebody edited a status in Monday. The unique constraint on
(meeting_id, monday_item_id) makes re-picking an RFI update its snapshot rather
than print it twice.

portfolio_project_id is what drives the printed layout — meetings happen at
portfolio level, but each project under the portfolio gets its own RFI table.
NULL means portfolio-wide, the same default used for actions and meetings.

SAFETY
------
Two nullable ADD COLUMNs on existing tables (no rewrite, no backfill, no
existing column touched) plus one new table. Nothing here can fail on existing
rows, and no behaviour changes until a project is deliberately mapped.
"""
from alembic import op
import sqlalchemy as sa


revision: str = "fb6c7d8e9f0a1"
down_revision: str = "ea5b6c7d8e9f0"
branch_labels = None
depends_on = None

_LINKED = ("projects", "portfolio_projects")


def upgrade() -> None:
    for tbl in _LINKED:
        op.add_column(tbl, sa.Column("monday_item_id", sa.BigInteger(), nullable=True))
        op.add_column(tbl, sa.Column("monday_project_code", sa.String(length=60), nullable=True))
        op.create_index(f"ix_{tbl}_monday_item_id", tbl, ["monday_item_id"])
        op.create_index(f"ix_{tbl}_monday_project_code", tbl, ["monday_project_code"])

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
        sa.UniqueConstraint("meeting_id", "monday_item_id", name="uq_meeting_rfi_item"),
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
    for tbl in _LINKED:
        op.drop_index(f"ix_{tbl}_monday_project_code", table_name=tbl)
        op.drop_index(f"ix_{tbl}_monday_item_id", table_name=tbl)
        op.drop_column(tbl, "monday_project_code")
        op.drop_column(tbl, "monday_item_id")
