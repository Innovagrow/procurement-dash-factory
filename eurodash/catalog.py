from __future__ import annotations

import io
import pandas as pd
import requests

from .db import connect, bootstrap


REQUIRED_COLS = [
    "dataset_code",
    "title",
    "dataset_type",
    "last_update_data",
    "last_update_structure",
]


def ingest_catalog(cfg) -> pd.DataFrame:
    """Download and parse Eurostat TOC TXT into a clean dataframe.

    The TOC TXT is a tab-separated table with columns like:
    title, code, type, last update of data, last table structure change
    """
    url = cfg.raw["catalog"]["toc_txt_url"]
    timeout = int(cfg.raw.get("ingestion", {}).get("request_timeout_s", 45))

    r = requests.get(url, timeout=timeout)
    r.raise_for_status()

    df = pd.read_csv(
        io.StringIO(r.text),
        sep="\t",
        dtype=str,
        engine="python",
    )

    rename = {
        "code": "dataset_code",
        "title": "title",
        "type": "dataset_type",
        "last update of data": "last_update_data",
        "last table structure change": "last_update_structure",
    }
    df = df.rename(columns=rename)

    for c in REQUIRED_COLS:
        if c not in df.columns:
            df[c] = None

    return df[REQUIRED_COLS].copy()


def upsert_catalog(cfg, df: pd.DataFrame) -> None:
    """Persist catalog into DuckDB safely (no PK collisions)."""
    con = connect(cfg)
    bootstrap(con)

    d = df.copy()

    # Normalize strings
    for c in REQUIRED_COLS:
        d[c] = d[c].astype(str).str.strip().str.strip('"')

    # Drop header-like row(s)
    d = d[~d["dataset_code"].str.lower().isin(["code", "nan", "none"])]

    # Keep only real datasets (drop folders and blank codes)
    d = d[d["dataset_code"].notna() & (d["dataset_code"].str.strip() != "")]
    d = d[~d["dataset_type"].str.lower().isin(["folder"])]

    # Dedupe by dataset_code (TOC can list same dataset multiple times across themes)
    d = d.drop_duplicates(subset=["dataset_code"], keep="last")

    con.register("df_clean", d)

    # Overwrite deterministically
    con.execute(
        """
        CREATE OR REPLACE TABLE catalog_registry AS
        SELECT
          dataset_code,
          title,
          dataset_type,
          NULLIF(last_update_data, '') AS last_update_data,
          NULLIF(last_update_structure, '') AS last_update_structure
        FROM df_clean
        """
    )
