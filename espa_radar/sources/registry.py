"""Μητρώο πηγών: διαβάζει το sources.yml και φτιάχνει τα αντικείμενα."""
from __future__ import annotations

import logging
import os
from pathlib import Path

import yaml

from .base import Source
from .diavgeia import DiavgeiaSource
from .html_list import HtmlListSource
from .json_api import JsonApiSource
from .rss import RssSource

logger = logging.getLogger(__name__)

SOURCE_TYPES: dict[str, type[Source]] = {
    "rss": RssSource,
    "html": HtmlListSource,
    "json": JsonApiSource,
    "diavgeia": DiavgeiaSource,
}

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "sources.yml"


def config_path() -> Path:
    return Path(os.getenv("ESPA_SOURCES_FILE", DEFAULT_CONFIG_PATH))


def load_source_config(path: Path | None = None) -> list[dict]:
    path = path or config_path()
    if not path.exists():
        logger.error("Δεν βρέθηκε αρχείο πηγών: %s", path)
        return []
    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    entries = data.get("sources", [])
    return [e for e in entries if isinstance(e, dict)]


def build_sources(path: Path | None = None, only: list[str] | None = None) -> list[Source]:
    sources: list[Source] = []
    for entry in load_source_config(path):
        source_id = entry.get("id")
        kind = entry.get("type")
        if not source_id or not kind:
            logger.warning("Παράλειψη πηγής χωρίς id/type: %s", entry)
            continue
        if only and source_id not in only:
            continue
        if not entry.get("enabled", True) and not only:
            continue

        factory = SOURCE_TYPES.get(kind)
        if factory is None:
            logger.warning("Άγνωστος τύπος πηγής '%s' (id=%s)", kind, source_id)
            continue

        options = {k: v for k, v in entry.items() if k not in {"id", "type", "name", "enabled"}}
        sources.append(
            factory(
                source_id=source_id,
                name=entry.get("name", source_id),
                enabled=bool(entry.get("enabled", True)),
                **options,
            )
        )

    logger.info("Φορτώθηκαν %s πηγές", len(sources))
    return sources
