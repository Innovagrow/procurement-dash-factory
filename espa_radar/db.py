"""Σύνδεση με τη βάση και βοηθητικά session helpers."""
from __future__ import annotations

import logging
from contextlib import contextmanager
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base


def _engine_kwargs(url: str) -> dict:
    if url.startswith("sqlite"):
        # check_same_thread=False: ο scheduler τρέχει σε άλλο thread από το API.
        return {"connect_args": {"check_same_thread": False}, "pool_pre_ping": True}
    return {"pool_pre_ping": True, "pool_size": 5, "max_overflow": 10}


logger = logging.getLogger(__name__)

engine = create_engine(settings.database_url, future=True, **_engine_kwargs(settings.database_url))
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


# Στήλες που προστέθηκαν μετά την πρώτη έκδοση. Το create_all φτιάχνει μόνο
# πίνακες που λείπουν — δεν αγγίζει υπάρχοντες, οπότε μια εγκατάσταση που ήδη
# τρέχει θα έσκαγε στο πρώτο query χωρίς αυτό.
_ADDED_COLUMNS = (
    ("programs", "kind", "VARCHAR(16) DEFAULT 'UNKNOWN'"),
)


def _apply_migrations() -> None:
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table, column, ddl in _ADDED_COLUMNS:
            if table not in existing_tables:
                continue
            columns = {c["name"] for c in inspector.get_columns(table)}
            if column in columns:
                continue
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
            logger.info("Προστέθηκε η στήλη %s.%s", table, column)


def init_db() -> None:
    Base.metadata.create_all(engine)
    _apply_migrations()


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transaction με αυτόματο commit/rollback."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
