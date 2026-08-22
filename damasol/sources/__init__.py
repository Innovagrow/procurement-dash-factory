"""Property portal adapters."""
from .base import PropertySource, SearchQuery
from .csvfile import CsvSource
from .spitogatos import SpitogatosSource
from .xe_gr import XeGrSource

REGISTRY = {
    "spitogatos": SpitogatosSource,
    "xe": XeGrSource,
    "csv": CsvSource,
}

# The four the engine reasons about. Anything a portal or a spreadsheet calls a
# property maps onto one of these.
ALL_ITEM_TYPES = ("residence", "prof", "land", "parking")

ITEM_TYPE_LABELS_EL = {
    "residence": "Κατοικία",
    "prof": "Επαγγελματικός χώρος",
    "land": "Γη / Οικόπεδο",
    "parking": "Parking",
}

__all__ = [
    "PropertySource", "SearchQuery", "XeGrSource", "SpitogatosSource", "CsvSource",
    "REGISTRY", "ALL_ITEM_TYPES", "ITEM_TYPE_LABELS_EL",
]
