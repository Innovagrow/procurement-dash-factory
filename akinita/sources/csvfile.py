# -*- coding: utf-8 -*-
"""
CSV / TSV source — feed the engine any listing data you already have.

The portals are the fragile part of this system: one is behind bot management,
another refuses Claude agents by name, and both can change their minds on a
Tuesday. Everything downstream - valuation, the 32 plans, the six indicators,
the stress test - depends on none of that. It needs a price, a size and a place.

So this adapter takes a file. Your own pipeline, a broker's export, a paid data
feed, a spreadsheet someone maintains by hand: if it has columns, it works, and
the whole analysis runs with no network at all.

Column names are matched loosely and case-insensitively, in Greek or English:

    price     τιμή / τίμημα / price / asking
    size      εμβαδόν / τμ / sqm / size / area
    area      περιοχή / area / location / address / δήμος
    type      τύπος / type / κατηγορία        (κατοικία/επαγγελματικό/γη/parking)
    year      έτος / year / κατασκευή
    lat/lng   lat / latitude / γεωγραφικό πλάτος ...
    url       url / link / σύνδεσμος
    notes     περιγραφή / description / σχόλια / κατάσταση

    python -m akinita.screener --source csv --csv-path akinita.csv --all-types
"""
from __future__ import annotations

import csv
import os
import re
from typing import Dict, Iterator, List, Optional

from ..geo import normalise_area
from ..models import Listing, parse_area, parse_money
from .base import PropertySource, SearchQuery

_ACCENTS = str.maketrans("άέήίόύώϊϋΐΰςΆΈΉΊΌΎΏ", "αεηιουωιυιυσαεηιουω")


def _norm(text: str) -> str:
    return re.sub(r"[\s_\-./]+", "_", (text or "").strip().lower().translate(_ACCENTS)).strip("_")


def _norm_all(aliases: Dict[str, tuple]) -> Dict[str, tuple]:
    """Normalise the alias tables the same way headers are normalised.

    Without this the two sides never meet on Greek words ending in sigma: a
    header "Κωδικός" normalises to "κωδικοσ" (final sigma folded), while the
    alias was typed "κωδικος" with the final form. Same word, no match.
    """
    return {key: tuple(sorted({_norm(a) for a in values})) for key, values in aliases.items()}


def map_columns(fieldnames) -> Dict[str, str]:
    """Best-effort match of a file's headers onto the fields we need."""
    normalised = {_norm(name): name for name in (fieldnames or [])}
    mapping: Dict[str, str] = {}
    for field, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in normalised:
                mapping[field] = normalised[alias]
                break
        else:
            # Fall back to a substring hit, so "asking_price_eur" still lands.
            for key, original in normalised.items():
                if any(alias in key for alias in aliases):
                    mapping[field] = original
                    break
    return mapping


def normalise_type(value: str) -> str:
    """Map whatever the file calls a property onto one of the four types.

    Three passes, narrowest first. A plain substring test is not safe here:
    "warehouse" contains "house", so a warehouse was filed as a home until this
    matched on whole words instead.
    """
    key = _norm(value)
    if not key:
        return "residence"

    for item_type, aliases in TYPE_ALIASES.items():
        if key in aliases:
            return item_type

    tokens = set(key.split("_"))
    for item_type, aliases in TYPE_ALIASES.items():
        if tokens & set(aliases):
            return item_type

    for item_type, aliases in TYPE_ALIASES.items():
        for alias in aliases:
            if len(alias) >= 5 and re.search(r"(?<!\w)" + re.escape(alias), key):
                return item_type
    return "residence"


# Every spelling we are willing to recognise for each field we need.
COLUMN_ALIASES: Dict[str, tuple] = {
    "price": ("price", "τιμη", "τιμημα", "asking", "ζητουμενη", "αξια", "amount", "ποσο"),
    "size": ("size", "sqm", "area_sqm", "εμβαδον", "τμ", "τετραγωνικα", "m2", "sq_m",
             "μεγεθος", "surface"),
    "area": ("area", "location", "address", "περιοχη", "διευθυνση", "τοποθεσια", "δημος",
             "πολη", "city", "region", "neighbourhood", "γειτονια"),
    "type": ("type", "item_type", "τυπος", "κατηγορια", "ειδος", "property_type"),
    "year": ("year", "construction_year", "ετος", "κατασκευη", "built"),
    "lat": ("lat", "latitude", "γεωγραφικο_πλατος", "geo_lat"),
    "lng": ("lng", "lon", "longitude", "γεωγραφικο_μηκος", "geo_lng"),
    "url": ("url", "link", "συνδεσμος", "href", "αγγελια"),
    "notes": ("notes", "description", "περιγραφη", "σχολια", "κατασταση", "λεπτομερειες",
              "title", "τιτλος"),
    "id": ("id", "listing_id", "code", "κωδικος", "αα"),
    "rent": ("rent", "ενοικιο", "μισθωμα", "monthly_rent"),
}

# What people actually write in a "type" column, mapped onto the four the
# engine reasons about.
TYPE_ALIASES: Dict[str, tuple] = {
    "residence": ("residence", "κατοικια", "διαμερισμα", "μονοκατοικια", "μεζονετα",
                  "σπιτι", "apartment", "house", "flat", "maisonette", "villa", "βιλα",
                  "γκαρσονιερα", "studio", "ρετιρε", "οροφοδιαμερισμα"),
    "prof": ("prof", "επαγγελματικο", "επαγγελματικος", "καταστημα", "γραφειο", "αποθηκη",
             "βιοτεχνια", "commercial", "office", "shop", "warehouse", "industrial",
             "ξενοδοχειο", "hotel", "κτιριο", "building"),
    "land": ("land", "γη", "οικοπεδο", "αγροτεμαχιο", "χωραφι", "plot", "parcel",
             "κτημα", "εκταση", "field"),
    "parking": ("parking", "παρκινγκ", "θεση_σταθμευσης", "garage", "γκαραζ"),
}

COLUMN_ALIASES = _norm_all(COLUMN_ALIASES)
TYPE_ALIASES = _norm_all(TYPE_ALIASES)


class CsvSource(PropertySource):
    """Reads listings from a local file. No network, no robots, no bot walls."""

    name = "csv"
    supports_bbox = False

    def __init__(self, fetcher, path: str = "", delimiter: str = ""):
        super().__init__(fetcher)
        self.path = path
        self.delimiter = delimiter
        self._cache: Optional[List[Listing]] = None
        self.unmapped: List[str] = []

    def _read(self) -> List[Listing]:
        if self._cache is not None:
            return self._cache
        if not self.path or not os.path.exists(self.path):
            raise FileNotFoundError(f"Δεν βρέθηκε το αρχείο: {self.path!r}")

        with open(self.path, encoding="utf-8-sig", newline="") as handle:
            sample = handle.read(8192)
            handle.seek(0)
            delimiter = self.delimiter
            if not delimiter:
                try:
                    delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
                except csv.Error:
                    delimiter = ","
            reader = csv.DictReader(handle, delimiter=delimiter)
            mapping = map_columns(reader.fieldnames)
            missing = [f for f in ("price", "size", "area") if f not in mapping]
            if missing:
                raise ValueError(
                    "Το αρχείο πρέπει να έχει στήλες για: "
                    + ", ".join(missing)
                    + f". Βρέθηκαν: {', '.join(reader.fieldnames or [])}"
                )
            self.unmapped = [f for f in COLUMN_ALIASES if f not in mapping]

            listings: List[Listing] = []
            for index, row in enumerate(reader, 1):
                # One accessor for every optional field, so a file that simply
                # does not have a column never raises - it just leaves a gap the
                # rest of the engine already knows how to handle.
                def text(field: str, default: str = "") -> str:
                    column = mapping.get(field)
                    return (row.get(column) or default).strip() if column else default

                def number(field: str) -> Optional[float]:
                    raw = text(field)
                    if not raw:
                        return None
                    try:
                        return float(raw.replace(".", "").replace(",", ".")
                                     if raw.count(".") > 1 else raw.replace(",", "."))
                    except ValueError:
                        return None

                price = parse_money(text("price"))
                size = parse_area(text("size"))
                if not price or price <= 0:
                    continue
                address = text("area")
                notes = text("notes")
                year = number("year")

                listings.append(Listing(
                    source=self.name,
                    listing_id=text("id") or f"csv{index}",
                    url=text("url"),
                    title=notes[:90] or f"{address} {size or ''}".strip(),
                    address=address,
                    area_name=normalise_area(address),
                    sub_area=address,
                    item_type=normalise_type(text("type")),
                    transaction="SALE",
                    price=price,
                    size_sqm=size,
                    construction_year=int(year) if year and 1800 < year < 2100 else None,
                    lat=number("lat"),
                    lng=number("lng"),
                    description_hint=notes,
                ))
        self._cache = listings
        return listings

    def rent_listings(self) -> List[Listing]:
        """Rent comparables built from a `rent` column, where the file has one.

        Without local rents nothing that lets the property can be priced, and
        the engine would report every income plan as infeasible - technically
        true, entirely useless. One extra column unlocks all of them.
        """
        column = None
        try:
            self._read()
        except (FileNotFoundError, ValueError):
            return []
        with open(self.path, encoding="utf-8-sig", newline="") as handle:
            sample = handle.read(8192)
            handle.seek(0)
            delimiter = self.delimiter
            if not delimiter:
                try:
                    delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
                except csv.Error:
                    delimiter = ","
            reader = csv.DictReader(handle, delimiter=delimiter)
            mapping = map_columns(reader.fieldnames)
            column = mapping.get("rent")
            if not column:
                return []
            rents: List[Listing] = []
            for index, row in enumerate(reader, 1):
                rent = parse_money(row.get(column))
                size = parse_area(row.get(mapping["size"]) if "size" in mapping else None)
                if not rent or not size:
                    continue
                address = (row.get(mapping["area"]) or "").strip() if "area" in mapping else ""
                rents.append(Listing(
                    source=self.name, listing_id=f"rent{index}", url="",
                    address=address, area_name=normalise_area(address), sub_area=address,
                    item_type=normalise_type(
                        row.get(mapping["type"], "") if "type" in mapping else ""),
                    transaction="RENT", price=rent, size_sqm=size,
                ))
        return rents

    def count(self, query: SearchQuery) -> int:
        return sum(1 for _ in self._matching(query))

    def search(self, query: SearchQuery) -> Iterator[Listing]:
        yield from self._matching(query)

    def _matching(self, query: SearchQuery) -> Iterator[Listing]:
        for listing in self._read():
            if query.item_type and listing.item_type != query.item_type:
                continue
            if query.max_price and listing.price and listing.price > query.max_price:
                continue
            if query.min_price and listing.price and listing.price < query.min_price:
                continue
            if query.min_size and listing.size_sqm and listing.size_sqm < query.min_size:
                continue
            if query.max_size and listing.size_sqm and listing.size_sqm > query.max_size:
                continue
            yield listing
