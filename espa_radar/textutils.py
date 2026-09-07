"""Επεξεργασία ελληνικού κειμένου: κανονικοποίηση, ημερομηνίες, ποσά, ποσοστά."""
from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import date, datetime, timezone

# --- Κανονικοποίηση --------------------------------------------------------

_GREEK_TONOS = str.maketrans("άέήίόύώΐΰϊϋΆΈΉΊΌΎΏΪΫ", "αεηιουωιυιυΑΕΗΙΟΥΩΙΥ")
_WS_RE = re.compile(r"\s+")
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def strip_html(value: str | None) -> str:
    if not value:
        return ""
    text = _HTML_TAG_RE.sub(" ", value)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", '"')
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#039;", "'")
    )
    return _WS_RE.sub(" ", text).strip()


def normalize(value: str | None) -> str:
    """Πεζά, χωρίς τόνους, χωρίς διπλά κενά. Για σύγκριση/αναζήτηση."""
    if not value:
        return ""
    text = unicodedata.normalize("NFC", value)
    text = text.translate(_GREEK_TONOS).lower()
    text = text.replace("ς", "σ")
    text = _WS_RE.sub(" ", text)
    return text.strip()


def tokens(value: str | None) -> set[str]:
    return {t for t in re.split(r"[^0-9a-zα-ω]+", normalize(value)) if len(t) > 2}


def similarity(a: str, b: str) -> float:
    """Jaccard πάνω σε tokens — αρκετά καλό για dedupe τίτλων προσκλήσεων."""
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def fingerprint(*parts: str | None) -> str:
    joined = "|".join(normalize(p) for p in parts if p)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:32]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_aware(value: datetime | None) -> datetime | None:
    """Επιστρέφει timezone-aware datetime σε UTC (τα naive θεωρούνται UTC)."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


# --- Ημερομηνίες -----------------------------------------------------------

_GREEK_MONTHS = {
    "ιανουαριου": 1, "ιανουαριος": 1, "ιαν": 1,
    "φεβρουαριου": 2, "φεβρουαριος": 2, "φεβ": 2,
    "μαρτιου": 3, "μαρτιος": 3, "μαρ": 3,
    "απριλιου": 4, "απριλιος": 4, "απρ": 4,
    "μαιου": 5, "μαιος": 5, "μαη": 5,
    "ιουνιου": 6, "ιουνιος": 6, "ιουν": 6,
    "ιουλιου": 7, "ιουλιος": 7, "ιουλ": 7,
    "αυγουστου": 8, "αυγουστος": 8, "αυγ": 8,
    "σεπτεμβριου": 9, "σεπτεμβριος": 9, "σεπ": 9,
    "οκτωβριου": 10, "οκτωβριος": 10, "οκτ": 10,
    "νοεμβριου": 11, "νοεμβριος": 11, "νοε": 11,
    "δεκεμβριου": 12, "δεκεμβριος": 12, "δεκ": 12,
}

_NUMERIC_DATE_RE = re.compile(r"\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b")
_ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_TEXT_DATE_RE = re.compile(r"\b(\d{1,2})\s+([α-ωa-z]+)\s+(\d{4})\b")


def parse_date(value: str | None) -> datetime | None:
    """Αναγνωρίζει 31/12/2026, 2026-12-31, «31 Δεκεμβρίου 2026»."""
    if not value:
        return None
    text = normalize(value)

    m = _ISO_DATE_RE.search(text)
    if m:
        return _safe_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    m = _NUMERIC_DATE_RE.search(text)
    if m:
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if year < 100:
            year += 2000
        return _safe_date(year, month, day)

    m = _TEXT_DATE_RE.search(text)
    if m:
        month = _GREEK_MONTHS.get(m.group(2))
        if month:
            return _safe_date(int(m.group(3)), month, int(m.group(1)))
    return None


def _safe_date(year: int, month: int, day: int) -> datetime | None:
    try:
        return datetime(year, month, day, tzinfo=timezone.utc)
    except ValueError:
        return None


def days_until(value: datetime | None) -> int | None:
    value = as_aware(value)
    if value is None:
        return None
    return (value.date() - utcnow().date()).days


def fmt_date(value: datetime | date | None) -> str:
    if value is None:
        return "—"
    if isinstance(value, datetime):
        value = as_aware(value).date()
    return value.strftime("%d/%m/%Y")


# --- Ποσά & ποσοστά --------------------------------------------------------

_AMOUNT_RE = re.compile(
    r"(\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)\s*"
    r"(εκατομμυρι\w*|εκατ|εκ|δισεκατομμυρι\w*|δισ|χιλιαδ\w*|χιλ|χλ|m|bn|k)?\s*\.?\s*"
    r"(?:€|ευρω|eur)",
    re.IGNORECASE,
)

# Σειρά σημαντική: οι μεγαλύτεροι πρόθεμα-κωδικοί ελέγχονται πρώτοι.
_MULTIPLIERS: tuple[tuple[str, int], ...] = (
    ("δισεκατομμυρι", 1_000_000_000),
    ("δισ", 1_000_000_000),
    ("bn", 1_000_000_000),
    ("εκατομμυρι", 1_000_000),
    ("εκατ", 1_000_000),
    ("εκ", 1_000_000),
    ("m", 1_000_000),
    ("χιλιαδ", 1_000),
    ("χιλ", 1_000),
    ("χλ", 1_000),
    ("k", 1_000),
)


def _to_float(raw: str) -> float | None:
    cleaned = raw.replace(" ", "")
    # Ελληνική μορφή: 1.234.567,89 -> τελεία = χιλιάδες, κόμμα = δεκαδικά.
    if "," in cleaned and "." in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    elif "," in cleaned:
        cleaned = cleaned.replace(",", ".")
    elif cleaned.count(".") > 1 or re.fullmatch(r"\d{1,3}(\.\d{3})+", cleaned):
        cleaned = cleaned.replace(".", "")
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_amounts(value: str | None) -> list[float]:
    """Όλα τα ποσά σε ευρώ που εμφανίζονται στο κείμενο."""
    if not value:
        return []
    results: list[float] = []
    for raw, suffix in _AMOUNT_RE.findall(normalize(value)):
        amount = _to_float(raw)
        if amount is None:
            continue
        if suffix:
            key = normalize(suffix).rstrip(".")
            for prefix, mult in _MULTIPLIERS:
                if key.startswith(prefix):
                    amount *= mult
                    break
        results.append(amount)
    return results


def parse_budget_range(value: str | None) -> tuple[float | None, float | None]:
    """Ελάχιστο/μέγιστο επιλέξιμο προϋπολογισμό από ελεύθερο κείμενο."""
    amounts = [a for a in parse_amounts(value) if a >= 100]
    if not amounts:
        return None, None
    if len(amounts) == 1:
        return amounts[0], amounts[0]
    return min(amounts), max(amounts)


_PERCENT_RE = re.compile(r"(\d{1,3}(?:[.,]\d+)?)\s*%")


def parse_percentages(value: str | None) -> list[float]:
    if not value:
        return []
    out: list[float] = []
    for raw in _PERCENT_RE.findall(value):
        try:
            pct = float(raw.replace(",", "."))
        except ValueError:
            continue
        if 0 < pct <= 100:
            out.append(pct)
    return out


def parse_subsidy_rate(value: str | None) -> float | None:
    """Το μέγιστο ποσοστό επιδότησης που αναφέρεται στο κείμενο."""
    pcts = parse_percentages(value)
    return max(pcts) if pcts else None


def fmt_money(value: float | None) -> str:
    if value is None:
        return "—"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}".rstrip("0").rstrip(".") + " εκατ. €"
    if value >= 1_000:
        return f"{value / 1_000:.0f} χιλ. €"
    return f"{value:,.0f} €".replace(",", ".")


def truncate(value: str | None, length: int = 280) -> str:
    text = strip_html(value)
    if len(text) <= length:
        return text
    return text[: length - 1].rsplit(" ", 1)[0] + "…"


# --- Κανονικοποίηση URL ------------------------------------------------------

_TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "ref", "source", "_ga",
}


def canonical_url(url: str | None) -> str:
    """Σταθερή μορφή URL, ώστε το ίδιο πρόγραμμα να μη μπει δύο φορές.

    Πέφτουν τα tracking params και το «www.», μένουν τα ουσιαστικά query
    params (π.χ. `?calls=slug`, που σε WordPress είναι η ταυτότητα της σελίδας).
    """
    if not url:
        return ""
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip().lower()

    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]

    path = parts.path.rstrip("/") or "/"

    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=False)
            if k.lower() not in _TRACKING_PARAMS]
    query = urlencode(sorted(kept))

    return urlunsplit(("https", host, path, query, ""))
