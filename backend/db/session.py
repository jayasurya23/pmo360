"""
SQLAlchemy session factory. Singleton engine for the app lifetime.

Schema evolution is owned by Alembic (see backend/alembic/). `init_db()`
runs `alembic upgrade head` programmatically so a fresh SQLite DB ends up
fully migrated in one step. The previous `_bootstrap_migrations()` ALTER
TABLE pattern was retired when Alembic was wired in.
"""
from contextlib import contextmanager
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

from config import database_url
from db.models import Base


_engine = None
_SessionLocal = None


def get_engine():
    global _engine
    if _engine is None:
        url = database_url()
        # SQLite needs check_same_thread=False for Streamlit
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        _engine = create_engine(url, connect_args=connect_args, echo=False)
    return _engine


def get_session_factory():
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), expire_on_commit=False)
    return _SessionLocal


# Castillo Engineering team — auto-seeded into the global roster on first run.
CASTILLO_TEAM = [
    ("Roashaael Mary John",   "RM", "Castillo Engineering"),
    ("Rick Castillo",         "RC", "Castillo Engineering"),
    ("Christopher Castillo",  "CC", "Castillo Engineering"),
    ("Gary Joseph",           "GJ", "Castillo Engineering"),
    ("Arun Ramadass",         "AR", "Castillo Engineering"),
    ("Manjil Puri",           "MP", "Castillo Engineering"),
    ("Brett Beattie",         "BB", "Castillo Engineering"),
]


def init_db():
    """Bring the database up to the head Alembic revision and seed the
    Castillo global roster. Safe to call repeatedly.

    On a brand-new SQLite file this creates every table at HEAD in one
    pass. On an existing DB it applies any pending revisions. Either way,
    Alembic is the only source of schema truth — no more inline ALTERs."""
    _run_alembic_upgrade()
    _seed_global_roster()


def _run_alembic_upgrade():
    """Programmatically run `alembic upgrade head`. We point Alembic at the
    repo's alembic.ini so it works regardless of the caller's CWD."""
    from alembic.config import Config
    from alembic import command

    backend_dir = Path(__file__).resolve().parent.parent
    ini_path = backend_dir / "alembic.ini"
    if not ini_path.exists():
        # No Alembic configured (e.g. during a one-off test). Fall back to
        # the legacy "just create the tables" path so we don't crash.
        engine = get_engine()
        Base.metadata.create_all(bind=engine)
        return

    cfg = Config(str(ini_path))
    # `script_location` in alembic.ini is relative — make it absolute so it
    # resolves correctly when called from outside backend/.
    cfg.set_main_option("script_location", str(backend_dir / "alembic"))
    # Use the live `.env`-resolved URL, not whatever alembic.ini has frozen.
    cfg.set_main_option("sqlalchemy.url", database_url())
    command.upgrade(cfg, "head")


def _seed_global_roster():
    """Ensure each member of CASTILLO_TEAM exists in `global_attendees`.
    Skips members that are already present (matched on full_name)."""
    from db.models import GlobalAttendee
    SessionLocal = get_session_factory()
    with SessionLocal() as s:
        existing_names = {r[0] for r in s.query(GlobalAttendee.full_name).all()}
        for full_name, initials, org in CASTILLO_TEAM:
            if full_name in existing_names:
                continue
            s.add(GlobalAttendee(
                full_name=full_name,
                initials=initials,
                organization=org,
            ))
        s.commit()


@contextmanager
def session_scope() -> Session:
    """Context-managed session with commit/rollback handling."""
    SessionLocal = get_session_factory()
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
