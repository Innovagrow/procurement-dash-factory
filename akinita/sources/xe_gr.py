"""
xe.gr / Χρυσή Ευκαιρία adapter.

The results page server-renders its whole payload into a `data-json-data`
attribute, so a plain HTTP GET returns fully structured listings - no browser,
no private API. Filter names were derived from the page's own
`supported_filters` block.

Bounding box semantics are easy to get wrong, so they are spelled out here:
    geo_lat_from = NORTH edge      geo_lat_to = SOUTH edge
    geo_lng_from = EAST  edge      geo_lng_to = WEST  edge
"""
from __future__ import annotations

import re
import urllib.parse
from typing import Iterator, List, Optional

from ..geo import normalise_area
from ..http import FetchError
from ..models import Broker, Listing, parse_age_days, parse_area, parse_money
from .base import PropertySource, SearchQuery

RESULTS_URL = "https://www.xe.gr/property/results"
BROKER_DIRECTORY_URL = "https://www.xe.gr/property/pros"

PAGE_SIZE = 34  # fixed by the portal

ITEM_TYPES = {
    "residence": "Κατοικία",
    "prof": "Επαγγελματικός χώρος",
    "land": "Γη / Οικόπεδο",
    "parking": "Parking",
}

TRANSACTIONS = {
    "buy": "Αγορά",
    "rent": "Ενοικίαση",
    "auction": "Πλειστηριασμός",
    "valuable-consideration": "Αντιπαροχή",
}

SORTINGS = {
    "price_asc",
    "price_desc",
    "price_per_unit_area_asc",
    "price_per_unit_area_desc",
    "property_area_in_sq_m_asc",
    "property_area_in_sq_m_desc",
    "publication_date_desc",
    "create_desc",
}

_PROFILE_LINK = re.compile(
    r'href="(https://www\.xe\.gr/property/s/([a-z0-9\-]+)/([^/"]*)/([0-9a-f\-]{36}))"'
)
_PROFILE_NAME = re.compile(
    r'<a class="tertiary-button normal dark-gray margin-bottom-zero" '
    r'href="(https://www\.xe\.gr/property/s/[^"]+)">([^<]*)</a>'
)

# xe.gr's own contact details show up on every profile page; they are not the
# broker's and must never reach the outreach list.
_PORTAL_EMAIL = re.compile(r"@xe\.gr$|@(?:spitogatos|tospitimou)\.gr$", re.I)
_PORTAL_PHONE = re.compile(r"^\+?30?2109091300$")

PROFILE_CATEGORIES = {
    "mesitiko-grafeio": "Μεσιτικό γραφείο",
    "etaireia-diaxeirisis-akiniton": "Εταιρεία διαχείρισης ακινήτων",
    "kataskeuastiki-etaireia": "Κατασκευαστική εταιρεία",
}


class XeGrSource(PropertySource):
    name = "xe.gr"
    supports_bbox = True

    # ------------------------------------------------------------- querying
    def _params(self, query: SearchQuery, page: int = 1) -> str:
        params = {
            "transaction_name": query.transaction,
            "item_type": query.item_type,
        }
        if query.max_price is not None:
            params["maximum_price"] = int(query.max_price)
        if query.min_price is not None:
            params["minimum_price"] = int(query.min_price)
        if query.max_size is not None:
            params["maximum_size"] = int(query.max_size)
        if query.min_size is not None:
            params["minimum_size"] = int(query.min_size)
        if query.bbox:
            north, east, south, west = query.bbox
            params.update(
                {
                    "geo_lat_from": round(north, 6),
                    "geo_lng_from": round(east, 6),
                    "geo_lat_to": round(south, 6),
                    "geo_lng_to": round(west, 6),
                }
            )
        if query.sorting:
            if query.sorting not in SORTINGS:
                raise ValueError(f"unknown sorting {query.sorting!r}")
            params["sorting"] = query.sorting
        if page > 1:
            params["page"] = page
        params.update(query.extra)
        return RESULTS_URL + "?" + urllib.parse.urlencode(params)

    def _payload(self, query: SearchQuery, page: int = 1) -> dict:
        return self.fetcher.get_json_attribute(self._params(query, page), "data-json-data")

    def count(self, query: SearchQuery) -> int:
        try:
            payload = self._payload(query, 1)
        except FetchError:
            return 0
        return int(payload["selected_values"]["pagination"]["total_results"])

    def search(self, query: SearchQuery) -> Iterator[Listing]:
        page = 1
        total_pages: Optional[int] = None
        seen: set = set()

        while True:
            try:
                payload = self._payload(query, page)
            except FetchError as exc:
                print(f"  ! page {page} unavailable ({exc}); stopping this query")
                return

            pagination = payload["selected_values"]["pagination"]
            if total_pages is None:
                total_pages = int(pagination["total_pages"])
                if query.max_pages:
                    total_pages = min(total_pages, query.max_pages)

            results = payload.get("results") or []
            if not results:
                return

            for raw in results:
                listing = self._to_listing(raw, query)
                if listing and listing.listing_id not in seen:
                    seen.add(listing.listing_id)
                    yield listing

            if page >= total_pages:
                return
            page += 1

    # ---------------------------------------------------------- translation
    def _to_listing(self, raw: dict, query: SearchQuery) -> Optional[Listing]:
        listing_id = raw.get("www_id") or raw.get("id")
        if not listing_id:
            return None

        price = parse_money(raw.get("price"))
        size = parse_area(raw.get("size_with_square_meter"))
        price_per_sqm = raw.get("price_per_unit_area")
        if price_per_sqm is None:
            price_per_sqm = parse_money(raw.get("price_per_square_meter"))

        address = raw.get("address") or ""
        hint = " ".join(
            str(raw.get(key) or "")
            for key in ("image_alt", "extra_seo_info", "extra_seo_info_property_tile", "title")
        ).strip()

        gallery = raw.get("image_gallery") or []
        image = ""
        if gallery:
            first = gallery[0] or {}
            image = ((first.get("medium") or {}).get("jpeg")) or ""

        return Listing(
            source=self.name,
            listing_id=str(listing_id),
            url=raw.get("url") or "",
            title=raw.get("title") or "",
            address=address,
            area_name=normalise_area(address),
            sub_area=address.strip(),
            item_type=raw.get("item_type") or query.item_type,
            transaction=raw.get("transaction_type") or query.transaction.upper(),
            price=price,
            size_sqm=size,
            price_per_sqm=float(price_per_sqm) if price_per_sqm else None,
            bedrooms=raw.get("bedrooms"),
            bathrooms=raw.get("bathrooms"),
            construction_year=raw.get("construction_year"),
            levels=[str(level) for level in (raw.get("levels") or [])],
            lat=raw.get("geo_lat"),
            lng=raw.get("geo_lng"),
            listed_age_days=parse_age_days(raw.get("date")),
            auction_date=raw.get("auction_date"),
            is_commercial_seller=bool(raw.get("is_commercial")),
            company_title=raw.get("company_title") or "",
            account_id=raw.get("account_id") or "",
            description_hint=hint,
            image=image,
            raw=raw,
        )

    # ------------------------------------------------------------- brokers
    def brokers(self, with_contact_details: bool = False, limit: Optional[int] = None) -> List[Broker]:
        """Read the public professionals directory (Μεσιτικά Γραφεία).

        The index page carries name + profile URL for every professional. Set
        `with_contact_details` to also open each profile for phone/email/address
        - that is one request per broker, so it is off by default.
        """
        body = self.fetcher.get(BROKER_DIRECTORY_URL)

        names = {}
        for url, label in _PROFILE_NAME.findall(body):
            import html as html_module

            names[url] = html_module.unescape(label).strip()

        brokers: List[Broker] = []
        seen: set = set()
        for url, category_slug, slug, profile_id in _PROFILE_LINK.findall(body):
            if profile_id in seen:
                continue
            seen.add(profile_id)
            if not slug:
                # Directory rows with an empty slug are placeholder profiles;
                # their URLs 404. Skipping them saves a wasted request each.
                continue
            name = names.get(url, "").strip()
            if not name or name in {"-", "--", ".", ","}:
                name = ""
            brokers.append(
                Broker(
                    source=self.name,
                    profile_id=profile_id,
                    name=name,
                    category=PROFILE_CATEGORIES.get(category_slug, category_slug),
                    profile_url=url,
                )
            )
            if limit and len(brokers) >= limit:
                break

        if with_contact_details:
            for index, broker in enumerate(brokers, 1):
                print(f"  [{index}/{len(brokers)}] {broker.name or broker.profile_id}", flush=True)
                self.enrich_broker(broker)

        return brokers

    def enrich_broker(self, broker: Broker) -> Broker:
        """Open a professional's profile page and pull contact details.

        Only the e-mail is reliably present in the served HTML. The phone shown
        on the page footer belongs to xe.gr itself, and the agency's own number
        sits behind a JavaScript "Κλήση" button, so it is left blank rather than
        filled with the portal's switchboard.
        """
        try:
            body = self.fetcher.get(broker.profile_url)
        except FetchError as exc:
            print(f"    ! {exc}")
            return broker

        for email in re.findall(r'href="mailto:([^"?]+)"', body):
            email = email.strip()
            if email and not _PORTAL_EMAIL.search(email):
                broker.email = email
                break

        for match in re.finditer(r'href="tel:([^"]+)"', body):
            window = body[max(0, match.start() - 400) : match.start()]
            if "seo-footer" in window:
                continue  # the portal's own contact block
            number = match.group(1).strip()
            if _PORTAL_PHONE.sub("", number.replace(" ", "")):
                broker.phone = number
                break

        if not broker.name:
            title = re.search(r"<title>([^<]*)</title>", body)
            if title:
                broker.name = title.group(1).split("|")[0].strip()

        try:
            import html as html_module
            import json as json_module

            match = re.search(
                r'data-agent-place="(.*?)"(?=\s+[a-zA-Z0-9_:\-\.]+=|\s*/?>)', body, re.S
            )
            if match:
                place = json_module.loads(html_module.unescape(match.group(1)))
                broker.address = place.get("formatted_address") or ""
                broker.lat = place.get("center_geo_lat")
                broker.lng = place.get("center_geo_lng")
        except (ValueError, TypeError):
            pass

        return broker
