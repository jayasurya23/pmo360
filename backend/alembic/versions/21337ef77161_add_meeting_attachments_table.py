"""add meeting_attachments table

Revision ID: 21337ef77161
Revises: 91887fae6181
Create Date: 2026-05-26 16:00:00.000000

Introduces ``meeting_attachments`` — PM-uploaded supporting documents tied
to a meeting (site photos, vendor PDFs, sketch markups, contractor
emails). Physical bytes live in the configured storage backend
(LocalFSBackend in dev, SharePoint in prod); this table only carries
metadata + the storage path returned by ``get_storage().save(...)``.

SQLite quirk: every FK is named explicitly so batch ALTER works cleanly
on future migrations that touch this table.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '21337ef77161'
down_revision: Union[str, Sequence[str], None] = '91887fae6181'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'meeting_attachments',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('meeting_id', sa.Integer(), nullable=False),
        sa.Column('filename', sa.String(length=300), nullable=False),
        sa.Column('content_type', sa.String(length=150), nullable=True),
        sa.Column('file_size_bytes', sa.Integer(), nullable=True),
        sa.Column('storage_path', sa.String(length=500), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ['meeting_id'], ['meetings.id'],
            name='fk_meeting_attachments_meeting_id',
        ),
        sa.ForeignKeyConstraint(
            ['created_by_id'], ['users.id'],
            name='fk_meeting_attachments_created_by',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_meeting_attachments'),
    )


def downgrade() -> None:
    op.drop_table('meeting_attachments')
