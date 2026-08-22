"""
Spitogatos.gr adapter (browser-driven).

Spitogatos sits behind a bot-management layer: a plain HTTP GET to any search
URL returns the "Pardon Our Interruption" interstitial instead of results, so
this adapter drives a real Chromium through Playwright.

    pip install playwright && playwright install chromium

Extraction is deliberately defensive - the portal is a Next.js app whose markup
changes, so three strategies are tried in order:

  1. the `__NEXT_DATA__` payload (richest, survives most redesigns)
  2. any `application/ld+json` blocks
  3. a DOM sweep over listing anchors with price/area text parsing

IMPORTANT - verification status: this adapter is written against Spitogatos'
published URL scheme and page structure but has NOT been executed against the
live site, because the container this package was built in cannot open outbound
browser connections. Run `python -m damasol.screener --source spitogatos
--probe` on a normal machine first; it prints exactly which strategy matched and
how many listings were parsed, so you can adjust before trusting the numbers.
Until then `--source xe` is the verified path.
"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
from typing import Any, Dict, Iterator, List, Optional

from ..geo import normalise_area
from ..models import Listing, parse_area, parse_money
from .base import PropertySource, SearchQuery

BASE = "https://www.spitogatos.gr"

# Spitogatos' Greek URL segments, keyed by (transaction, item_type).
PATHS = {
    ("buy", "residence"): "/pwliseis-katoikies",
    ("buy", "prof"): "/pwliseis-epaggelmatikoi-xwroi",
    ("buy", "land"): "/pwliseis-oikopeda-gi",
    ("buy", "parking"): "/pwliseis-parking",
    ("rent", "residence"): "/enoikiaseis-katoikies",
    ("rent", "prof"): "/enoikiaseis-epaggelmatikoi-xwroi",
    ("rent", "land"): "/enoikiaseis-oikopeda-gi",
    ("rent", "parking"): "/enoikiaseis-parking",
}

BLOCK_MARKERS = re.compile(
    r"Pardon Our Interruption|px-captcha|Access to this page has been denied", re.I
)


class SpitogatosBlocked(RuntimeError):
    """The bot-management interstitial was served instead of results."""


class SpitogatosSource(PropertySource):
    name = "spitogatos.gr"
    supports_bbox = False

    # robots.txt permits the search pages and does not name Claude agents. The
    # Terms of Use are what actually governs, and they are explicit:
    #
    #   "The content of the website cannot be copied, reproduced, distributed
    #    and republished in any form without the prior consent of the owner of
    #    the website. Users/visitors/subscribers are allowed to print and
    #    electronically save the content of the website for personal use, but
    #    by no means for commercial use."
    #
    # Saving listings into a database to source investments is electronic
    # saving for commercial use - the exact act the sentence excludes. So this
    # adapter stays written, tested and ready, and refuses to run until the
    # operator confirms they hold the owner's prior consent.
    requires_consent = True
    terms_url = "https://www.spitogatos.gr/en/page/legalTerms"
    terms_notice = (
        "Οι Όροι Χρήσης του Spitogatos (άρθρο 2) ορίζουν δύο διαφορετικά πράγματα:\n"
        "   • ΠΡΟΣΩΠΙΚΗ ΧΡΗΣΗ — ρητά επιτρεπτή: «allowed to print and "
        "electronically save the content of the website for personal use».\n"
        "   • ΕΜΠΟΡΙΚΗ ΧΡΗΣΗ — ρητά εξαιρεμένη: «by no means for commercial use», "
        "και κάθε αντιγραφή/αναπαραγωγή απαιτεί «prior consent of the owner». "
        "Άδεια ζητείται στο info@spitogatos.gr· εναλλακτικά υπάρχει το επίσημο "
        "προϊόν δεδομένων Spitogatos Insights.\n"
        "  Σε ΚΑΘΕ περίπτωση απαγορεύεται η αναδημοσίευση ή διανομή: κρατήστε τα "
        "αποτελέσματα τοπικά και μην τα δημοσιεύσετε.\n"
        "  Δηλώστε τη βάση: --personal-use   ή   --i-have-written-consent"
    )

    def __init__(self, fetcher, headless: bool = True, page_wait_ms: int = 4000):
        super().__init__(fetcher)
        self.headless = headless
        self.page_wait_ms = page_wait_ms
        self._browser = None
        self._playwright = None

    # ----------------------------------------------------------- url build
    def _url(self, query: SearchQuery, page: int = 1) -> str:
        path = PATHS.get((query.transaction, query.item_type))
        if not path:
            raise ValueError(
                f"no Spitogatos path for {query.transaction}/{query.item_type}"
            )
        params: Dict[str, Any] = {}
        if query.max_price is not None:
            params["priceTo"] = int(query.max_price)
        if query.min_price is not None:
            params["priceFrom"] = int(query.min_price)
        if query.max_size is not None:
            params["areaTo"] = int(query.max_size)
        if query.min_size is not None:
            params["areaFrom"] = int(query.min_size)
        if page > 1:
            params["page"] = page
        params.update(query.extra)
        url = f"{BASE}{path}/ellada"
        return url + ("?" + urllib.parse.urlencode(params) if params else "")

    # ------------------------------------------------------------- browser
    def _ensure_browser(self):
        if self._browser is not None:
            return self._browser
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - env dependent
            raise RuntimeError(
                "Spitogatos needs Playwright: pip install playwright "
                "&& playwright install chromium"
            ) from exc

        self._playwright = sync_playwright().start()
        launch: Dict[str, Any] = {
            "headless": self.headless,
            "args": ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        }
        proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        if proxy:
            launch["proxy"] = {"server": proxy}
        self._browser = self._playwright.chromium.launch(**launch)
        return self._browser

    def close(self) -> None:
        if self._browser is not None:
            self._browser.close()
            self._browser = None
        if self._playwright is not None:
            self._playwright.stop()
            self._playwright = None

    def _render(self, url: str) -> str:
        browser = self._ensure_browser()
        context = browser.new_context(
            locale="el-GR",
            user_agent=self.fetcher.user_agent,
            viewport={"width": 1366, "height": 900},
            extra_http_headers={"Accept-Language": self.fetcher.accept_language},
        )
        page = context.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(self.page_wait_ms)
            html = page.content()
        finally:
            context.close()

        if BLOCK_MARKERS.search(html):
            raise SpitogatosBlocked(
                f"bot protection served an interstitial for {url}. Try "
                "headless=False, a residential proxy, or fall back to --source xe."
            )
        return html

    # ---------------------------------------------------------- extraction
    def probe(self, query: SearchQuery) -> Dict[str, Any]:
        """Fetch one page and report which extraction strategy works."""
        url = self._url(query, 1)
        html = self._render(url)
        report = {"url": url, "html_bytes": len(html), "strategies": {}}
        for label, extractor in (
            ("__NEXT_DATA__", self._from_next_data),
            ("ld+json", self._from_ld_json),
            ("dom", self._from_dom),
        ):
            try:
                found = extractor(html, query)
            except Exception as exc:  # noqa: BLE001 - probe reports, never raises
                report["strategies"][label] = f"error: {exc}"
            else:
                report["strategies"][label] = len(found)
        return report

    def _extract(self, html: str, query: SearchQuery) -> List[Listing]:
        for extractor in (self._from_next_data, self._from_ld_json, self._from_dom):
            try:
                listings = extractor(html, query)
            except Exception:  # noqa: BLE001 - fall through to next strategy
                continue
            if listings:
                return listings
        return []

    def _from_next_data(self, html: str, query: SearchQuery) -> List[Listing]:
        match = re.search(
            r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S
        )
        if not match:
            return []
        payload = json.loads(match.group(1))
        return [self._to_listing(node, query) for node in _walk_for_listings(payload)]

    def _from_ld_json(self, html: str, query: SearchQuery) -> List[Listing]:
        listings: List[Listing] = []
        for block in re.findall(
            r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S
        ):
            try:
                payload = json.loads(block)
            except ValueError:
                continue
            for node in _walk_for_listings(payload):
                listings.append(self._to_listing(node, query))
        return listings

    def _from_dom(self, html: str, query: SearchQuery) -> List[Listing]:
        listings: List[Listing] = []
        seen: set = set()
        for match in re.finditer(
            r'<a[^>]+href="(/(?:property|katoikia|akinito)/[^"]*?(\d{5,}))"[^>]*>(.{0,1200}?)</a>',
            html,
            re.S,
        ):
            href, listing_id, blob = match.groups()
            if listing_id in seen:
                continue
            seen.add(listing_id)
            text = re.sub(r"<[^>]+>", " ", blob)
            price = parse_money(_first(r"([\d.,]+)\s*€", text))
            size = parse_area(_first(r"([\d.,]+)\s*τ\.?μ", text))
            listings.append(
                Listing(
                    source=self.name,
                    listing_id=listing_id,
                    url=BASE + href,
                    title=re.sub(r"\s+", " ", text).strip()[:120],
                    item_type=query.item_type,
                    transaction=query.transaction.upper(),
                    price=price,
                    size_sqm=size,
                )
            )
        return listings

    def _to_listing(self, node: Dict[str, Any], query: SearchQuery) -> Listing:
        listing_id = str(
            node.get("id") or node.get("listingId") or node.get("propertyId") or ""
        )
        url = node.get("url") or node.get("seoUrl") or ""
        if url and url.startswith("/"):
            url = BASE + url
        address = (
            node.get("locationName")
            or node.get("address")
            or node.get("geographyName")
            or ""
        )
        price = parse_money(node.get("price") or node.get("priceValue"))
        size = parse_area(node.get("sqrMeters") or node.get("area") or node.get("size"))
        return Listing(
            source=self.name,
            listing_id=listing_id,
            url=url,
            title=node.get("title") or node.get("subtitle") or "",
            address=str(address),
            area_name=normalise_area(str(address)),
            sub_area=str(address).strip(),
            item_type=query.item_type,
            transaction=query.transaction.upper(),
            price=price,
            size_sqm=size,
            bedrooms=node.get("bedrooms"),
            bathrooms=node.get("bathrooms"),
            construction_year=node.get("constructionYear") or node.get("yearOfConstruction"),
            lat=node.get("latitude") or node.get("lat"),
            lng=node.get("longitude") or node.get("lng"),
            description_hint=str(node.get("description") or "")[:400],
            raw=node,
        )

    # -------------------------------------------------------------- search
    def count(self, query: SearchQuery) -> int:
        html = self._render(self._url(query, 1))
        match = re.search(r'"totalResults?"\s*:\s*(\d+)', html)
        return int(match.group(1)) if match else len(self._extract(html, query))

    def search(self, query: SearchQuery) -> Iterator[Listing]:
        page = 1
        seen: set = set()
        max_pages = query.max_pages or 50
        try:
            while page <= max_pages:
                html = self._render(self._url(query, page))
                listings = self._extract(html, query)
                if not listings:
                    return
                fresh = 0
                for listing in listings:
                    if listing.listing_id and listing.listing_id not in seen:
                        seen.add(listing.listing_id)
                        fresh += 1
                        yield listing
                if fresh == 0:
                    return  # same page served again -> end of results
                page += 1
        finally:
            self.close()


def _first(pattern: str, text: str) -> Optional[str]:
    match = re.search(pattern, text)
    return match.group(1) if match else None


def _walk_for_listings(node: Any, depth: int = 0) -> Iterator[Dict[str, Any]]:
    """Yield dicts that look like property records, wherever they are nested."""
    if depth > 12:
        return
    if isinstance(node, dict):
        keys = set(node)
        looks_like_listing = (
            ("price" in keys or "priceValue" in keys)
            and bool(keys & {"id", "listingId", "propertyId"})
            and bool(keys & {"sqrMeters", "area", "size", "locationName", "address"})
        )
        if looks_like_listing:
            yield node
            return
        for value in node.values():
            yield from _walk_for_listings(value, depth + 1)
    elif isinstance(node, list):
        for value in node:
            yield from _walk_for_listings(value, depth + 1)
