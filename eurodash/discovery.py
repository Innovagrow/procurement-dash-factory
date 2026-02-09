from __future__ import annotations
from dataclasses import dataclass
from typing import Any
import urllib.parse

from .config import Config
from .utils import http_get

@dataclass
class DatasetStructure:
    dataset_code: str
    dims: list[str]
    categories: dict[str, list[str]]

def _build_url(dataset_code: str, params: dict[str, Any]) -> str:
    base = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset_code}"
    q = urllib.parse.urlencode(params, doseq=True)
    return f"{base}?{q}"

def discover_structure(cfg: Config, dataset_code: str, time_hint: str | None = None) -> DatasetStructure:
    params = {"format": "JSON", "lang": "EN"}
    if time_hint:
        params["time"] = time_hint

    geo_level = cfg.get("ingestion", "geo_level", default="country")
    if geo_level:
        params["geoLevel"] = geo_level

    url = _build_url(dataset_code, params)
    r = http_get(url, timeout=int(cfg.get("ingestion", "request_timeout_s", default=45)))
    js = r.json()

    dims = js.get("id", [])
    dim_obj = js.get("dimension", {}) or {}
    categories: dict[str, list[str]] = {}
    for d in dims:
        cat = dim_obj.get(d, {}).get("category", {})
        idx = cat.get("index")
        if isinstance(idx, dict):
            ordered = sorted(idx.items(), key=lambda kv: kv[1])
            categories[d] = [k for k, _ in ordered]
        elif isinstance(idx, list):
            categories[d] = list(idx)
        else:
            categories[d] = []
    return DatasetStructure(dataset_code=dataset_code, dims=list(dims), categories=categories)
