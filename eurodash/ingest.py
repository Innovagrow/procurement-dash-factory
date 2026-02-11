from __future__ import annotations
from typing import Any
import datetime as dt
import json
import urllib.parse
import pandas as pd

from .config import Config
from .utils import http_get, ensure_dir
from .db import connect, bootstrap

def _build_url(dataset_code: str, params: dict[str, Any]) -> str:
    base = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset_code}"
    q = urllib.parse.urlencode(params, doseq=True)
    return f"{base}?{q}"

def _years_window(years: int) -> list[str]:
    cur = dt.datetime.utcnow().year
    return [str(y) for y in range(cur - years + 1, cur + 1)]

def _flatten_jsonstat(js: dict[str, Any], dataset_code: str) -> pd.DataFrame:
    dims = js.get("id", [])
    size = js.get("size", [])
    dim_obj = js.get("dimension", {}) or {}
    values = js.get("value", {})
    status = js.get("status", {}) or {}

    # ordered categories per dim
    cats: dict[str, list[str]] = {}
    for d in dims:
        cat = dim_obj.get(d, {}).get("category", {})
        idx = cat.get("index")
        if isinstance(idx, dict):
            ordered = sorted(idx.items(), key=lambda kv: kv[1])
            cats[d] = [k for k, _ in ordered]
        elif isinstance(idx, list):
            cats[d] = list(idx)
        else:
            cats[d] = []

    if not isinstance(values, dict):
        raise ValueError("MVP expects JSON-stat 'value' as dict of linear_index->value.")

    rows = []
    for lin_idx_str, val in values.items():
        lin_idx = int(lin_idx_str)
        coords = {}
        rem = lin_idx
        for d, dim_size in zip(dims, size):
            pos = rem % dim_size
            rem //= dim_size
            coords[d] = cats[d][pos] if cats.get(d) and pos < len(cats[d]) else str(pos)

        dims_extra = {k: v for k, v in coords.items() if k not in ("time","geo","unit","freq")}
        series_key = "|".join([f"{k}={coords[k]}" for k in dims if k != "time"])
        rows.append({
            "dataset_code": dataset_code,
            "time": coords.get("time"),
            "geo": coords.get("geo"),
            "value": float(val) if val is not None else None,
            "unit": coords.get("unit"),
            "freq": coords.get("freq"),
            "status": status.get(lin_idx_str),
            "dims_json": json.dumps(dims_extra, ensure_ascii=False),
            "series_key": series_key
        })
    return pd.DataFrame(rows)

def ingest_dataset(cfg: Config, dataset_code: str, filters: dict[str, Any] | None = None, years: int | None = None) -> pd.DataFrame:
    years = int(years or cfg.get("ingestion", "time_window_years", default=6))
    params: dict[str, Any] = {"format": "JSON", "lang": "EN"}

    geo_level = cfg.get("ingestion", "geo_level", default="country")
    if geo_level:
        params["geoLevel"] = geo_level

    params["time"] = _years_window(years)

    for k, v in (filters or {}).items():
        if v is None:
            continue
        params[k] = v

    url = _build_url(dataset_code, params)
    r = http_get(url, timeout=int(cfg.get("ingestion", "request_timeout_s", default=45)))
    js = r.json()
    return _flatten_jsonstat(js, dataset_code=dataset_code)

def upsert_fact(cfg: Config, df: pd.DataFrame, dataset_code: str) -> None:
    con = connect(cfg.get("warehouse", "duckdb_path"))
    bootstrap(con)
    con.execute("DELETE FROM fact_observations WHERE dataset_code = ?;", [dataset_code])
    
    # Skip insertion if dataframe is empty
    if df.empty or len(df.columns) == 0:
        con.close()
        return
    
    con.register("df", df)
    con.execute("""
      INSERT INTO fact_observations
      SELECT dataset_code, time, geo, value, unit, freq, status, dims_json, series_key
      FROM df;
    """)
    parquet_dir = ensure_dir(cfg.get("warehouse", "parquet_dir"))
    df.to_parquet(parquet_dir / f"fact_observations__{dataset_code}.parquet", index=False)
    con.close()
