"""add Change Order tables

Revision ID: co0a1b2c3d4e5
Revises: e1f2a3b4c5d6
Create Date: 2026-06-26 09:00:00.000000

Internal Change Order Request module (replaces the Excel form). Two tables:
  - change_orders            : header + workflow (draft|pending|approved) +
                               total, scoped to a portfolio (project_id).
  - change_order_line_items  : the request lines (fixed cost OR hourly rate*hours
                               + app-only internal notes).
Named constraints throughout for SQLite batch-ALTER safety.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'co0a1b2c3d4e5'
down_revision: Union[str, Sequence[str], None] = 'e1f2a3b4c5d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'change_orders',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('co_number', sa.Integer(), server_default='1', nullable=False),
        sa.Column('co_version', sa.String(length=20), nullable=True),
        sa.Column('title', sa.String(length=300), nullable=True),
        sa.Column('rate_type', sa.String(length=10), server_default='fixed', nullable=False),
        sa.Column('status', sa.String(length=20), server_default='draft', nullable=False),
        sa.Column('request_date', sa.Date(), nullable=True),
        sa.Column('requested_by', sa.String(length=200), nullable=True),
        sa.Column('requested_by_user_id', sa.Integer(), nullable=True),
        sa.Column('approved_by', sa.String(length=200), nullable=True),
        sa.Column('approved_by_user_id', sa.Integer(), nullable=True),
        sa.Column('approved_at', sa.DateTime(), nullable=True),
        sa.Column('client_name', sa.String(length=200), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('total_amount', sa.Float(), nullable=True),
        sa.Column('version', sa.Integer(), server_default='1', nullable=False),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('updated_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], name='fk_change_orders_project'),
        sa.ForeignKeyConstraint(['requested_by_user_id'], ['users.id'], name='fk_change_orders_requested_by'),
        sa.ForeignKeyConstraint(['approved_by_user_id'], ['users.id'], name='fk_change_orders_approved_by'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name='fk_change_orders_created_by'),
        sa.ForeignKeyConstraint(['updated_by_id'], ['users.id'], name='fk_change_orders_updated_by'),
        sa.PrimaryKeyConstraint('id', name='pk_change_orders'),
    )
    op.create_table(
        'change_order_line_items',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('change_order_id', sa.Integer(), nullable=False),
        sa.Column('order_index', sa.Integer(), server_default='0', nullable=True),
        sa.Column('details', sa.Text(), nullable=True),
        sa.Column('cost', sa.Float(), nullable=True),
        sa.Column('hourly_rate', sa.Float(), nullable=True),
        sa.Column('hours', sa.Float(), nullable=True),
        sa.Column('internal_notes', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ['change_order_id'], ['change_orders.id'],
            name='fk_change_order_line_items_co',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_change_order_line_items'),
    )


def downgrade() -> None:
    op.drop_table('change_order_line_items')
    op.drop_table('change_orders')
