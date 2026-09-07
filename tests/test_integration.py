"""Ολοκληρωμένοι έλεγχοι: API, κανάλια ειδοποίησης, scheduler, parsers πηγών.

Τρέχουν χωρίς εξωτερικό δίκτυο — σηκώνονται τοπικοί mock servers.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import time
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_TMP = Path(tempfile.mkdtemp(prefix="espa-integration-"))
os.environ["ESPA_DATABASE_URL"] = f"sqlite:///{_TMP / 'it.db'}"
os.environ["ESPA_SCHEDULER_ENABLED"] = "false"
os.environ["ESPA_NOTIFY_CHANNELS"] = "console"
os.environ["ESPA_POLITENESS_DELAY"] = "0"
os.environ["ESPA_HTTP_RETRIES"] = "0"
os.environ["ESPA_SOURCES_FILE"] = str(_TMP / "sources.yml")

FAILURES: list[str] = []


def check(condition: bool, label: str, detail: str = "") -> None:
    if condition:
        print(f"  ✓ {label}")
    else:
        print(f"  ✗ {label}" + (f" — {detail}" if detail else ""))
        FAILURES.append(label)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


# ==================================================================
# Mock HTTP server: σερβίρει fixtures και καταγράφει POSTs
# ==================================================================

RECEIVED: list[dict] = []
ROUTES: dict[str, tuple[int, str, bytes]] = {}


class MockHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # σιωπηλό
        pass

    def _respond(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = ROUTES.get(self.path.split("?")[0])
        if route is None:
            self._respond(404, "text/plain", b"not found")
            return
        status, content_type, body = route
        self._respond(status, content_type, body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        RECEIVED.append({
            "path": self.path,
            "headers": dict(self.headers),
            "body": raw.decode("utf-8", errors="replace"),
        })
        self._respond(200, "application/json", b'{"ok":true}')


def start_mock_server() -> tuple[HTTPServer, str]:
    port = free_port()
    server = HTTPServer(("127.0.0.1", port), MockHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{port}"


# ==================================================================
# Fixtures
# ==================================================================

RSS_FIXTURE = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Δοκιμαστικό Feed</title>
  <item>
    <title>Δράση «Ψηφιακός Μετασχηματισμός ΜμΕ»</title>
    <link>https://example.gr/programs/psifiakos</link>
    <description>Επιχορήγηση 50% για μικρομεσαίες επιχειρήσεις στην Κρήτη.
      Επιλέξιμος προϋπολογισμός ανά επενδυτικό σχέδιο από 18.000 € έως 30.000 €.
      Καταληκτική ημερομηνία υποβολής: 30/11/2027.</description>
    <pubDate>Mon, 12 Jan 2026 10:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Πρόγραμμα Εξοικονομώ για Επιχειρήσεις</title>
    <link>https://example.gr/programs/eksoikonomo</link>
    <description>Ενεργειακή αναβάθμιση. Ένταση ενίσχυσης 65%. Λήξη 15/06/2027.</description>
    <pubDate>Tue, 03 Feb 2026 10:00:00 +0000</pubDate>
  </item>
</channel></rss>
"""

HTML_FIXTURE = """<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div class="listing">
  <div class="call">
    <h3><a href="/calls/1">Ενίσχυση Τουριστικών Επιχειρήσεων Νοτίου Αιγαίου</a></h3>
    <p class="excerpt">Επιχορήγηση έως 70% για ξενοδοχεία.</p>
    <span class="meta">Καταληκτική ημερομηνία: 20/10/2027</span>
  </div>
  <div class="call">
    <h3><a href="/calls/2">Πρόγραμμα Έρευνας &amp; Καινοτομίας</a></h3>
    <p class="excerpt">Για ερευνητικούς φορείς και πανεπιστήμια.</p>
    <span class="meta">Λήξη υποβολής: 01/12/2027</span>
  </div>
</div></body></html>
"""

JSON_FIXTURE = json.dumps({
    "data": {"items": [
        {
            "id": 101,
            "heading": {"text": "Δράση Εξωστρέφειας για Εξαγωγικές ΜμΕ"},
            "permalink": "https://example.gr/json/101",
            "abstract": "Ενίσχυση εξαγωγών. Ποσοστό επιχορήγησης 60%.",
            "publishedEpoch": 1767225600000,
            "closesEpoch": 1830384000000,
        },
        {
            "id": 102,
            "heading": {"text": "Πρόγραμμα Αγροδιατροφής Κρήτης"},
            "permalink": "https://example.gr/json/102",
            "abstract": "Μεταποίηση αγροτικών προϊόντων.",
            "publishedEpoch": 1767830400000,
            "closesEpoch": None,
        },
    ]}
}, ensure_ascii=False)

# Ελληνικό site που σερβίρει windows-1253 χωρίς σωστό charset στα headers.
HTML_1253 = HTML_FIXTURE.replace('<meta charset="utf-8">', "").encode("windows-1253")


def write_sources_yaml(base_url: str) -> None:
    (_TMP / "sources.yml").write_text(f"""
sources:
  - id: mock_rss
    name: Mock RSS
    type: rss
    url: {base_url}/feed.xml

  - id: mock_html
    name: Mock HTML
    type: html
    url: {base_url}/list.html
    item: ".call"
    title: "h3 a"
    summary: ".excerpt"
    meta: ".meta"

  - id: mock_html_1253
    name: Mock HTML windows-1253
    type: html
    url: {base_url}/list-1253.html
    item: ".call"
    title: "h3 a"
    summary: ".excerpt"
    meta: ".meta"

  - id: mock_json
    name: Mock JSON
    type: json
    url: {base_url}/api.json
    items_path: data.items
    date_format: epoch_ms
    fields:
      title: heading.text
      url: permalink
      summary: abstract
      id: id
      published: publishedEpoch
      deadline: closesEpoch

  - id: mock_broken
    name: Mock Broken
    type: html
    url: {base_url}/missing.html
    item: ".nothing-here"

  - id: mock_filtered
    name: Mock Filtered
    type: rss
    url: {base_url}/feed.xml
    must_match:
      - ψηφιακός
    must_not_match:
      - εξοικονομώ
""", encoding="utf-8")


# ==================================================================
# 1. Parsers πηγών
# ==================================================================

def test_source_parsers(base_url: str) -> None:
    print("\n[1. Parsers πηγών]")
    from espa_radar.pipeline import enrich
    from espa_radar.sources import build_sources

    by_id = {s.source_id: s for s in build_sources()}
    check(len(by_id) == 6, f"φορτώθηκαν 6 πηγές (βρέθηκαν {len(by_id)})")

    # --- RSS
    rss = by_id["mock_rss"].fetch()
    check(len(rss) == 2, f"RSS: 2 εγγραφές ({len(rss)})")
    first = next((r for r in rss if "Ψηφιακός" in r.title), None)
    check(first is not None, "RSS: σωστός τίτλος")
    if first:
        data = enrich(first)
        check(data["deadline"] and data["deadline"].strftime("%d/%m/%Y") == "30/11/2027",
              "RSS: καταληκτική ημερομηνία", str(data["deadline"]))
        check(data["subsidy_rate"] == 50.0, "RSS: ένταση ενίσχυσης", str(data["subsidy_rate"]))
        check((data["budget_min"], data["budget_max"]) == (18000.0, 30000.0),
              "RSS: εύρος προϋπολογισμού", f"{data['budget_min']}-{data['budget_max']}")
        check("Κρήτη" in data["regions"], "RSS: περιφέρεια", str(data["regions"]))
        check("ΜμΕ" in data["beneficiaries"], "RSS: δικαιούχοι", str(data["beneficiaries"]))
        check(data["status"] == "OPEN", "RSS: κατάσταση OPEN", data["status"])
        check(data["published_at"] is not None, "RSS: ημερομηνία δημοσίευσης")

    # --- HTML
    html = by_id["mock_html"].fetch()
    check(len(html) == 2, f"HTML: 2 εγγραφές ({len(html)})")
    tourism = next((r for r in html if "Τουριστικών" in r.title), None)
    check(tourism is not None, "HTML: τίτλος από selector")
    if tourism:
        check(tourism.url.endswith("/calls/1"), "HTML: απόλυτο URL", tourism.url)
        data = enrich(tourism)
        check(data["deadline"] and data["deadline"].strftime("%d/%m/%Y") == "20/10/2027",
              "HTML: ημερομηνία από meta", str(data["deadline"]))
        check("Τουρισμός" in data["sectors"], "HTML: κλάδος", str(data["sectors"]))

    # --- HTML σε windows-1253
    legacy = by_id["mock_html_1253"].fetch()
    check(len(legacy) == 2, f"windows-1253: 2 εγγραφές ({len(legacy)})")
    if legacy:
        titles = " ".join(r.title for r in legacy)
        check("Τουριστικών" in titles, "windows-1253: σωστή αποκωδικοποίηση ελληνικών", titles[:60])

    # --- JSON
    js = by_id["mock_json"].fetch()
    check(len(js) == 2, f"JSON: 2 εγγραφές ({len(js)})")
    export = next((r for r in js if "Εξωστρέφειας" in r.title), None)
    check(export is not None, "JSON: dotted path τίτλου (heading.text)")
    if export:
        check(export.published_at is not None, "JSON: epoch-ms ημερομηνία δημοσίευσης")
        check(export.deadline is not None, "JSON: epoch-ms προθεσμία")
        data = enrich(export)
        check(data["subsidy_rate"] == 60.0, "JSON: ένταση ενίσχυσης", str(data["subsidy_rate"]))

    # --- Σπασμένη πηγή
    try:
        by_id["mock_broken"].fetch()
        check(False, "σπασμένη πηγή πετά SourceError")
    except Exception as exc:  # noqa: BLE001
        check(type(exc).__name__ == "SourceError", "σπασμένη πηγή πετά SourceError", type(exc).__name__)

    # --- Φίλτρα συνάφειας
    source = by_id["mock_filtered"]
    filtered = source.apply_filters(source.fetch())
    check(len(filtered) == 1 and "Ψηφιακός" in filtered[0].title,
          "must_match/must_not_match φιλτράρουν σωστά", f"{len(filtered)} εγγραφές")


# ==================================================================
# 2. Πλήρες scan με σπασμένη πηγή
# ==================================================================

def test_full_scan() -> None:
    print("\n[2. Πλήρες scan]")
    from espa_radar.db import session_scope
    from espa_radar.models import Program, SourceRun
    from espa_radar.pipeline import scan

    report = scan(notify_matches=False)
    check(report.sources_ok == 5, f"5 πηγές OK ({report.sources_ok})")
    check(report.sources_failed == 1, f"1 πηγή απέτυχε ({report.sources_failed})")
    check(report.new > 0, f"δημιουργήθηκαν προγράμματα ({report.new})")

    with session_scope() as session:
        programs = session.query(Program).all()
        urls = [p.url for p in programs]
        check(len(urls) == len(set(urls)), "κανένα διπλό URL")
        titles = [p.title for p in programs]
        check(len(titles) == len(set(titles)), "κανένας διπλός τίτλος")
        # Το ίδιο feed διαβάζεται από δύο πηγές (mock_rss + mock_filtered).
        multi = [p for p in programs if (p.raw or {}).get("also_seen_in")]
        check(len(multi) >= 1, f"καταγράφηκε πηγή-διπλότυπο ({len(multi)})")

        runs = session.query(SourceRun).all()
        check(len(runs) == 6, f"καταγράφηκαν 6 source runs ({len(runs)})")
        failed = [r for r in runs if not r.ok]
        check(len(failed) == 1 and failed[0].error, "η αποτυχία κατέγραψε μήνυμα σφάλματος")

    # Δεύτερο scan: idempotent
    second = scan(notify_matches=False)
    check(second.new == 0, f"δεύτερο scan δεν δημιουργεί νέα ({second.new})")


# ==================================================================
# 3. Κανάλια ειδοποίησης (πραγματικά, σε mock servers)
# ==================================================================

def test_webhook_notifier(base_url: str) -> None:
    print("\n[3. Κανάλι: Webhook]")
    from espa_radar.config import settings
    from espa_radar.notifiers.base import Notification
    from espa_radar.notifiers.webhook import WebhookNotifier

    RECEIVED.clear()
    settings.webhook_url = f"{base_url}/hook"
    settings.webhook_secret = "μυστικό-κλειδί"

    notifier = WebhookNotifier()
    check(notifier.is_configured(), "webhook: ρυθμισμένο")
    notifier.send(Notification(
        kind="instant", subject="Δοκιμή", text="Κείμενο δοκιμής",
        dedupe_key="k1", data={"score": 88},
    ))

    check(len(RECEIVED) == 1, f"webhook: παραλήφθηκε αίτημα ({len(RECEIVED)})")
    if RECEIVED:
        request = RECEIVED[0]
        body = json.loads(request["body"])
        check(body["subject"] == "Δοκιμή", "webhook: σωστό subject")
        check(body["data"]["score"] == 88, "webhook: σωστά data")
        signature = request["headers"].get("X-Espa-Signature", "")
        check(signature.startswith("sha256="), "webhook: υπάρχει HMAC υπογραφή", signature[:20])

        import hashlib
        import hmac
        expected = hmac.new(
            "μυστικό-κλειδί".encode("utf-8"),
            request["body"].encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        check(signature == f"sha256={expected}", "webhook: η υπογραφή επαληθεύεται")

    settings.webhook_secret = ""
    settings.webhook_url = ""


def test_telegram_notifier(base_url: str) -> None:
    print("\n[4. Κανάλι: Telegram]")
    from espa_radar.config import settings
    from espa_radar.notifiers import telegram as telegram_module
    from espa_radar.notifiers.base import Notification

    RECEIVED.clear()
    settings.telegram_bot_token = "TESTTOKEN"
    settings.telegram_chat_id = "42"

    notifier = telegram_module.TelegramNotifier()
    check(notifier.is_configured(), "telegram: ρυθμισμένο")

    original_send = telegram_module.request
    calls: list[str] = []

    def patched(method, url, **kwargs):
        calls.append(url)
        return original_send(method, f"{base_url}/telegram", **kwargs)

    telegram_module.request = patched
    try:
        notifier.send(Notification(kind="instant", subject="Τίτλος *με* αστερίσκο",
                                   text="Σώμα μηνύματος", dedupe_key="k2"))
    finally:
        telegram_module.request = original_send

    check(len(RECEIVED) == 1, f"telegram: στάλθηκε μήνυμα ({len(RECEIVED)})")
    check(any("TESTTOKEN" in c for c in calls), "telegram: το token μπαίνει στο URL")
    if RECEIVED:
        body = json.loads(RECEIVED[0]["body"])
        check(body["chat_id"] == "42", "telegram: σωστό chat_id")
        check("∗" in body["text"], "telegram: escaping ειδικών χαρακτήρων Markdown")

    # Μεγάλο μήνυμα -> κομμάτια
    RECEIVED.clear()
    telegram_module.request = patched
    try:
        notifier.send(Notification(kind="digest", subject="Μεγάλο",
                                   text="γραμμή\n" * 3000, dedupe_key="k3"))
    finally:
        telegram_module.request = original_send
    check(len(RECEIVED) > 1, f"telegram: μεγάλο μήνυμα σπάει σε κομμάτια ({len(RECEIVED)})")
    check(all(len(json.loads(r["body"])["text"]) <= 4000 for r in RECEIVED),
          "telegram: κάθε κομμάτι εντός ορίου")

    settings.telegram_bot_token = ""
    settings.telegram_chat_id = ""


def test_email_notifier() -> None:
    print("\n[5. Κανάλι: Email (SMTP)]")
    import asyncio

    try:
        from aiosmtpd.controller import Controller
    except ImportError:
        print("  ~ παράλειψη SMTP server (λείπει aiosmtpd) — έλεγχος μόνο σύνθεσης")
        _test_email_composition()
        return

    received: list[bytes] = []

    class Sink:
        async def handle_DATA(self, server, session, envelope):
            received.append(envelope.content)
            return "250 OK"

    port = free_port()
    controller = Controller(Sink(), hostname="127.0.0.1", port=port)
    controller.start()
    try:
        from espa_radar.config import settings
        from espa_radar.notifiers.base import Notification
        from espa_radar.notifiers.email_smtp import EmailNotifier

        settings.smtp_host = "127.0.0.1"
        settings.smtp_port = port
        settings.smtp_starttls = False
        settings.smtp_user = ""
        settings.smtp_password = ""
        settings.smtp_from = "radar@example.gr"

        notifier = EmailNotifier()
        check(notifier.is_configured(), "email: ρυθμισμένο")
        notifier.send(Notification(
            kind="instant", subject="Νέα ευκαιρία χρηματοδότησης",
            text="Απλό κείμενο", html="<p>HTML έκδοση</p>",
            email="user@example.gr", dedupe_key="k4",
        ))

        check(len(received) == 1, f"email: παραλήφθηκε ({len(received)})")
        if received:
            raw = received[0].decode("utf-8", errors="replace")
            check("user@example.gr" in raw, "email: σωστός παραλήπτης")
            check("radar@example.gr" in raw, "email: σωστός αποστολέας")
            check("HTML" in raw or "html" in raw, "email: περιέχει HTML εναλλακτική")
    finally:
        controller.stop()
        from espa_radar.config import settings as s
        s.smtp_host = ""


def _test_email_composition() -> None:
    from espa_radar.config import settings
    from espa_radar.notifiers.base import Notification
    from espa_radar.notifiers.email_smtp import EmailNotifier

    settings.smtp_host = ""
    notifier = EmailNotifier()
    check(not notifier.is_configured(), "email: μη ρυθμισμένο εντοπίζεται")
    try:
        notifier.send(Notification(kind="instant", subject="x", text="y", email="a@b.gr"))
        check(False, "email: μη ρυθμισμένο πετά σφάλμα")
    except RuntimeError:
        check(True, "email: μη ρυθμισμένο πετά σφάλμα")


def test_notifier_routing(base_url: str) -> None:
    print("\n[6. Δρομολόγηση & idempotency ειδοποιήσεων]")
    from espa_radar.config import settings
    from espa_radar.db import session_scope
    from espa_radar.models import NotificationLog
    from espa_radar.notifiers import notify
    from espa_radar.notifiers.base import Notification

    RECEIVED.clear()
    settings.webhook_url = f"{base_url}/hook2"

    notification = Notification(kind="instant", subject="Δρομολόγηση", text="κείμενο",
                                dedupe_key="unique-key-1")
    results = notify(notification, ["console", "webhook"])
    check(results.get("console") == "sent" and results.get("webhook") == "sent",
          "στάλθηκε σε δύο κανάλια", str(results.statuses))
    check(len(RECEIVED) == 1, "webhook έλαβε ένα αίτημα")

    # Ίδιο dedupe_key -> δεν ξαναστέλνεται
    repeat = notify(notification, ["console", "webhook"])
    check(len(RECEIVED) == 1, f"idempotency: δεν ξαναστάλθηκε ({len(RECEIVED)})")
    check(repeat.get("webhook") == "skipped", "το διπλότυπο αναφέρεται ως skipped",
          str(repeat.statuses))
    check(not repeat.delivered and repeat.handled,
          "skipped: delivered=False αλλά handled=True")

    # Άγνωστο κανάλι -> fallback σε console, χωρίς crash
    results = notify(Notification(kind="instant", subject="x", text="y", dedupe_key="k-unknown"),
                     ["δεν-υπάρχει"])
    check(results.get("console") == "sent", "άγνωστο κανάλι κάνει fallback σε console",
          str(results.statuses))

    # Κανάλι που αποτυγχάνει -> καταγράφεται, δεν πετά exception
    settings.webhook_url = "http://127.0.0.1:1/nope"
    results = notify(Notification(kind="instant", subject="αποτυχία", text="y",
                                  dedupe_key="k-fail"), ["webhook"])
    check(results.get("webhook") == "failed", "αποτυχία καναλιού αναφέρεται ως failed",
          str(results.statuses))
    check(not results.delivered and not results.handled,
          "failed: ούτε delivered ούτε handled")

    with session_scope() as session:
        failed = session.query(NotificationLog).filter(
            NotificationLog.dedupe_key == "k-fail").first()
        check(failed is not None and not failed.ok and failed.error,
              "η αποτυχία καταγράφηκε με μήνυμα σφάλματος")

    settings.webhook_url = ""


# ==================================================================
# 4. API
# ==================================================================

def test_api_full() -> None:
    print("\n[7. API — πλήρης κάλυψη]")
    from fastapi.testclient import TestClient

    from espa_radar.api import app

    with TestClient(app) as client:
        # --- Δημιουργία προφίλ με πλήρη κριτήρια
        payload = {
            "name": "Πλήρες προφίλ",
            "sectors": ["Ψηφιακός μετασχηματισμός"],
            "regions": ["Κρήτη"],
            "beneficiaries": ["ΜμΕ"],
            "keywords": ["επιχορήγηση", "ψηφιακός"],
            "exclude_keywords": ["αλιεία"],
            "budget_min": 10000,
            "budget_max": 100000,
            "min_subsidy_rate": 30,
            "min_days_left": 5,
            "min_score": 40,
            "notify_channels": ["console"],
            "notify_email": "user@example.gr",
        }
        response = client.post("/api/profiles", json=payload)
        check(response.status_code == 201, f"POST /api/profiles = 201 ({response.status_code})",
              response.text[:200])
        profile = response.json()
        profile_id = profile["id"]
        check(profile["keywords"] == ["επιχορήγηση", "ψηφιακός"], "τα κριτήρια αποθηκεύτηκαν")
        check(profile["min_subsidy_rate"] == 30, "αριθμητικά κριτήρια αποθηκεύτηκαν")

        # --- GET ένα
        response = client.get(f"/api/profiles/{profile_id}")
        check(response.status_code == 200, "GET /api/profiles/{id}")

        # --- PUT
        payload["name"] = "Ενημερωμένο προφίλ"
        payload["min_score"] = 55
        response = client.put(f"/api/profiles/{profile_id}", json=payload)
        check(response.status_code == 200 and response.json()["name"] == "Ενημερωμένο προφίλ",
              f"PUT /api/profiles/{{id}} ({response.status_code})", response.text[:150])
        check(response.json()["min_score"] == 55, "PUT ενημέρωσε το κατώφλι")

        # --- 404
        check(client.get("/api/profiles/999999").status_code == 404, "GET άγνωστο προφίλ = 404")
        check(client.put("/api/profiles/999999", json=payload).status_code == 404,
              "PUT άγνωστο προφίλ = 404")
        check(client.delete("/api/profiles/999999").status_code == 404,
              "DELETE άγνωστο προφίλ = 404")
        check(client.get("/api/programs/999999").status_code == 404, "GET άγνωστο πρόγραμμα = 404")

        # --- Validation
        response = client.post("/api/profiles", json={"name": "x"})
        check(response.status_code == 422, f"πολύ κοντό όνομα = 422 ({response.status_code})")
        response = client.post("/api/profiles", json={"name": "Έγκυρο", "min_subsidy_rate": 150})
        check(response.status_code == 422, f"ποσοστό >100 = 422 ({response.status_code})")

        # --- Προγράμματα & φίλτρα
        response = client.get("/api/programs")
        programs = response.json()
        check(response.status_code == 200 and len(programs) > 0,
              f"GET /api/programs ({len(programs)} εγγραφές)")
        program_id = programs[0]["id"]
        check(client.get(f"/api/programs/{program_id}").status_code == 200,
              "GET /api/programs/{id}")
        check(client.get("/api/programs?status=OPEN").status_code == 200, "φίλτρο status")
        check(client.get("/api/programs?source=mock_rss").status_code == 200, "φίλτρο source")
        check(client.get("/api/programs?q=Ψηφιακός").status_code == 200, "αναζήτηση q")
        check(client.get("/api/programs?limit=1").json().__len__() == 1, "παράμετρος limit")
        check(client.get("/api/programs?limit=9999").status_code == 422, "limit πάνω από το όριο = 422")

        # --- Ταιριάσματα
        client.post("/api/scan", json={"sources": [], "notify": False})
        response = client.get(f"/api/matches?profile_id={profile_id}")
        check(response.status_code == 200, "GET /api/matches με φίλτρο προφίλ")
        matches = response.json()

        if matches:
            match_id = matches[0]["id"]
            check("program" in matches[0] and "reasons" in matches[0],
                  "το ταίριασμα περιέχει πρόγραμμα και αιτιολόγηση")
            response = client.post(f"/api/matches/{match_id}/save")
            check(response.status_code == 200 and response.json()["is_saved"],
                  "POST /api/matches/{id}/save")
            response = client.post(f"/api/matches/{match_id}/dismiss")
            check(response.status_code == 200 and response.json()["is_dismissed"],
                  "POST /api/matches/{id}/dismiss")
            hidden = client.get("/api/matches").json()
            check(all(m["id"] != match_id for m in hidden),
                  "το απορριφθέν ταίριασμα κρύβεται")
            shown = client.get("/api/matches?include_dismissed=true").json()
            check(any(m["id"] == match_id for m in shown),
                  "εμφανίζεται με include_dismissed=true")
        else:
            check(False, "υπάρχουν ταιριάσματα για έλεγχο", "κανένα ταίριασμα")

        check(client.post("/api/matches/999999/save").status_code == 404,
              "save άγνωστο ταίριασμα = 404")

        # --- Λειτουργικά endpoints
        check(client.post("/api/digest").status_code == 200, "POST /api/digest")
        check(client.post("/api/reminders").status_code == 200, "POST /api/reminders")
        response = client.get("/api/notifications")
        check(response.status_code == 200 and isinstance(response.json(), list),
              "GET /api/notifications")
        response = client.get("/api/sources")
        sources = response.json()
        check(any(s["ok"] is False for s in sources), "το /api/sources δείχνει σπασμένη πηγή")
        check(any(s["ok"] is True for s in sources), "το /api/sources δείχνει υγιείς πηγές")

        # --- Dashboard: η σελίδα είναι κέλυφος, τα δεδομένα έρχονται από το API
        response = client.get("/")
        check(response.status_code == 200 and "Ραντάρ Επιδοτήσεων" in response.text,
              "GET / (κέλυφος σελίδας)")

        response = client.get("/api/dashboard")
        check(response.status_code == 200, f"GET /api/dashboard ({response.status_code})")
        payload = response.json()
        check(set(payload) >= {"stats", "sources", "taxonomy", "programs", "scheduler"},
              "το /api/dashboard έχει όλα τα τμήματα", str(sorted(payload)))
        check(payload["stats"]["programs"] > 0, "στατιστικά με δεδομένα")
        check(any(s["name"] == "Mock RSS" for s in payload["sources"]),
              "οι πηγές περιλαμβάνονται")
        check(any(s["ok"] is False for s in payload["sources"]),
              "η σπασμένη πηγή φαίνεται στο dashboard")
        check(len(payload["programs"]) > 0 and "t" in payload["programs"][0],
              "τα προγράμματα έρχονται σε συμπαγή μορφή")
        check(len(payload["taxonomy"]["sectors"]) > 5, "η ταξινομία περιλαμβάνεται")

        # --- Καθαρισμός
        check(client.delete(f"/api/profiles/{profile_id}").status_code == 204, "DELETE προφίλ")
        check(client.get(f"/api/profiles/{profile_id}").status_code == 404,
              "το διαγραμμένο προφίλ δεν υπάρχει")


def test_api_key_auth() -> None:
    print("\n[8. API key]")
    from fastapi.testclient import TestClient

    from espa_radar.api import app
    from espa_radar.config import settings

    settings.api_key = "secret-api-key-123"
    try:
        with TestClient(app) as client:
            response = client.post("/api/profiles", json={"name": "Χωρίς κλειδί"})
            check(response.status_code == 401, f"χωρίς κλειδί = 401 ({response.status_code})")

            response = client.post("/api/profiles", json={"name": "Λάθος κλειδί"},
                                   headers={"X-API-Key": "wrong-key"})
            check(response.status_code == 401, f"λάθος κλειδί = 401 ({response.status_code})")

            response = client.post("/api/profiles", json={"name": "Σωστό κλειδί"},
                                   headers={"X-API-Key": "secret-api-key-123"})
            check(response.status_code == 201, f"σωστό κλειδί = 201 ({response.status_code})",
                  response.text[:150])
            if response.status_code == 201:
                client.delete(f"/api/profiles/{response.json()['id']}",
                              headers={"X-API-Key": "secret-api-key-123"})

            check(client.get("/api/programs").status_code == 200,
                  "τα endpoints ανάγνωσης παραμένουν ανοιχτά")
            check(client.get("/health").status_code == 200, "το /health παραμένει ανοιχτό")
    finally:
        settings.api_key = ""


# ==================================================================
# 5. Scheduler
# ==================================================================

def test_scheduler() -> None:
    print("\n[9. Scheduler]")
    from zoneinfo import ZoneInfo

    from espa_radar import scheduler as scheduler_module
    from espa_radar.config import settings

    settings.scheduler_enabled = True
    settings.scan_on_startup = False
    settings.timezone = "Europe/Athens"
    settings.digest_hour = 8
    settings.digest_minute = 30

    scheduler = scheduler_module.start_scheduler()
    try:
        check(scheduler is not None, "ο scheduler ξεκίνησε")
        jobs = scheduler_module.scheduler_status()
        check(len(jobs) == 4, f"4 προγραμματισμένα jobs ({len(jobs)})")

        by_id = {j["id"]: j for j in jobs}
        check(set(by_id) == {"scan", "digest", "deadlines", "maintenance"},
              "όλα τα αναμενόμενα jobs", str(sorted(by_id)))

        athens = ZoneInfo("Europe/Athens")
        digest_job = next(j for j in scheduler.get_jobs() if j.id == "digest")
        next_run = digest_job.next_run_time.astimezone(athens)
        check((next_run.hour, next_run.minute) == (8, 30),
              f"η σύνοψη τρέχει 08:30 ώρα Ελλάδας ({next_run.hour:02d}:{next_run.minute:02d})")

        deadlines_job = next(j for j in scheduler.get_jobs() if j.id == "deadlines")
        next_deadline = deadlines_job.next_run_time.astimezone(athens)
        check((next_deadline.hour, next_deadline.minute) == (8, 40),
              f"οι υπενθυμίσεις 08:40 ({next_deadline.hour:02d}:{next_deadline.minute:02d})")

        # Διπλή εκκίνηση δεν δημιουργεί δεύτερο scheduler
        again = scheduler_module.start_scheduler()
        check(again is scheduler, "η δεύτερη εκκίνηση επιστρέφει τον ίδιο scheduler")
    finally:
        scheduler_module.stop_scheduler()

    check(scheduler_module.scheduler_status() == [], "ο scheduler σταμάτησε καθαρά")

    # Απενεργοποιημένος
    settings.scheduler_enabled = False
    check(scheduler_module.start_scheduler() is None, "ESPA_SCHEDULER_ENABLED=false τον απενεργοποιεί")

    # Άκυρη ζώνη ώρας δεν ρίχνει την εκκίνηση
    settings.scheduler_enabled = True
    settings.timezone = "Δεν/Υπάρχει"
    invalid = scheduler_module.start_scheduler()
    check(invalid is not None, "άκυρη ζώνη ώρας δεν ρίχνει τον scheduler")
    scheduler_module.stop_scheduler()
    settings.timezone = "Europe/Athens"
    settings.scheduler_enabled = False


def test_scheduler_job_execution() -> None:
    print("\n[10. Εκτέλεση job]")
    from espa_radar import scheduler as scheduler_module

    # Τα jobs δεν πρέπει ποτέ να πετάνε — ένα σφάλμα δεν ρίχνει τον scheduler.
    import espa_radar.pipeline as pipeline_module

    original = pipeline_module.scan

    def exploding(*args, **kwargs):
        raise RuntimeError("σκόπιμη αποτυχία")

    scheduler_module.scan = exploding
    try:
        scheduler_module._job_scan()
        check(True, "το job σάρωσης απορροφά σφάλματα")
    except Exception as exc:  # noqa: BLE001
        check(False, "το job σάρωσης απορροφά σφάλματα", str(exc))
    finally:
        scheduler_module.scan = original

    try:
        scheduler_module._job_digest()
        scheduler_module._job_deadlines()
        scheduler_module._job_maintenance()
        check(True, "τα jobs σύνοψης/προθεσμιών/συντήρησης τρέχουν")
    except Exception as exc:  # noqa: BLE001
        check(False, "τα jobs σύνοψης/προθεσμιών/συντήρησης τρέχουν", str(exc))


# ==================================================================
# 6. Ακραίες περιπτώσεις
# ==================================================================

def test_edge_cases() -> None:
    print("\n[11. Ακραίες περιπτώσεις]")
    from espa_radar import extract, matching, taxonomy, textutils
    from espa_radar.db import session_scope
    from espa_radar.models import Profile, Program
    from espa_radar.pipeline import enrich
    from espa_radar.sources.base import RawProgram

    # Κενά / None παντού
    for value in (None, "", "   ", "\n\n"):
        check(textutils.normalize(value) == "", f"normalize({value!r})")
        check(extract.extract_deadline(value) is None, f"extract_deadline({value!r})")
        check(extract.extract_budgets(value) == (None, None, None), f"extract_budgets({value!r})")
        check(taxonomy.detect_regions(value) == [], f"detect_regions({value!r})")

    # Πρόγραμμα χωρίς τίποτα
    minimal = enrich(RawProgram(source_id="s", source_name="S", title="Τ", url="https://a.gr/x"))
    check(minimal["title"] == "Τ" and minimal["status"] == "UNKNOWN", "εμπλουτισμός ελάχιστης εγγραφής")

    # Πολύ μεγάλα πεδία δεν σπάνε τα όρια στήλης
    huge = enrich(RawProgram(source_id="s", source_name="S", title="Τ" * 2000,
                             url="https://a.gr/" + "y" * 2000, body="κ" * 200000))
    check(len(huge["title"]) <= 600, f"ο τίτλος περικόπτεται ({len(huge['title'])})")
    check(len(huge["url"]) <= 1000, f"το URL περικόπτεται ({len(huge['url'])})")
    check(len(huge["body"]) <= 60000, f"το σώμα περικόπτεται ({len(huge['body'])})")

    # Το κομμένο πρόγραμμα αποθηκεύεται όντως
    from espa_radar.pipeline import upsert_program
    with session_scope() as session:
        program, is_new, _ = upsert_program(session, huge)
        check(is_new and program.id is not None, "η υπερμεγέθης εγγραφή αποθηκεύεται")

    # Προφίλ χωρίς κανένα κριτήριο δέχεται τα πάντα
    with session_scope() as session:
        # Ρητά ανοιχτό πρόγραμμα: το first() χωρίς ORDER BY δίνει αυθαίρετη
        # σειρά και σε Postgres μπορεί να επιστρέψει ληγμένο.
        open_program = (
            session.query(Program).filter(Program.status == "OPEN")
            .order_by(Program.id).first()
        )
        check(open_program is not None, "υπάρχει ανοιχτό πρόγραμμα για έλεγχο")
        empty = Profile(name="Χωρίς κριτήρια")
        result = matching.evaluate(empty, open_program)
        check(result.matched and result.score == 50.0,
              f"κενό προφίλ δέχεται με ουδέτερο σκορ ({result.score})")

        # Μη αποθηκευμένο προφίλ (τα defaults στηλών δεν έχουν εφαρμοστεί):
        # τα None δεν πρέπει να απορρίπτουν σιωπηλά.
        upcoming = Program(fingerprint="f-upcoming", source_id="s", source_name="S",
                           title="Αναμενόμενη δράση", url="https://a.gr/u",
                           status="UPCOMING", content_hash="h", regions=[], sectors=[],
                           beneficiaries=[], aid_types=[], raw={})
        check(matching.evaluate(Profile(name="Αναποθήκευτο"), upcoming).matched,
              "μη αποθηκευμένο προφίλ δέχεται αναμενόμενες προσκλήσεις")

        # Κλειστό πρόγραμμα απορρίπτεται πάντα
        closed = Program(fingerprint="f-closed", source_id="s", source_name="S",
                         title="Έληξε", url="https://a.gr/c", status="CLOSED",
                         content_hash="h", regions=[], sectors=[], beneficiaries=[],
                         aid_types=[], raw={})
        check(not matching.evaluate(empty, closed).matched, "κλειστό πρόγραμμα απορρίπτεται")

    # Κακοσχηματισμένες ημερομηνίες
    check(textutils.parse_date("31/02/2026") is None, "31 Φεβρουαρίου = άκυρη")
    check(textutils.parse_date("99/99/9999") is None, "εντελώς άκυρη ημερομηνία")
    check(textutils.parse_date("λέξεις χωρίς ημερομηνία") is None, "κείμενο χωρίς ημερομηνία")

    # Κακοσχηματισμένα ποσά
    check(textutils.parse_amounts("€€€") == [], "σκέτα σύμβολα ευρώ")
    check(textutils.parse_percentages("120%") == [], "ποσοστό >100 αγνοείται")
    check(textutils.parse_percentages("-5%") == [] or -5 not in textutils.parse_percentages("-5%"),
          "αρνητικό ποσοστό αγνοείται")

    # canonical_url σε σκουπίδια
    check(textutils.canonical_url(None) == "", "canonical_url(None)")
    check(textutils.canonical_url("όχι-url") != "", "canonical_url σε μη-URL δεν σκάει")

    # HTML entities
    check(textutils.strip_html("Πρόγραμμα &#8220;Χ&#8221; &#8211; Α &amp; Β")
          == "Πρόγραμμα “Χ” – Α & Β", "αριθμητικά HTML entities αποκωδικοποιούνται",
          textutils.strip_html("Πρόγραμμα &#8220;Χ&#8221; &#8211; Α &amp; Β"))

    # Τροποποιήσεις πρόσκλησης = ίδιο πρόγραμμα
    amendments = [
        "8η ΤΡΟΠΟΠΟΙΗΣΗ ΠΡΟΣΚΛΗΣΗΣ ΥΠΟΒΟΛΗΣ ΑΙΤΗΣΕΩΝ ΓΙΑ ΤΟ ΠΡΟΓΡΑΜΜΑ ΨΗΦΙΑΚΑ ΕΡΓΑΛΕΙΑ",
        "27η ΤΡΟΠΟΠΟΙΗΣΗ ΠΡΟΣΚΛΗΣΗΣ ΥΠΟΒΟΛΗΣ ΑΙΤΗΣΕΩΝ ΓΙΑ ΤΟ ΠΡΟΓΡΑΜΜΑ ΨΗΦΙΑΚΑ ΕΡΓΑΛΕΙΑ",
        "Τέταρτη (4η) τροποποίηση της Πρόσκλησης υποβολής αιτήσεων για το Πρόγραμμα Ψηφιακά Εργαλεία",
    ]
    stripped = [textutils.strip_amendment_prefix(t) for t in amendments]
    check(all(textutils.similarity(stripped[0], other) >= 0.92 for other in stripped[1:]),
          "οι τροποποιήσεις της ίδιας πρόσκλησης συγχωνεύονται", str(stripped))
    check(stripped[0].startswith("ΠΡΟΣΚΛΗΣΗ "),
          "ο τίτλος επανέρχεται σε ονομαστική χωρίς τόνο σε κεφαλαία", stripped[0][:30])
    check(textutils.strip_amendment_prefix("Πρόσκληση υποβολής αιτήσεων")
          == "Πρόσκληση υποβολής αιτήσεων", "κανονικός τίτλος μένει ανέπαφος")
    check(textutils.strip_amendment_prefix("Τροποποίηση") == "Τροποποίηση",
          "τίτλος μόνο «Τροποποίηση» δεν αδειάζει")
    # Η κατάληξη πρέπει να φεύγει μαζί με το θέμα, αλλιώς μένει «ς, Ολοκλήρωσης…»
    check(textutils.strip_amendment_prefix(
              "Τροποποίησης, Ολοκλήρωσης, Οριστικοποίησης κόστους")
          == "Ολοκλήρωσης, Οριστικοποίησης κόστους",
          "δεν κόβεται στη μέση λέξης (κλιτή κατάληξη)",
          textutils.strip_amendment_prefix("Τροποποίησης, Ολοκλήρωσης, Οριστικοποίησης κόστους"))

    # Το systemd EnvironmentFile δεν κόβει σχόλια στο τέλος γραμμής.
    from espa_radar import config as config_module
    saved = dict(os.environ)
    try:
        os.environ["ESPA_NOTIFY_CHANNELS"] = "email,telegram   # τα κανάλια μου"
        os.environ["ESPA_SCAN_INTERVAL_MINUTES"] = "60     # κάθε ώρα"
        os.environ["ESPA_MIN_SCORE"] = "55   # κατώφλι"
        os.environ["ESPA_SCAN_ON_STARTUP"] = "false  # όχι στην εκκίνηση"
        os.environ["ESPA_SMTP_PASSWORD"] = "p@ss#word#123"
        fresh = config_module.Settings()
        check(fresh.notify_channels == ["email", "telegram"],
              "κανάλια: αγνοείται το inline σχόλιο", str(fresh.notify_channels))
        check(fresh.scan_interval_minutes == 60,
              "αριθμός: αγνοείται το inline σχόλιο", str(fresh.scan_interval_minutes))
        check(fresh.default_min_score == 55.0, "δεκαδικό: αγνοείται το inline σχόλιο")
        check(fresh.scan_on_startup is False, "boolean: αγνοείται το inline σχόλιο")
        check(fresh.smtp_password == "p@ss#word#123",
              "συνθηματικό με # μένει ανέπαφο", fresh.smtp_password)
    finally:
        os.environ.clear()
        os.environ.update(saved)

    # similarity σε κενά
    check(textutils.similarity("", "") == 0.0, "similarity κενών")
    check(textutils.similarity("α", "β") == 0.0, "similarity πολύ κοντών λέξεων")


def test_change_detection_and_reminders() -> None:
    print("\n[12. Μεταβολές & υπενθυμίσεις]")
    from espa_radar.db import session_scope
    from espa_radar.models import Match, Profile, Program, ProgramChange
    from espa_radar.pipeline import (
        close_expired,
        notify_program_changes,
        purge_old_logs,
        run_matching,
        send_deadline_reminders,
        send_digest,
        upsert_program,
    )
    from espa_radar.textutils import utcnow

    base = {
        "source_id": "chg", "source_name": "Μεταβολές", "external_id": "e1",
        "title": "Δράση υπό μεταβολή", "summary": "περίληψη", "body": "σώμα",
        "url": "https://example.gr/change", "status": "OPEN",
        "published_at": utcnow() - timedelta(days=1),
        "opens_at": None, "deadline": utcnow() + timedelta(days=40),
        "budget_total": None, "budget_min": 1000.0, "budget_max": 5000.0,
        "subsidy_rate": 50.0, "regions": [], "sectors": [], "beneficiaries": [],
        "aid_types": [], "raw": {},
    }
    with session_scope() as session:
        program, is_new, _ = upsert_program(session, dict(base))
        program_id = program.id
    check(is_new, "δημιουργήθηκε πρόγραμμα ελέγχου")

    # Παράταση προθεσμίας + αλλαγή ποσοστού
    changed = dict(base)
    changed["deadline"] = utcnow() + timedelta(days=80)
    changed["subsidy_rate"] = 70.0
    with session_scope() as session:
        _, _, changes = upsert_program(session, changed)
    check(len(changes) == 2, f"εντοπίστηκαν 2 μεταβολές ({len(changes)})", str(changes))
    check(any("Προθεσμία" in c for c in changes), "εντοπίστηκε παράταση προθεσμίας")
    check(any("ενίσχυσης" in c for c in changes), "εντοπίστηκε αλλαγή έντασης ενίσχυσης")

    with session_scope() as session:
        history = session.query(ProgramChange).filter(
            ProgramChange.program_id == program_id).all()
        check(len(history) == 2, f"το ιστορικό αποθηκεύτηκε ({len(history)})")

    # Προφίλ που το πιάνει
    with session_scope() as session:
        session.add(Profile(name="Παρακολούθηση μεταβολών", keywords=["μεταβολή"], min_score=10))
    run_matching()
    with session_scope() as session:
        match = session.query(Match).filter(Match.program_id == program_id).first()
        check(match is not None, "το πρόγραμμα ταίριαξε με προφίλ")

    sent = notify_program_changes([(program_id, changes)])
    check(sent >= 1, f"στάλθηκε ειδοποίηση μεταβολής ({sent})")
    check(notify_program_changes([(program_id, changes)]) == 0,
          "η ίδια μεταβολή δεν ξαναστέλνεται")

    # Υπενθυμίσεις: κάθε ορόσημο μία φορά
    with session_scope() as session:
        program = session.get(Program, program_id)
        program.deadline = utcnow() + timedelta(days=6)
        program.status = "OPEN"
    first = send_deadline_reminders()
    check(first >= 1, f"υπενθύμιση στο ορόσημο 7 ημερών ({first})")
    check(send_deadline_reminders() == 0, "δεν επαναλαμβάνεται στο ίδιο ορόσημο")

    with session_scope() as session:
        session.get(Program, program_id).deadline = utcnow() + timedelta(days=2)
    second = send_deadline_reminders()
    check(second >= 1, f"νέα υπενθύμιση στο ορόσημο 3 ημερών ({second})")

    # Λήξη
    with session_scope() as session:
        session.get(Program, program_id).deadline = utcnow() - timedelta(days=1)
    check(close_expired() >= 1, "το ληγμένο πρόγραμμα κλείνει")
    with session_scope() as session:
        check(session.get(Program, program_id).status == "CLOSED", "η κατάσταση έγινε CLOSED")

    # Η σύνοψη δεν περιλαμβάνει ληγμένα
    with session_scope() as session:
        pending = session.query(Match).filter(
            Match.program_id == program_id, Match.digested_at.is_(None)).count()
    if pending:
        send_digest()
        with session_scope() as session:
            still = session.query(Match).filter(
                Match.program_id == program_id, Match.digested_at.is_(None)).count()
            check(still == pending, "τα ληγμένα εξαιρούνται από τη σύνοψη")

    check(isinstance(purge_old_logs(days=0), int), "ο καθαρισμός logs τρέχει")


def test_concurrency() -> None:
    print("\n[13. Ταυτόχρονη πρόσβαση]")
    from concurrent.futures import ThreadPoolExecutor

    from espa_radar.db import session_scope
    from espa_radar.models import Program
    from espa_radar.pipeline import enrich, upsert_program
    from espa_radar.sources.base import RawProgram

    # Ο scheduler γράφει σε άλλο thread από το API — δεν πρέπει να συγκρούονται.
    def insert(index: int) -> bool:
        data = enrich(RawProgram(
            source_id="conc", source_name="Ταυτόχρονα",
            title=f"Ταυτόχρονο πρόγραμμα {index}",
            url=f"https://example.gr/conc/{index}",
            summary="Επιχορήγηση επιχειρήσεων 40%.",
        ))
        try:
            with session_scope() as session:
                upsert_program(session, data)
            return True
        except Exception:  # noqa: BLE001
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(insert, range(24)))

    check(all(results), f"24 ταυτόχρονες εγγραφές πέτυχαν ({sum(results)}/24)")
    with session_scope() as session:
        stored = session.query(Program).filter(Program.source_id == "conc").count()
        check(stored == 24, f"αποθηκεύτηκαν και οι 24 ({stored})")

    # Το ΙΔΙΟ πρόγραμμα ταυτόχρονα: συμβαίνει όταν πέσει χειροκίνητο
    # POST /api/scan πάνω στον προγραμματισμένο κύκλο.
    same = enrich(RawProgram(
        source_id="race", source_name="Race", title="Ταυτόσημη Δράση Ενίσχυσης",
        url="https://example.gr/race/same", summary="Επιχορήγηση 50%.",
    ))
    race_errors: list[str] = []

    def insert_same(_: int) -> bool:
        try:
            with session_scope() as session:
                upsert_program(session, dict(same))
            return True
        except Exception as exc:  # noqa: BLE001
            race_errors.append(f"{type(exc).__name__}: {exc}"[:100])
            return False

    with ThreadPoolExecutor(max_workers=10) as pool:
        race_results = list(pool.map(insert_same, range(10)))

    check(all(race_results), f"10 ταυτόχρονες εγγραφές ίδιου URL πέτυχαν "
                             f"({sum(race_results)}/10)", str(set(race_errors)))
    with session_scope() as session:
        rows = session.query(Program).filter(Program.source_id == "race").count()
        check(rows == 1, f"το ίδιο URL έδωσε ακριβώς μία γραμμή ({rows})")


def main() -> int:
    print("=" * 64)
    print("ESPA Radar — ολοκληρωμένοι έλεγχοι")
    print("=" * 64)

    server, base_url = start_mock_server()
    ROUTES["/feed.xml"] = (200, "application/rss+xml; charset=utf-8", RSS_FIXTURE.encode("utf-8"))
    ROUTES["/list.html"] = (200, "text/html; charset=utf-8", HTML_FIXTURE.encode("utf-8"))
    ROUTES["/list-1253.html"] = (200, "text/html", HTML_1253)
    ROUTES["/api.json"] = (200, "application/json; charset=utf-8", JSON_FIXTURE.encode("utf-8"))
    write_sources_yaml(base_url)

    from espa_radar.db import init_db
    init_db()

    try:
        test_source_parsers(base_url)
        test_full_scan()
        test_webhook_notifier(base_url)
        test_telegram_notifier(base_url)
        test_email_notifier()
        test_notifier_routing(base_url)
        test_api_full()
        test_api_key_auth()
        test_scheduler()
        test_scheduler_job_execution()
        test_edge_cases()
        test_change_detection_and_reminders()
        test_concurrency()
    finally:
        server.shutdown()

    print("\n" + "=" * 64)
    if FAILURES:
        print(f"❌ {len(FAILURES)} αποτυχίες:")
        for failure in FAILURES:
            print(f"   - {failure}")
        return 1
    print("✅ Όλοι οι έλεγχοι πέρασαν")
    return 0


if __name__ == "__main__":
    sys.exit(main())
