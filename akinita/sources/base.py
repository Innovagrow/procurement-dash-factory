"""Contract every portal adapter implements."""
from __future__ import annotations

import dataclasses
from abc import ABC, abstractmethod
from typing import Iterator, List, Optional, Tuple

from ..models import Broker, Listing


@dataclasses.dataclass
class SearchQuery:
    """Portal-agnostic description of a search.

    `bbox` is (north, east, south, west); leave it None for the whole country.
    """

    transaction: str = "buy"          # buy | rent | auction
    item_type: str = "residence"      # residence | prof | land | parking
    max_price: Optional[float] = None
    min_price: Optional[float] = None
    max_size: Optional[float] = None
    min_size: Optional[float] = None
    bbox: Optional[Tuple[float, float, float, float]] = None
    sorting: Optional[str] = None
    max_pages: Optional[int] = None
    extra: dict = dataclasses.field(default_factory=dict)

    def describe(self) -> str:
        bits = [self.item_type, self.transaction]
        if self.min_price:
            bits.append(f">={self.min_price:,.0f}EUR")
        if self.max_price:
            bits.append(f"<={self.max_price:,.0f}EUR")
        if self.bbox:
            bits.append("bbox")
        return " ".join(bits)


class PropertySource(ABC):
    """A portal we can pull listings from.

    `robots.txt` is a portal's policy for crawlers. Its Terms of Use are the
    contract, and where the two disagree the contract wins. A source whose terms
    reserve the content sets `requires_consent`, and the screener then refuses
    to run it until the operator states they hold written permission. The point
    is not to lecture: it is that this distinction is easy to miss precisely
    when a run is about to succeed.
    """

    name: str = "abstract"
    supports_bbox: bool = False
    requires_consent: bool = False
    terms_notice: str = ""
    terms_url: str = ""

    def __init__(self, fetcher):
        self.fetcher = fetcher

    @abstractmethod
    def search(self, query: SearchQuery) -> Iterator[Listing]:
        """Yield listings matching `query`, paging until exhausted."""

    @abstractmethod
    def count(self, query: SearchQuery) -> int:
        """Total number of listings matching `query` (one cheap request)."""

    def brokers(self) -> List[Broker]:
        """Directory of real estate professionals, when the portal exposes one."""
        raise NotImplementedError(f"{self.name} exposes no broker directory")
