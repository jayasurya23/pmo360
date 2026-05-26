"""Alembic environment.

Reads the live database URL from `config.database_url()` so we don't have to
keep the `sqlalchemy.url` in alembic.ini in sync with `.env`. Target metadata
is the same `Base.metadata` the app uses, so `alembic revision --autogenerate`
diffs against the live models.
"""
from logging.config import fileConfig
import sys
from pathlib import Path

# Make backend/ importable when alembic is invoked from inside backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import engine_from_config, pool

from alembic import context

from config import database_url
from db.models import Base

config = context.config

# Override the .ini's sqlalchemy.url with the live one from our config layer.
config.set_main_option("sqlalchemy.url", database_url())

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=url.startswith("sqlite"),
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        # `render_as_batch=True` lets SQLite handle ALTER TABLE operations
        # that aren't natively supported (e.g. add NOT NULL column).
        is_sqlite = connection.dialect.name == "sqlite"
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=is_sqlite,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
