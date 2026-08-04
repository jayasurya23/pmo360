"""project_members: one row per (portfolio, person)

Every write path already defended against duplicates in Python — a
read-then-insert in db/repository.py::add_project_member, and a pre-snapshot of
existing pairs in api/members.py::bulk_memberships. Neither is atomic: two
concurrent assignments can both pass the check and both insert. Only the
database can settle that race.

The count matters, not just the tidiness. Membership count is read by the
roster, the "N portfolios" chip on the admin grid, and the bulk route's
before/after report — so a doubled row makes a portfolio look more staffed than
it is, and removing one copy leaves the pair still assigned.

DE-DUPLICATION RUNS FIRST because ADD CONSTRAINT fails outright on a table that
already contains duplicates, and this migration runs at container boot via
prestart.py — a failure here does not fail the deploy, it takes production
down. It keeps the LOWEST id per pair, which is the original assignment: it
carries the earliest created_at and the created_by_id of whoever really made
it, so the audit trail survives and the accidental copy is what goes.

The delete is unconditional rather than guarded by a count check, so it is
correct whether or not duplicates exist and needs no knowledge of the data.

Revision ID: um1a2b3c4d5e6
Revises: co9f0a1b2c3d4
"""
from alembic import op

revision = "um1a2b3c4d5e6"
down_revision = "co9f0a1b2c3d4"
branch_labels = None
depends_on = None

_CONSTRAINT = "uq_project_members_project_user"


def upgrade():
    # op.execute, not op.get_bind().execute — get_bind() is None in offline
    # --sql mode, which is how this migration is reviewed before it reaches
    # production. Plain SQL so it runs identically on SQLite and Postgres.
    op.execute(
        """
        DELETE FROM project_members
        WHERE id NOT IN (
            SELECT MIN(id) FROM project_members GROUP BY project_id, user_id
        )
        """
    )
    # batch_alter_table because SQLite cannot ALTER TABLE ADD CONSTRAINT and has
    # to rebuild the table. On Postgres, Alembic's batch mode passes straight
    # through to a native ALTER, so prod pays nothing for the portability.
    with op.batch_alter_table("project_members") as batch:
        batch.create_unique_constraint(_CONSTRAINT, ["project_id", "user_id"])


def downgrade():
    # Rows removed on the way up are not restored — they were duplicates of
    # assignments that still exist, so nothing is lost that the surviving row
    # does not already say.
    with op.batch_alter_table("project_members") as batch:
        batch.drop_constraint(_CONSTRAINT, type_="unique")
