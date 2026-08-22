"""Normalised records shared by every source adapter."""
from __future__ import annotations

import dataclasses
import re
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------- parsing ---

_NON_DIGIT = re.compile(r"[^\d,.]")


def parse_money(value: Any) -> Optional[float]:
    """`'47.000 €'` -> `47000.0`. Greek thousands separator is `.`."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = _NON_DIGIT.sub("", str(value).replace("\xa0", " ")).strip()
    if not cleaned:
        return None
    # Greek format: 1.234.567,89 -> drop dots, comma becomes the decimal point.
    cleaned = cleaned.replace(".", "").replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_area(value: Any) -> Optional[float]:
    """`'280 τ.μ.'` -> `280.0`."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    match = re.search(r"([\d.,]+)", str(value).replace("\xa0", " "))
    return parse_money(match.group(1)) if match else None


def parse_age_days(value: Any) -> Optional[int]:
    """Turn xe.gr's relative date (`'πριν από 3 ημέρες'`) into days."""
    if not value:
        return None
    text = str(value).lower()
    match = re.search(r"(\d+)", text)
    number = int(match.group(1)) if match else 1
    if "λεπτ" in text or "ώρ" in text or "σήμερα" in text:
        return 0
    if "ημέρ" in text or "μέρ" in text:
        return number
    if "εβδομάδ" in text:
        return number * 7
    if "μήν" in text:
        return number * 30
    if "χρόν" in text or "έτ" in text:
        return number * 365
    return None


# ---------------------------------------------------------------- records ---


@dataclasses.dataclass
class Listing:
    """One property advertisement, normalised across sources."""

    source: str
    listing_id: str
    url: str
    title: str = ""
    address: str = ""
    area_name: str = ""       # "Θεσσαλονίκη" - municipality level
    sub_area: str = ""        # "Θεσσαλονίκη (Ξηροκρήνη)" - neighbourhood level
    item_type: str = ""          # residence | prof | land | parking
    transaction: str = ""        # SALE | RENT | AUCTION
    price: Optional[float] = None
    size_sqm: Optional[float] = None
    price_per_sqm: Optional[float] = None
    bedrooms: Optional[int] = None
    bathrooms: Optional[int] = None
    construction_year: Optional[int] = None
    levels: List[str] = dataclasses.field(default_factory=list)
    lat: Optional[float] = None
    lng: Optional[float] = None
    listed_age_days: Optional[int] = None
    auction_date: Optional[str] = None
    is_commercial_seller: bool = False
    company_title: str = ""
    account_id: str = ""
    description_hint: str = ""   # SEO/alt text, carries condition keywords
    image: str = ""
    raw: Dict[str, Any] = dataclasses.field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.price_per_sqm is None and self.price and self.size_sqm:
            self.price_per_sqm = round(self.price / self.size_sqm, 2)

    def to_dict(self) -> Dict[str, Any]:
        data = dataclasses.asdict(self)
        data.pop("raw", None)
        data["levels"] = "|".join(self.levels or [])
        return data


@dataclasses.dataclass
class Broker:
    """A real estate professional we can address the campaign to."""

    source: str
    profile_id: str
    name: str
    category: str = ""           # μεσιτικό γραφείο / εταιρεία διαχείρισης / κατασκευαστική
    profile_url: str = ""
    email: str = ""
    phone: str = ""
    address: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    listings_count: Optional[int] = None

    @property
    def is_contactable(self) -> bool:
        return bool(self.email or self.phone)

    def to_dict(self) -> Dict[str, Any]:
        data = dataclasses.asdict(self)
        data["is_contactable"] = self.is_contactable
        return data


@dataclasses.dataclass
class ScoredListing:
    """A listing plus the opportunity assessment attached to it."""

    listing: Listing
    score: float
    grade: str
    components: Dict[str, float]
    evidence: List[str]
    flags: List[str]
    market_price_per_sqm: Optional[float] = None
    discount_pct: Optional[float] = None
    est_monthly_rent: Optional[float] = None
    gross_yield_pct: Optional[float] = None

    def to_dict(self) -> Dict[str, Any]:
        data = self.listing.to_dict()
        data.update(
            {
                "score": self.score,
                "grade": self.grade,
                "market_price_per_sqm": self.market_price_per_sqm,
                "discount_pct": self.discount_pct,
                "est_monthly_rent": self.est_monthly_rent,
                "gross_yield_pct": self.gross_yield_pct,
                "evidence": " | ".join(self.evidence),
                "flags": " | ".join(self.flags),
            }
        )
        for key, value in self.components.items():
            data["score_" + key] = value
        return data
