"""External signal providers: what is happening around a property."""
from .base import SignalProvider, SignalReading
from .news import NewsSignal
from .public_investment import PublicInvestmentSignal
from .regions import GREEK_REGIONS, region_for
from .tourism import TourismSignal

REGISTRY = {
    TourismSignal.key: TourismSignal,
    PublicInvestmentSignal.key: PublicInvestmentSignal,
    NewsSignal.key: NewsSignal,
}

__all__ = [
    "SignalProvider", "SignalReading", "TourismSignal", "PublicInvestmentSignal",
    "NewsSignal", "GREEK_REGIONS", "region_for", "REGISTRY",
]
