from __future__ import annotations
from .config import Config
from .db import connect, bootstrap

def select_datasets(cfg: Config, mode: str, n: int, keyword: str | None = None, days_back: int = 7, explicit: list[str] | None = None) -> list[str]:
    if mode == "explicit":
        return (explicit or [])[:n]

    con = connect(cfg.get("warehouse", "duckdb_path"))
    bootstrap(con)

    if mode == "keyword":
        kw = (keyword or "").strip()
        if not kw:
            raise ValueError("keyword mode requires --keyword")
        q = """
        SELECT dataset_code
        FROM catalog_registry
        WHERE lower(title) LIKE '%' || lower(?) || '%'
        ORDER BY coalesce(last_update_data,'') DESC
        LIMIT ?;
        """
        rows = con.execute(q, [kw, n]).fetchall()
        con.close()
        return [r[0] for r in rows]

    if mode == "updates":
        q = """
        SELECT dataset_code
        FROM catalog_registry
        WHERE last_update_data IS NOT NULL AND last_update_data <> ''
        ORDER BY last_update_data DESC
        LIMIT ?;
        """
        rows = con.execute(q, [n]).fetchall()
        con.close()
        return [r[0] for r in rows]

    raise ValueError(f"Unknown mode: {mode}")
