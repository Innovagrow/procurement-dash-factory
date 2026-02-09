from __future__ import annotations
from dataclasses import dataclass
import re
import pandas as pd

from .config import Config
from .utils import http_get, ensure_dir
from .db import connect, bootstrap

@dataclass
class CatalogRow:
    dataset_code: str
    title: str
    dataset_type: str
    last_update_data: str | None
    last_update_structure: str | None
    raw_line: str

_SPLIT_RE = re.compile(r"\t|\|")

def parse_toc_txt(text: str) -> list[CatalogRow]:
    rows: list[CatalogRow] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in _SPLIT_RE.split(line)]
        parts = [p for p in parts if p != ""]
        code = parts[0] if len(parts) > 0 else ""
        title = parts[1] if len(parts) > 1 else ""
        dtype = parts[2] if len(parts) > 2 else ""
        lud = parts[3] if len(parts) > 3 else None
        lus = parts[4] if len(parts) > 4 else None
        if code:
            rows.append(CatalogRow(code, title, dtype, lud, lus, line))
    return rows

def ingest_catalog(cfg: Config) -> pd.DataFrame:
    url = cfg.get("catalog", "toc_txt_url")
    timeout = int(cfg.get("ingestion", "request_timeout_s", default=45))
    r = http_get(url, timeout=timeout)
    df = pd.DataFrame([r.__dict__ for r in parse_toc_txt(r.text)])
    return df

def upsert_catalog(cfg: Config, df: pd.DataFrame) -> None:
    con = connect(cfg.get("warehouse", "duckdb_path"))
    bootstrap(con)
    con.execute("DELETE FROM catalog_registry;")
    con.register("df", df)
    con.execute("""
      INSERT INTO catalog_registry
      SELECT dataset_code, title, dataset_type, last_update_data, last_update_structure, raw_line
      FROM df;
    """)
    parquet_dir = ensure_dir(cfg.get("warehouse", "parquet_dir"))
    df.to_parquet(parquet_dir / "catalog_registry.parquet", index=False)
    con.close()
