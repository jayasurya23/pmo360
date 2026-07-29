"""Proposals feedback batch: one active proposal per Project + Timeline bar provenance

Revision ID: fb1a2b3c4d5e6
Revises: co7d8e9f0a1b2
Create Date: 2026-07-29

Additive and non-destructive. Two concerns, one revision, so the batch ships a
single head:

1. proposals.is_active_for_project — several proposals may share a Project
   (revisions, re-bids); exactly one is live, the rest are history. Guarded by
   a PARTIAL unique index on (project_id) WHERE active. The backfill (newest id
   per project wins) runs BEFORE the index is created, so prod rows that
   already share a project_id migrate cleanly instead of aborting the deploy.

2. timeline_assignments.origin / manual_edit / manual_edit_at — provenance so a
   proposal auto-resync rebuilds only the bars it owns and that no human has
   touched. Backfilled from the OLD heuristic (on a proposal-sourced project:
   unassigned bars were auto-generated, staffed bars were placed by a PM).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "fb1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "co7d8e9f0a1b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Core table stubs so the backfills render portable boolean literals
# (SQLite 0/1 vs Postgres true/false) instead of hand-written SQL.
_proposals = sa.table(
    "proposals",
    sa.column("id", sa.Integer),
    sa.column("project_id", sa.Integer),
    sa.column("is_active_for_project", sa.Boolean),
)
_ta = sa.table(
    "timeline_assignments",
    sa.column("id", sa.Integer),
    sa.column("timeline_project_id", sa.Integer),
    sa.column("resource_id", sa.Integer),
    sa.column("origin", sa.String),
    sa.column("manual_edit", sa.Boolean),
)
_tp = sa.table(
    "timeline_projects",
    sa.column("id", sa.Integer),
    sa.column("source_proposal_id", sa.Integer),
)


def upgrade() -> None:
    bind = op.get_bind()

    # ---- 1. proposals.is_active_for_project -------------------------------
    # NO batch_alter_table on `proposals`: SQLite batch mode recreates the
    # table and cannot reproduce the circular proposals<->proposal_versions FK
    # (same reason pp1a2b3c4d5e6 used a plain add_column here).
    op.add_column(
        "proposals",
        sa.Column("is_active_for_project", sa.Boolean(),
                  nullable=False, server_default="0"),
    )
    # Backfill BEFORE the unique index: newest (highest id) proposal per
    # project wins the active slot; the rest become history.
    winners = (
        sa.select(sa.func.max(_proposals.c.id))
        .where(_proposals.c.project_id.isnot(None))
        .group_by(_proposals.c.project_id)
    )
    bind.execute(
        _proposals.update()
        .where(_proposals.c.id.in_(winners))
        .values(is_active_for_project=True)
    )
    op.create_index(
        "uq_proposals_active_per_project", "proposals", ["project_id"],
        unique=True,
        sqlite_where=sa.text("is_active_for_project = 1 AND project_id IS NOT NULL"),
        postgresql_where=sa.text("is_active_for_project AND project_id IS NOT NULL"),
    )

    # ---- 2. timeline_assignments provenance -------------------------------
    # Plain add_column (SQLite supports ALTER TABLE ADD COLUMN with a default);
    # no recreate, no FK reflection risk.
    op.add_column("timeline_assignments",
                  sa.Column("origin", sa.String(length=20),
                            nullable=False, server_default="manual"))
    op.add_column("timeline_assignments",
                  sa.Column("manual_edit", sa.Boolean(),
                            nullable=False, server_default="0"))
    op.add_column("timeline_assignments",
                  sa.Column("manual_edit_at", sa.DateTime(), nullable=True))

    proposal_projects = sa.select(_tp.c.id).where(_tp.c.source_proposal_id.isnot(None))
    # Unassigned bars on a proposal-sourced project = what the old algorithm
    # treated as auto-generated.
    bind.execute(
        _ta.update()
        .where(sa.and_(_ta.c.timeline_project_id.in_(proposal_projects),
                       _ta.c.resource_id.is_(None)))
        .values(origin="proposal", manual_edit=False)
    )
    # Staffed onto a person = hand-scheduled; protect it from the first resync.
    bind.execute(
        _ta.update()
        .where(sa.and_(_ta.c.timeline_project_id.in_(proposal_projects),
                       _ta.c.resource_id.isnot(None)))
        .values(origin="proposal", manual_edit=True)
    )


def downgrade() -> None:
    op.drop_column("timeline_assignments", "manual_edit_at")
    op.drop_column("timeline_assignments", "manual_edit")
    op.drop_column("timeline_assignments", "origin")
    op.drop_index("uq_proposals_active_per_project", table_name="proposals")
    op.drop_column("proposals", "is_active_for_project")
