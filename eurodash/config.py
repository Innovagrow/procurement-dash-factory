from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import yaml

@dataclass
class Config:
    raw: dict

    @staticmethod
    def load(path: str | Path = "config.yml") -> "Config":
        p = Path(path)
        data = yaml.safe_load(p.read_text(encoding="utf-8"))
        return Config(raw=data)

    def get(self, *keys, default=None):
        d = self.raw
        for k in keys:
            if not isinstance(d, dict) or k not in d:
                return default
            d = d[k]
        return d
