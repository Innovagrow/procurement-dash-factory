# eurodash/utils.py
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional
import json

import requests
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type


class HttpError(RuntimeError):
    pass


@retry(
    reraise=True,
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type((requests.RequestException, HttpError)),
)
def http_get(
    url: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    timeout: int = 45,
) -> requests.Response:
    """
    Simple GET wrapper with retries.
    Supports query params via requests.get(params=...).
    """
    r = requests.get(
        url,
        params=params,
        timeout=timeout,
        headers={"User-Agent": "eurodash-factory/0.1"},
    )
    if r.status_code >= 400:
        raise HttpError(f"GET {r.url} -> {r.status_code}: {r.text[:200]}")
    return r


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_json(path: str | Path, data: Any) -> None:
    """
    Write JSON to disk with UTF-8 encoding and pretty formatting.
    """
    p = Path(path)
    if p.parent:
        p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def read_json(path: str | Path) -> Any:
    """
    Read JSON from disk with UTF-8 encoding.
    """
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)
