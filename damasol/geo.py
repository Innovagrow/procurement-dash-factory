"""
Geographic helpers: grid cells for grouping comparables, bounding boxes for
area-scoped queries, and proximity to the Greek urban centres.
"""
from __future__ import annotations

import math
from typing import Dict, Optional, Tuple

# Approximate centres of the markets that actually carry rental demand and
# resale liquidity. Distance to the nearest of these feeds the liquidity score.
URBAN_CENTRES: Dict[str, Tuple[float, float, int]] = {
    # name: (lat, lng, tier)  - tier 1 = deepest market
    "Αθήνα": (37.9838, 23.7275, 1),
    "Θεσσαλονίκη": (40.6401, 22.9444, 1),
    "Πάτρα": (38.2466, 21.7346, 2),
    "Ηράκλειο": (35.3387, 25.1442, 2),
    "Λάρισα": (39.6390, 22.4191, 2),
    "Βόλος": (39.3621, 22.9420, 2),
    "Ιωάννινα": (39.6650, 20.8537, 2),
    "Χανιά": (35.5138, 24.0180, 2),
    "Ρόδος": (36.4341, 28.2176, 2),
    "Κέρκυρα": (39.6243, 19.9217, 2),
    "Καβάλα": (40.9396, 24.4069, 3),
    "Καλαμάτα": (37.0389, 22.1142, 3),
    "Χαλκίδα": (38.4625, 23.5950, 3),
    "Σέρρες": (41.0856, 23.5480, 3),
    "Αλεξανδρούπολη": (40.8476, 25.8744, 3),
    "Κοζάνη": (40.3007, 21.7887, 3),
    "Τρίκαλα": (39.5551, 21.7679, 3),
    "Λαμία": (38.8997, 22.4340, 3),
    "Ξάνθη": (41.1353, 24.8880, 3),
    "Αγρίνιο": (38.6214, 21.4079, 3),
}

# Whole-of-Greece bounding box (north, east, south, west).
GREECE_BBOX = (41.7503, 29.6540, 34.5428, 18.9949)

EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def nearest_urban_centre(lat: Optional[float], lng: Optional[float]):
    """Return (name, distance_km, tier) for the closest major market."""
    if lat is None or lng is None:
        return (None, None, None)
    best = min(
        URBAN_CENTRES.items(),
        key=lambda kv: haversine_km(lat, lng, kv[1][0], kv[1][1]),
    )
    name, (clat, clng, tier) = best
    return (name, haversine_km(lat, lng, clat, clng), tier)


def geo_cell(lat: Optional[float], lng: Optional[float], size: float = 0.05) -> Optional[str]:
    """Snap a coordinate to a grid cell id. 0.05 degrees is roughly 5.5 km."""
    if lat is None or lng is None:
        return None
    return "%.3f,%.3f" % (math.floor(lat / size) * size, math.floor(lng / size) * size)


def cell_bbox(cell: str, size: float = 0.05, pad: float = 0.02):
    """Bounding box (north, east, south, west) around a grid cell.

    `pad` widens the box so a listing near a cell edge still finds comparables.
    """
    lat, lng = (float(v) for v in cell.split(","))
    return (lat + size + pad, lng + size + pad, lat - pad, lng - pad)


def normalise_area(address: Optional[str]) -> str:
    """`'Νέα Ερυθραία (Καστρί)'` -> `'Νέα Ερυθραία'`; used to group comparables."""
    if not address:
        return ""
    return address.split("(")[0].strip().rstrip(",").strip()
