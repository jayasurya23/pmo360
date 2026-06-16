"""add Proposal builder tables

Revision ID: c5e1a9f4b2d7
Revises: d4e5f6a7b8c9
Create Date: 2026-06-15 13:30:00.000000

Self-contained proposal builder (ported Castillo Proposal Generator). Three
tables:
  - proposals          : the document/container. ``portfolio_id`` (nullable) is
                         the standalone↔tie-in hinge into projects.
  - proposal_versions  : immutable V1/V2… snapshots of the computed item tree
                         (tree_json) + project info + schedule config.
  - proposal_documents : generated-PDF audit trail per version.

proposals.current_version_id ↔ proposal_versions.proposal_id is a circular FK,
so that one FK is added after both tables exist (batch ALTER → SQLite-safe).
Named constraints throughout for the same reason.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c5e1a9f4b2d7'
down_revision: Union[str, Sequence[str], None] = 'd4e5f6a7b8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'proposals',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(length=300), nullable=False),
        sa.Column('customer_name', sa.String(length=200), nullable=True),
        sa.Column('project_location', sa.String(length=200), nullable=True),
        sa.Column('project_state', sa.String(length=50), nullable=True),
        sa.Column('project_size_mw', sa.String(length=50), nullable=True),
        sa.Column('portfolio_id', sa.Integer(), nullable=True),
        sa.Column('linked_schedule_id', sa.Integer(), nullable=True),
        sa.Column('current_version_id', sa.Integer(), nullable=True),
        sa.Column('version', sa.Integer(), server_default='1', nullable=False),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('updated_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['portfolio_id'], ['projects.id'], name='fk_proposals_portfolio'),
        sa.ForeignKeyConstraint(['linked_schedule_id'], ['schedules.id'], name='fk_proposals_linked_schedule'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name='fk_proposals_created_by'),
        sa.ForeignKeyConstraint(['updated_by_id'], ['users.id'], name='fk_proposals_updated_by'),
        sa.PrimaryKeyConstraint('id', name='pk_proposals'),
    )
    op.create_table(
        'proposal_versions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('proposal_id', sa.Integer(), nullable=False),
        sa.Column('label', sa.String(length=20), nullable=False),
        sa.Column('tree_json', sa.JSON(), nullable=False),
        sa.Column('info_json', sa.JSON(), nullable=False),
        sa.Column('config_json', sa.JSON(), nullable=True),
        sa.Column('computed_start_date', sa.Date(), nullable=True),
        sa.Column('computed_end_date', sa.Date(), nullable=True),
        sa.Column('total_price', sa.Integer(), nullable=True),
        sa.Column('source_filename', sa.String(length=300), nullable=True),
        sa.Column('source_format', sa.String(length=10), nullable=True),
        sa.Column('linked_schedule_id', sa.Integer(), nullable=True),
        sa.Column('version', sa.Integer(), server_default='1', nullable=False),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['proposal_id'], ['proposals.id'], name='fk_proposal_versions_proposal'),
        sa.ForeignKeyConstraint(['linked_schedule_id'], ['schedules.id'], name='fk_proposal_versions_linked_schedule'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name='fk_proposal_versions_created_by'),
        sa.PrimaryKeyConstraint('id', name='pk_proposal_versions'),
    )
    op.create_table(
        'proposal_documents',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('proposal_version_id', sa.Integer(), nullable=False),
        sa.Column('kind', sa.String(length=30), nullable=True),
        sa.Column('filename', sa.String(length=300), nullable=False),
        sa.Column('storage_path', sa.String(length=500), nullable=False),
        sa.Column('file_size_bytes', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ['proposal_version_id'], ['proposal_versions.id'],
            name='fk_proposal_documents_version',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_proposal_documents'),
    )
    # Circular FK: add proposals.current_version_id → proposal_versions.id now
    # that proposal_versions exists. batch_alter_table keeps SQLite happy.
    with op.batch_alter_table('proposals', schema=None) as batch_op:
        batch_op.create_foreign_key(
            'fk_proposals_current_version', 'proposal_versions',
            ['current_version_id'], ['id'],
        )


def downgrade() -> None:
    # Break the circular FK before dropping, so neither drop trips an FK.
    with op.batch_alter_table('proposals', schema=None) as batch_op:
        batch_op.drop_constraint('fk_proposals_current_version', type_='foreignkey')
    op.drop_table('proposal_documents')
    op.drop_table('proposal_versions')
    op.drop_table('proposals')
