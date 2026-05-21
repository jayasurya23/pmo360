"""FastAPI dependencies — DB session per request."""
from typing import Generator
from sqlalchemy.orm import Session

from db.session import get_session_factory


def get_db() -> Generator[Session, None, None]:
    """Yield a SQLAlchemy session and commit / rollback at request boundaries.

    Matches the semantics of the Streamlit app's ``session_scope`` context
    manager: commit on clean exit, rollback on exception, always close.
    """
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
