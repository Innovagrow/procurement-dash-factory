# -*- coding: utf-8 -*-
"""
Mapping a coordinate to a Greek statistical region.

Nearest-centroid fails badly in Greece: Corfu's centroid sits closer to the
Epirus centroid than to the Ionian one, so a single point per region would file
half the islands under the mainland. Each region therefore carries several
representative points and wins on the nearest of any of them.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from ..geo import haversine_km

# NUTS 2 code -> (Greek name, [representative points])
GREEK_REGIONS: Dict[str, Tuple[str, List[Tuple[float, float]]]] = {
    "EL30": ("Αττική", [(38.02, 23.73), (37.94, 23.65), (38.15, 23.80), (37.85, 23.75)]),
    "EL41": ("Βόρειο Αιγαίο", [(39.10, 26.55), (37.75, 26.98), (38.37, 26.14), (39.90, 25.15)]),
    "EL42": ("Νότιο Αιγαίο", [(37.44, 24.94), (37.45, 25.33), (36.40, 25.43), (36.44, 28.22),
                              (36.85, 27.24), (37.10, 25.48), (36.90, 27.29)]),
    "EL43": ("Κρήτη", [(35.34, 25.14), (35.51, 24.02), (35.37, 24.48), (35.20, 26.10)]),
    "EL51": ("Αν. Μακεδονία & Θράκη", [(41.14, 24.89), (40.94, 24.41), (41.09, 25.40), (40.85, 25.87)]),
    "EL52": ("Κεντρική Μακεδονία", [(40.64, 22.94), (41.09, 23.55), (40.28, 22.51), (40.30, 23.55)]),
    "EL53": ("Δυτική Μακεδονία", [(40.30, 21.79), (40.52, 21.27), (40.78, 21.41), (40.08, 21.42)]),
    "EL54": ("Ήπειρος", [(39.67, 20.85), (39.50, 20.27), (39.15, 20.99), (39.55, 21.26)]),
    "EL61": ("Θεσσαλία", [(39.64, 22.42), (39.36, 22.94), (39.56, 21.77), (39.90, 22.60)]),
    "EL62": ("Ιόνια Νησιά", [(39.62, 19.92), (38.72, 20.64), (38.18, 20.57), (37.79, 20.90)]),
    "EL63": ("Δυτική Ελλάδα", [(38.25, 21.73), (38.62, 21.41), (37.67, 21.44), (38.37, 21.13)]),
    "EL64": ("Στερεά Ελλάδα", [(38.90, 22.43), (38.46, 23.60), (38.63, 22.63), (38.75, 23.65)]),
    "EL65": ("Πελοπόννησος", [(37.04, 22.11), (37.51, 22.38), (37.63, 22.73), (36.74, 22.55),
                              (37.94, 22.93)]),
}


def region_for(lat: Optional[float], lng: Optional[float]) -> Optional[Tuple[str, str, float]]:
    """Return (NUTS2 code, Greek name, distance km) for a coordinate."""
    if lat is None or lng is None:
        return None
    best_code, best_name, best_distance = None, None, float("inf")
    for code, (name, points) in GREEK_REGIONS.items():
        for plat, plng in points:
            distance = haversine_km(lat, lng, plat, plng)
            if distance < best_distance:
                best_code, best_name, best_distance = code, name, distance
    # Beyond this the point is not plausibly inside any Greek region.
    if best_distance > 220:
        return None
    return best_code, best_name, round(best_distance, 1)


def normalise_greek(text: str) -> str:
    """Uppercase, strip accents and final-sigma, for loose Greek name matching."""
    if not text:
        return ""
    table = str.maketrans("άέήίόύώϊϋΐΰςΆΈΉΊΌΎΏ", "αεηιουωιυιυσΑΕΗΙΟΥΩ")
    return text.translate(table).upper().strip()
