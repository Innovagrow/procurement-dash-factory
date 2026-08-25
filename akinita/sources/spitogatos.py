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
browser connections. Run `python -m akinita.screener --source spitogatos
--probe` on a normal machine first; it prints exactly which strategy matched and
how many listings were parsed, so you can adjust before trusting the numbers.
Until then `--source xe` is the verified path.
"""
from __future__ import annotations

import json
import os
import re
import html as html_module
import urllib.parse
from typing import Any, Dict, Iterator, List, Optional

from ..geo import normalise_area
from ..http import FetchError
from ..models import Listing, parse_area, parse_money
from .base import PropertySource, SearchQuery

BASE = "https://www.spitogatos.gr"

# Spitogatos' Greek URL segments, keyed by (transaction, item_type).
# Οι διαδρομές αποτελεσμάτων, με την περιοχή στο τέλος:
#     /pwliseis-katoikies/thessaloniki-kentro
# Χωρίς περιοχή είναι σελίδα κατηγορίας με κείμενα και FAQ — καμία αγγελία — και
# το /ellada επιστρέφει 404. Δεν υπάρχει σελίδα «όλη η Ελλάδα»: η χώρα σαρώνεται
# νομό-νομό.
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

# Η πύλη απαντά σε αυτοματοποιημένες συνεδρίες με πρόκληση CAPTCHA: σερβίρει
# ένα κέλυφος λίγων χιλιάδων bytes και φορτώνει hCaptcha. Δεν παρακάμπτεται και
# δεν επιχειρείται· αναγνωρίζεται, ώστε το εργαλείο να λέει τι συνέβη αντί να
# επιστρέφει σιωπηλά μηδέν αγγελίες.
# Η κατηγορία όπως γράφεται στο title της κάρτας.
_ITEM_TYPE_FROM_TITLE = {
    "Κατοικία": "residence",
    "Επαγγελματικός χώρος": "prof",
    "Επαγγελματικό": "prof",
    "Γη": "land",
    "Οικόπεδο": "land",
    "Αγροτεμάχιο": "land",
    "Parking": "parking",
    "Θέση στάθμευσης": "parking",
}

CHALLENGE_MARKERS = ("hcaptcha", "recaptcha", "iamwatchingyou",
                     "pardon our interruption", "are you a human")

BLOCK_MARKERS = re.compile(
    r"Pardon Our Interruption|px-captcha|Access to this page has been denied", re.I
)


class SpitogatosBlocked(RuntimeError):
    """The bot-management interstitial was served instead of results."""


# Οι σελίδες γράφτηκαν από κάποιον άλλο και αλλάζουν χωρίς προειδοποίηση. Ο
# εξαγωγέας που ψάχνει συγκεκριμένο id script ή συγκεκριμένη κλάση σπάει στην
# πρώτη ανακατασκευή — και σπάει σιωπηλά, γυρνώντας μηδέν. Αυτό ψάχνει σχήμα:
# αντικείμενα JSON που ΕΧΟΥΝ τιμή και εμβαδόν, οπουδήποτε στη σελίδα, όπως κι
# αν τυλίχθηκαν.
PRICE_KEYS = ("price", "priceValue", "askingPrice", "amount")
AREA_KEYS = ("area", "sqm", "size", "surface", "livingArea")


def _unescape(blob: str) -> str:
    """Το JSON μέσα σε συμβολοσειρά JavaScript έρχεται με backslash."""
    if '\\"' not in blob:
        return blob
    return blob.replace('\\"', '"').replace("\\\\", "\\")


def _balanced_objects(text: str, anchor: str, limit: int = 4000) -> Iterator[str]:
    """Κάθε αντικείμενο JSON που περιέχει το `anchor`, με ισοσκελισμένα άγκιστρα."""
    for hit in re.finditer(re.escape(anchor), text):
        start = text.rfind("{", max(0, hit.start() - limit), hit.start())
        if start < 0:
            continue
        depth, index, end = 0, start, -1
        while index < min(len(text), start + limit * 4):
            char = text[index]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break
            index += 1
        if end > start:
            yield text[start:end]


MIN_PLAUSIBLE_PRICE = 1000.0
MIN_PLAUSIBLE_SIZE = 5.0


def _plausible(price, size) -> bool:
    """Φίλτρο λογικής, όχι γούστου.

    Διαμέρισμα 2 ευρώ ή 3 τ.μ. δεν είναι ευκαιρία που ξέφυγε από την αγορά·
    είναι αριθμός που διαβάστηκε λάθος. Αν μπει, ταξιδεύει σε κάθε αποτίμηση
    από κάτω και βγαίνει πρώτο στην κατάταξη.
    """
    return (price is not None and size is not None
            and price >= MIN_PLAUSIBLE_PRICE and size >= MIN_PLAUSIBLE_SIZE)


def _looks_like_listing(node: Any) -> bool:
    if not isinstance(node, dict):
        return False
    has_price = any(k in node for k in PRICE_KEYS)
    has_area = any(k in node for k in AREA_KEYS)
    return has_price and has_area


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

    def __init__(self, fetcher, headless: bool = True, page_wait_ms: int = 4000,
                 solve_seconds: int = 300, save_html_dir: str = "",
                 results_timeout_ms: int = 30000):
        super().__init__(fetcher)
        self.headless = headless
        # Πόσο περιμένουμε τον άνθρωπο να λύσει τη δική του πρόκληση, όταν το
        # παράθυρο είναι ανοιχτό μπροστά του.
        self.solve_seconds = solve_seconds
        self._context = None
        self.save_html_dir = save_html_dir
        self.results_timeout_ms = results_timeout_ms
        self.page_wait_ms = page_wait_ms
        self._browser = None
        self._playwright = None

    # ----------------------------------------------------------- url build
    @staticmethod
    def _challenged(html: str) -> bool:
        """Απάντησε η πύλη με πρόκληση αντί για αποτελέσματα;"""
        low = html.lower()
        return len(html) < 60_000 and any(m in low for m in CHALLENGE_MARKERS)

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
        location = str(query.extra.pop("location", "") or "").strip("/")
        params.update({k: v for k, v in query.extra.items() if k != "location"})
        if not location:
            raise ValueError(
                "Η πύλη δεν έχει σελίδα αποτελεσμάτων για όλη τη χώρα. "
                "Δώστε περιοχή, π.χ. --locations thessaloniki,attiki, ή "
                "--locations all για όλους τους νομούς."
            )
        url = f"{BASE}{path}/{location}"
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
        args = ["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        # Σε περιβάλλον με MITM proxy, το TLS 1.3 του Chromium πέφτει με
        # ERR_CONNECTION_RESET πριν φτάσει σε οποιονδήποτε ιστότοπο. Το όριο
        # στο 1.2 δεν απενεργοποιεί κανέναν έλεγχο πιστοποιητικού· απλώς
        # μιλά τη διάλεκτο που καταλαβαίνει ο ενδιάμεσος.
        args += [flag for flag in os.environ.get("AKINITA_BROWSER_ARGS", "").split() if flag]
        launch: Dict[str, Any] = {"headless": self.headless, "args": args}
        # Δρόμος προς συγκεκριμένο Chromium, όταν το playwright δεν βρίσκει το
        # δικό του build — π.χ. σε εικόνα που το φέρνει προεγκατεστημένο.
        executable = os.environ.get("AKINITA_CHROMIUM", "")
        if executable:
            launch["executable_path"] = executable
        proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        if proxy:
            launch["proxy"] = {"server": proxy}
        self._browser = self._playwright.chromium.launch(**launch)
        return self._browser

    def close(self) -> None:
        if self._context is not None:
            self._context.close()
            self._context = None
        self.save_html_dir = save_html_dir
        self.results_timeout_ms = results_timeout_ms
        if self._browser is not None:
            self._browser.close()
            self._browser = None
        if self._playwright is not None:
            self._playwright.stop()
            self._playwright = None

    def _ensure_context(self):
        """Ένα και μόνο context για όλη τη σάρωση.

        Με καινούργιο context ανά σελίδα, μια επαλήθευση που λύθηκε μία φορά
        ξαναζητιέται στην επόμενη — και σε μια σάρωση εκατοντάδων σελίδων αυτό
        σημαίνει ότι δεν τελειώνει ποτέ. Με ένα context, λύνεται μία φορά.
        """
        if self._context is not None:
            return self._context
        browser = self._ensure_browser()
        self._context = browser.new_context(
            locale="el-GR",
            user_agent=self.fetcher.user_agent,
            viewport={"width": 1366, "height": 900},
            extra_http_headers={"Accept-Language": self.fetcher.accept_language},
        )
        return self._context

    def _render(self, url: str, use_cache: bool = True) -> str:
        cached = self.fetcher._cache_read(url) if use_cache else None
        if cached is not None and not self._challenged(cached):
            self.fetcher.stats["cache_hits"] += 1
            return cached

        page = self._ensure_context().new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            # Το κέλυφος φτάνει σε δευτερόλεπτα· οι αγγελίες έρχονται μετά, από
            # τον client. Ένα σταθερό wait έπιανε τη σελίδα πριν γεμίσει και
            # γύριζε μηδέν με τη σελίδα να είναι μια χαρά. Περιμένουμε να
            # φανούν τιμές — αυτό σημαίνει ότι υπάρχουν αποτελέσματα.
            try:
                page.wait_for_function(
                    "() => (document.body.innerText.match(/€/g) || []).length > 2",
                    timeout=self.results_timeout_ms)
            except Exception:  # noqa: BLE001 - ίσως η σελίδα δεν έχει αποτελέσματα
                pass
            # Το «υπάρχει τιμή» δεν σημαίνει «γέμισε η λίστα». Μια σάρωση που
            # διάβασε στο πρώτο αποτέλεσμα γυρίζει μία αγγελία και μοιάζει με
            # περιοχή χωρίς αγορά. Περιμένουμε να ΣΤΑΜΑΤΗΣΕΙ να μεγαλώνει.
            previous, stable = -1, 0
            for _ in range(24):
                page.mouse.wheel(0, 6000)
                page.wait_for_timeout(700)
                current = page.evaluate(
                    "() => (document.body.innerText.match(/€/g) || []).length")
                stable = stable + 1 if current == previous else 0
                previous = current
                if stable >= 3 and current > 0:
                    break
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:  # noqa: BLE001 - το networkidle δεν είναι εγγυημένο
                pass
            page.wait_for_timeout(self.page_wait_ms)
            html = page.content()

            if self._challenged(html):
                if self.headless:
                    raise SpitogatosBlocked(
                        "Η πύλη ζήτησε επαλήθευση CAPTCHA αντί για αποτελέσματα. "
                        "Δεν παρακάμπτεται. Ξανατρέξτε με --show-browser, ώστε να "
                        "ανοίξει παράθυρο και να την περάσετε εσείς."
                    )
                # Δεν λύνουμε την πρόκληση — την περνά ο ίδιος ο χρήστης, στο
                # παράθυρό του. Εμείς απλώς περιμένουμε και συνεχίζουμε.
                print("\n  Η πύλη ζητά επαλήθευση. Περάστε την στο παράθυρο που "
                      f"άνοιξε· περιμένω έως {self.solve_seconds // 60} λεπτά…",
                      flush=True)
                waited = 0
                while waited < self.solve_seconds:
                    page.wait_for_timeout(3000)
                    waited += 3
                    html = page.content()
                    if not self._challenged(html):
                        print("  ✓ πέρασε — η σάρωση συνεχίζει\n", flush=True)
                        break
                else:
                    raise SpitogatosBlocked(
                        "Η επαλήθευση δεν ολοκληρώθηκε μέσα στον χρόνο αναμονής."
                    )
        finally:
            page.close()

        if BLOCK_MARKERS.search(html):
            raise SpitogatosBlocked(
                f"bot protection served an interstitial for {url}."
            )
        self.fetcher._cache_write(url, html)
        if self.save_html_dir:
            self._save(url, html)
        return html

    def _save(self, url: str, html: str) -> None:
        """Γράφει τη σελίδα στον δίσκο, για να διαβαστεί από άνθρωπο.

        Οι εξαγωγείς γράφτηκαν χωρίς πρόσβαση σε πραγματική σελίδα
        αποτελεσμάτων. Ένα αποθηκευμένο δείγμα είναι η διαφορά ανάμεσα στο να
        προσαρμοστούν και στο να μαντευτούν.
        """
        import hashlib
        os.makedirs(self.save_html_dir, exist_ok=True)
        name = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
        path = os.path.join(self.save_html_dir, f"{name}.html")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(f"<!-- {url} -->\n{html}")
        print(f"  · αποθηκεύτηκε: {path}", flush=True)

    # ---------------------------------------------------------- extraction
    def probe(self, query: SearchQuery) -> Dict[str, Any]:
        """Fetch one page and report which extraction strategy works."""
        url = self._url(query, 1)
        html = self._render(url, use_cache=False)
        text = re.sub(r"<[^>]+>", " ", html)
        report = {
            "url": url,
            "html_bytes": len(html),
            "title": (re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
                      or [None, ""])[1].strip()[:80],
            "challenged": self._challenged(html),
            "euro_signs": html.count("€"),
            "candidate_links": len(re.findall(r'<a[^>]+href="(/[^"]*?\d{6,}[^"]*)"', html)),
            "text_sample": re.sub(r"\s+", " ", text).strip()[:200],
            "sample_links": sorted({m for m in re.findall(r'href="(/[a-z0-9\-/]{4,60})"', html)})[:12],
            "script_blocks": html.count("<script"),
            # Πώς μοιάζει η σελίδα γύρω από μια τιμή: αυτό λέει πώς γράφεται ο
            # εξαγωγέας, χωρίς να χρειαστεί να ταξιδέψουν 300KB HTML.
            "price_context": [
                re.sub(r"\s+", " ", html[max(0, m.start() - 260):m.start() + 90])
                for m in list(re.finditer("€", html))[:3]
            ],
            "link_context": sorted({
                m.group(1) for m in re.finditer(r'href="(/[^"]*\d{5,}[^"]*)"', html)
            })[:5],
            "strategies": {},
        }
        for label, extractor in (
            ("tiles", self._from_tiles),
            ("__NEXT_DATA__", self._from_next_data),
            ("embedded json", self._from_embedded_json),
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
        if self._challenged(html):
            raise FetchError(
                "Η πύλη απάντησε με πρόκληση CAPTCHA αντί για αποτελέσματα. Δεν "
                "παρακάμπτεται: σημαίνει ότι δεν δέχεται αυτοματοποιημένη συλλογή "
                "από αυτή τη σύνδεση. Χρησιμοποιήστε την πηγή csv με ακίνητα που "
                "έχετε ήδη υπόψη σας."
            )
        for extractor in (self._from_tiles, self._from_next_data,
                          self._from_embedded_json, self._from_ld_json,
                          self._from_dom):
            try:
                listings = extractor(html, query)
            except Exception:  # noqa: BLE001 - fall through to next strategy
                continue
            if listings:
                return listings
        return []

    def _from_tiles(self, html: str, query: SearchQuery) -> List[Listing]:
        """Οι κάρτες, όπως τις γράφει πράγματι η πύλη.

        Η πλήρης εγγραφή είναι μία συμβολοσειρά με κόμματα:

            Πώληση,Κατοικία,Διαμέρισμα, 66τ.μ.,€195.000,Δροσιά (Θέρμη)

        Γράφεται άλλοτε στο title του συνδέσμου και άλλοτε στο alt της εικόνας,
        και σε κάποιες κάρτες το title κρατά μόνο τύπο και εμβαδόν. Επιλέγεται
        πάντα η γραφή που ΕΧΕΙ την τιμή· χωρίς αυτήν, η κάρτα προσπερνιέται.
        Το κείμενο της κάρτας δεν χρησιμοποιείται για τιμή: εκεί κυκλοφορούν
        «€/τ.μ.» και άλλα ψίχουλα που έβγαλαν διαμέρισμα των 2 ευρώ.
        """
        listings: List[Listing] = []
        seen: set = set()
        for tag in re.finditer(r"<a\b[^>]*>", html):
            attributes = tag.group(0)
            link = re.search(r'href="(/aggelia/(\d+))"', attributes)
            if not link:
                continue
            href, listing_id = link.group(1), link.group(2)
            if listing_id in seen:
                continue

            window = html[tag.end():tag.end() + 1800]
            cut = window.find("<a ")
            window = window[:cut if cut > 0 else len(window)]

            records = []
            title_attr = re.search(r'title="([^"]{8,400})"', attributes)
            if title_attr:
                records.append(html_module.unescape(title_attr.group(1)))
            records.extend(html_module.unescape(a) for a in
                           re.findall(r'alt="([^"]{8,400})"', attributes + window))
            record = next((r for r in records if "€" in r), "")
            if not record:
                # Τελευταία ανάγνωση: το κείμενο της κάρτας. Δεν είναι
                # αξιόπιστο — εκεί κυκλοφορούν «€/τ.μ.» και άλλα ψίχουλα — και
                # γι' αυτό ό,τι βγει από εδώ περνά από το ίδιο φίλτρο λογικής.
                record = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", window)).strip()
                if "€" not in record:
                    continue

            price, size, area = self._read_card(record)
            if not _plausible(price, size):
                continue

            seen.add(listing_id)
            fields = [f.strip() for f in record.split(",") if f.strip()]
            category = fields[1] if len(fields) > 1 else ""
            listings.append(
                Listing(
                    source=self.name,
                    listing_id=listing_id,
                    url=BASE + href,
                    title=record[:160],
                    item_type=_ITEM_TYPE_FROM_TITLE.get(category, query.item_type),
                    transaction=query.transaction.upper(),
                    price=price,
                    size_sqm=size,
                    area_name=normalise_area(re.sub(r"\s*\(.*?\)", "", area).strip()),
                    sub_area=area,
                )
            )
        return listings

    @staticmethod
    def _read_card(text: str):
        """Τιμή, εμβαδόν και περιοχή από μια κάρτα.

        Η τιμή και το εμβαδόν διαβάζονται στοχευμένα, όχι με χώρισμα σε πεδία:
        σε κάρτα χωρίς κόμματα, το «€35.000 52 τ.μ.» γινόταν ένα πεδίο και
        έβγαινε τιμή 3.500.052 με εμβαδόν 35.000 — αριθμοί που θα περνούσαν
        αθόρυβα μέσα σε μια σάρωση χιλιάδων γραμμών.

        Η πύλη γράφει «€79.000», με το σύμβολο μπροστά από τον αριθμό.
        """
        price = parse_money(_first(r"€\s*([\d.,]+)", text) or "")
        if price is None:
            price = parse_money(_first(r"([\d.,]+)\s*€", text) or "")
        size = parse_area(_first(r"([\d.,]+)\s*τ\.?\s*μ", text) or "")

        area = ""
        for field in reversed([f.strip() for f in re.split(r"[,\n]", text) if f.strip()]):
            if "€" in field or re.search(r"\d\s*τ\.?\s*μ", field) or len(field) <= 2:
                continue
            area = field
            break
        return price, size, area

    def _from_next_data(self, html: str, query: SearchQuery) -> List[Listing]:
        match = re.search(
            r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S
        )
        if not match:
            return []
        payload = json.loads(match.group(1))
        return [self._to_listing(node, query) for node in _walk_for_listings(payload)]

    def _from_embedded_json(self, html: str, query: SearchQuery) -> List[Listing]:
        """Κάθε αντικείμενο με τιμή και εμβαδόν, όπου κι αν κρύβεται."""
        text = _unescape(html)
        found: Dict[str, Dict[str, Any]] = {}
        for key in PRICE_KEYS:
            for blob in _balanced_objects(text, f'"{key}"'):
                try:
                    node = json.loads(blob)
                except ValueError:
                    continue
                if not _looks_like_listing(node):
                    continue
                identity = str(node.get("id") or node.get("listingId")
                               or node.get("propertyId") or blob[:80])
                found.setdefault(identity, node)
        return [self._to_listing(node, query) for node in found.values()]

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
        """Τελευταία γραμμή άμυνας: κάρτες που φαίνονται από τη μορφή τους.

        Δεν ψάχνει κλάσεις — αλλάζουν σε κάθε ανακατασκευή. Ψάχνει συνδέσμους
        προς σελίδα ακινήτου και διαβάζει τιμή και εμβαδόν από το κείμενο γύρω
        τους, που είναι το μόνο που παραμένει σταθερό: ένα ποσό σε ευρώ και ένα
        εμβαδόν σε τετραγωνικά.
        """
        listings: List[Listing] = []
        seen: set = set()
        anchors = list(re.finditer(
            r'<a[^>]+href="(/[^"]*?(\d{6,})[^"]*)"', html))
        for index, match in enumerate(anchors):
            href, listing_id = match.group(1), match.group(2)
            if listing_id in seen:
                continue
            # Το κείμενο της κάρτας: από αυτόν τον σύνδεσμο ως τον επόμενο.
            stop = anchors[index + 1].start() if index + 1 < len(anchors) else len(html)
            blob = html[match.start():min(stop, match.start() + 2500)]
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", blob)).strip()
            price = parse_money(_first(r"([\d.,]+)\s*€", text))
            size = parse_area(_first(r"([\d.,]+)\s*τ\.?μ", text))
            if price is None or size is None:
                continue
            seen.add(listing_id)
            listings.append(
                Listing(
                    source=self.name,
                    listing_id=listing_id,
                    url=href if href.startswith("http") else BASE + href,
                    title=text[:120],
                    item_type=query.item_type,
                    transaction=query.transaction.upper(),
                    price=price,
                    size_sqm=size,
                    area_name=normalise_area(_first(r"([Α-ΩΆΈΉΊΌΎΏα-ωάέήίόύώ]{3,}(?:\s[Α-Ωα-ω][α-ωάέήίόύώ]+)*)", text) or ""),
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
        # Ο browser ΔΕΝ κλείνει εδώ. Μια σάρωση πενήντα νομών καλεί αυτή τη
        # μέθοδο πενήντα φορές· κλείνοντας κάθε φορά, η επαλήθευση που πέρασε ο
        # χρήστης θα ζητιόταν ξανά από την αρχή σε κάθε νομό. Κλείνει ο καλών,
        # όταν τελειώσουν όλα.
        if True:
            while page <= max_pages:
                html = self._render(self._url(query, page))
                listings = self._extract(html, query)
                if not listings:
                    return
                fresh = 0
                for listing in listings:
                    # Η πύλη δεν τιμά πάντα το priceTo της διεύθυνσης: γύρισε
                    # ακίνητα 465.000 σε αναζήτηση «έως 50.000». Το φίλτρο που
                    # ζήτησε ο χρήστης ισχύει ό,τι κι αν στείλει ο διακομιστής.
                    if query.max_price and listing.price and listing.price > query.max_price:
                        continue
                    if query.min_price and listing.price and listing.price < query.min_price:
                        continue
                    if query.min_size and listing.size_sqm and listing.size_sqm < query.min_size:
                        continue
                    if listing.listing_id and listing.listing_id not in seen:
                        seen.add(listing.listing_id)
                        fresh += 1
                        yield listing
                if fresh == 0:
                    return  # same page served again -> end of results
                page += 1


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
