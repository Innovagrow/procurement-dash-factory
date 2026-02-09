from __future__ import annotations
from pathlib import Path
import duckdb

def connect(duckdb_path: str | Path) -> duckdb.DuckDBPyConnection:
    p = Path(duckdb_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(p))
    con.execute("PRAGMA threads=4;")
    return con

def bootstrap(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("""
    CREATE TABLE IF NOT EXISTS catalog_registry (
      dataset_code VARCHAR PRIMARY KEY,
      title VARCHAR,
      dataset_type VARCHAR,
      last_update_data VARCHAR,
      last_update_structure VARCHAR,
      raw_line VARCHAR
    );
    """)
    con.execute("""
    CREATE TABLE IF NOT EXISTS fact_observations (
      dataset_code VARCHAR,
      time VARCHAR,
      geo VARCHAR,
      value DOUBLE,
      unit VARCHAR,
      freq VARCHAR,
      status VARCHAR,
      dims_json VARCHAR,
      series_key VARCHAR
    );
    """)
