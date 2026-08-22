"""Property portal adapters."""
from .base import PropertySource, SearchQuery
from .xe_gr import XeGrSource
from .spitogatos import SpitogatosSource

REGISTRY = {
    "xe": XeGrSource,
    "spitogatos": SpitogatosSource,
}

__all__ = ["PropertySource", "SearchQuery", "XeGrSource", "SpitogatosSource", "REGISTRY"]
