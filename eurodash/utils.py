from __future__ import annotations
import json
from pathlib import Path
from typing import Any
import requests
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

class HttpError(RuntimeError):
    pass

@retry(
    reraise=True,
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=1, min=1, max=20),
    retry=retry_if_exception_type((requests.RequestException, HttpError)),
)
def http_get(url: str, timeout: int = 45) -> requests.Response:
    r = requests.get(url, timeout=timeout, headers={"User-Agent": "eurodash-factory/0.1"})
    if r.status_code >= 400:
        raise HttpError(f"GET {url} -> {r.status_code}: {r.text[:200]}")
    return r

def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p

def read_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))

def write_json(path: str | Path, obj: Any) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")
