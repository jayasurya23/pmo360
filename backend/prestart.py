"""Pre-start hook — run BEFORE the web server boots on every deploy.

Makes "push to update" apply schema changes automatically, handling both a
brand-new database and an existing one correctly.

The wrinkle: this project's Alembic *baseline* migration is empty (`pass`)
— historically the full schema was built by SQLAlchemy ``create_all`` and
the later migrations only layer incremental columns/tables on top. So
``alembic upgrade head`` from scratch FAILS on a fresh DB (the first real
migration ALTERs tables the empty baseline never created). We therefore
branch:

  - FRESH DB (no ``alembic_version`` table): build the current schema with
    ``Base.metadata.create_all`` (reflects models.py exactly), then
    ``alembic stamp head`` to mark every migration as already-applied.

  - EXISTING DB (``alembic_version`` present): ``alembic upgrade head`` to
    apply whatever new migrations shipped in this deploy.

Both paths then seed the Castillo global roster (idempotent). Exits
non-zero on failure so a bad migration fails the deploy loudly instead of
booting the server against a half-migrated DB.

NOTE: ``db.session.init_db()`` is intentionally NOT used here — despite its
name it runs ``alembic upgrade head``, which is exactly the path that
breaks on a fresh DB. We call ``create_all`` directly for the fresh case.
"""
from __future__ import annotations

import sys
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from config import database_url


def _alembic_config() -> Config:
    """Alembic config pointed at the repo's migrations, with the live
    DB URL injected (alembic.ini's frozen URL is ignored)."""
    backend_dir = Path(__file__).resolve().parent
    cfg = Config(str(backend_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    cfg.set_main_option("sqlalchemy.url", database_url())
    return cfg


def main() -> None:
    url = database_url()
    # ASCII-only, credential-masked log line (never crash on console encoding).
    safe = url.split("@")[-1] if "@" in url else url
    print(f"[prestart] database: ...@{safe}", flush=True)

    engine = create_engine(url)
    try:
        has_alembic = inspect(engine).has_table("alembic_version")
    finally:
        engine.dispose()

    cfg = _alembic_config()

    if has_alembic:
        print("[prestart] existing DB -> alembic upgrade head", flush=True)
        command.upgrade(cfg, "head")
    else:
        print(
            "[prestart] fresh DB -> create_all + alembic stamp head",
            flush=True,
        )
        # Build the full current schema directly from the models, then tell
        # Alembic the DB is already at head. (Importing here, after the
        # branch, keeps a missing model import from masking the real error.)
        from db.models import Base
        from db.session import get_engine

        Base.metadata.create_all(bind=get_engine())
        command.stamp(cfg, "head")

    # Seed the Castillo global roster (idempotent) on both paths.
    from db.session import _seed_global_roster

    _seed_global_roster()

    print("[prestart] migrations OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — fail the deploy loudly
        print(f"[prestart] FAILED: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
