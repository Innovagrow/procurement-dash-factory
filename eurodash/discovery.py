# eurodash/discovery.py
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional
from datetime import datetime

from eurodash.utils import http_get, HttpError


@dataclass
class DatasetStructure:
    dataset_code: str
    dims: List[str]
    categories: Dict[str, List[str]]  # dim -> sample codes


BASE_URL = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data"


def _build_url(dataset_code: str, params: Dict[str, str]) -> str:
    qs = "&".join([f"{k}={v}" for k, v in params.items() if v is not None and v != ""])
    return f"{BASE_URL}/{dataset_code}?{qs}"


def _parse_structure(dataset_code: str, js: dict) -> DatasetStructure:
    dims = js.get("id", []) or []
    dim_meta = js.get("dimension", {}) or {}

    cats: Dict[str, List[str]] = {}
    for d in dims:
        cat = (dim_meta.get(d, {}) or {}).get("category", {}) or {}
        idx = cat.get("index", None)

        # JSON-stat: "index" can be dict(code->pos) or list of codes
        if isinstance(idx, dict):
            codes = list(idx.keys())
        elif isinstance(idx, list):
            codes = [str(x) for x in idx]
        else:
            # fallback: sometimes "label" exists
            labels = cat.get("label", {})
            if isinstance(labels, dict):
                codes = list(labels.keys())
            else:
                codes = []

        cats[d] = codes

    return DatasetStructure(dataset_code=dataset_code, dims=dims, categories=cats)


def discover_structure(cfg, dataset_code: str, time_hint: Optional[str] = None, geo_level: Optional[str] = None) -> DatasetStructure:
    """
    Discover dataset dimensions and categories.
    Eurostat may reject large extractions with 413. We handle this by retrying with
    smaller requests (remove geoLevel, add tight time filters).
    """
    # config getters (your Config object supports cfg.get(section, key, default=...))
    timeout = int(cfg.get("ingestion", "request_timeout_s", default=45))
    geo_level = geo_level or cfg.get("ingestion", "geo_level", default=None)

    # base params
    base_params = {"format": "JSON", "lang": "EN"}
    if geo_level:
        base_params["geoLevel"] = geo_level

    # candidate time filters for shrinking
    # We try a few formats because Eurostat datasets use different time code patterns.
    now = datetime.utcnow()
    y = now.year
    years = [str(y), str(y - 1), str(y - 2), "2023", "2022"]

    # if caller provided a hint, try it first
    time_candidates: List[str] = []
    if time_hint:
        time_candidates.append(time_hint)

    # Common patterns for monthly datasets
    # Try recent months for current/previous year
    for yr in [y, y - 1]:
        for m in [12, 11, 10, 9, 6, 3, 1]:
            time_candidates.extend([
                f"{yr}M{m:02d}",     # 2025M12
                f"{yr}-{m:02d}",     # 2025-12
            ])

    # Annual fallbacks
    time_candidates.extend(years)

    # helper: attempt a request and return structure
    def attempt(params: Dict[str, str]) -> DatasetStructure:
        url = _build_url(dataset_code, params)
        r = http_get(url, timeout=timeout)
        js = r.json()
        return _parse_structure(dataset_code, js)

    # 1) Try the normal request first
    try:
        return attempt(dict(base_params))
    except HttpError as e:
        msg = str(e)

        # If not 413, rethrow immediately
        if "-> 413" not in msg and " 413" not in msg:
            raise

    # 2) Retry WITHOUT geoLevel (often reduces explosion)
    params2 = dict(base_params)
    params2.pop("geoLevel", None)
    try:
        return attempt(params2)
    except HttpError as e:
        msg = str(e)
        if "-> 413" not in msg and " 413" not in msg:
            raise

    # 3) Retry with a tight time filter (and without geoLevel)
    for t in time_candidates:
        params3 = dict(params2)
        params3["time"] = t
        try:
            return attempt(params3)
        except HttpError as e:
            # continue on 413 or 400, stop on other errors
            emsg = str(e)
            if "-> 413" in emsg or " 413" in emsg or "-> 400" in emsg or " 400" in emsg:
                continue
            raise

    # If all fallbacks failed, raise a clear error
    raise HttpError(
        f"Failed to discover structure for {dataset_code}: even reduced requests were rejected."
    )
