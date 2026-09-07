"""Τεστ για το ESPA Radar. Τρέχουν χωρίς δίκτυο (fake πηγή)."""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Απομονωμένη βάση ανά εκτέλεση — πριν από κάθε import του πακέτου.
_TMP_DB = Path(tempfile.mkdtemp(prefix="espa-radar-test-")) / "test.db"
os.environ["ESPA_DATABASE_URL"] = f"sqlite:///{_TMP_DB}"
os.environ["ESPA_SCHEDULER_ENABLED"] = "false"
os.environ["ESPA_NOTIFY_CHANNELS"] = "console"
os.environ["ESPA_POLITENESS_DELAY"] = "0"

from espa_radar import extract, matching, pipeline, taxonomy, textutils  # noqa: E402
from espa_radar.db import init_db, session_scope  # noqa: E402
from espa_radar.models import Match, NotificationLog, Profile, Program  # noqa: E402
from espa_radar.sources.base import RawProgram  # noqa: E402

FAILURES: list[str] = []


def check(condition: bool, label: str) -> None:
    if condition:
        print(f"  ✓ {label}")
    else:
        print(f"  ✗ {label}")
        FAILURES.append(label)


# ------------------------------------------------------------------
# Κείμενο & εξαγωγή
# ------------------------------------------------------------------

def test_text() -> None:
    print("\n[Κανονικοποίηση & parsing]")
    check(textutils.normalize("Ψηφιακός Μετασχηματισμός") == "ψηφιακοσ μετασχηματισμοσ", "αφαίρεση τόνων")
    check(textutils.similarity("Ψηφιακός Μετασχηματισμός ΜμΕ", "ψηφιακος μετασχηματισμος μμε") == 1.0,
          "ομοιότητα ανεξάρτητη τόνων")
    check(textutils.parse_date("31/12/2026").year == 2026, "ημερομηνία dd/mm/yyyy")
    check(textutils.parse_date("έως 15 Μαρτίου 2027").month == 3, "ημερομηνία με ελληνικό μήνα")
    check(textutils.parse_amounts("1,5 εκατ. €") == [1_500_000.0], "ποσό με πολλαπλασιαστή")
    check(textutils.parse_amounts("από 20.000 € έως 200.000 ευρώ") == [20000.0, 200000.0],
          "ελληνική μορφή χιλιάδων")
    check(textutils.parse_subsidy_rate("ένταση ενίσχυσης 45% έως 70%") == 70.0, "μέγιστο ποσοστό")


SAMPLE = """Δράση «Ψηφιακός Μετασχηματισμός ΜμΕ» — Πρόγραμμα ΕΣΠΑ 2021-2027.
Ο συνολικός προϋπολογισμός της δράσης ανέρχεται σε 300 εκατ. ευρώ.
Ο επιχορηγούμενος προϋπολογισμός ανά επενδυτικό σχέδιο κυμαίνεται από 18.000 € έως 30.000 €.
Η ένταση ενίσχυσης ανέρχεται σε 50% των επιλέξιμων δαπανών.
Δικαιούχοι: υφιστάμενες μικρομεσαίες επιχειρήσεις σε Κρήτη και Αττική.
Η πρόσκληση είναι ανοιχτή. Καταληκτική ημερομηνία υποβολής: 30/11/2027.
Ημερομηνία δημοσίευσης 12/01/2026."""


def test_extract() -> None:
    print("\n[Εξαγωγή πεδίων]")
    check(extract.extract_deadline(SAMPLE).strftime("%d/%m/%Y") == "30/11/2027", "καταληκτική ημερομηνία")
    check(extract.extract_published(SAMPLE).strftime("%d/%m/%Y") == "12/01/2026", "ημερομηνία δημοσίευσης")
    total, low, high = extract.extract_budgets(SAMPLE)
    check(total == 300_000_000.0, "συνολικός προϋπολογισμός δράσης")
    check((low, high) == (18000.0, 30000.0), "εύρος ανά έργο")
    check(extract.extract_subsidy_rate(SAMPLE) == 50.0, "ένταση ενίσχυσης")
    check("Κρήτη" in taxonomy.detect_regions(SAMPLE), "εντοπισμός περιφέρειας")
    check("Ψηφιακός μετασχηματισμός" in taxonomy.detect_sectors(SAMPLE), "εντοπισμός κλάδου")
    check("ΜμΕ" in taxonomy.detect_beneficiaries(SAMPLE), "εντοπισμός δικαιούχων")
    check(taxonomy.detect_status(SAMPLE, extract.extract_deadline(SAMPLE)) == "OPEN", "κατάσταση OPEN")

    expired = taxonomy.detect_status("ανοιχτή πρόσκληση", textutils.utcnow() - timedelta(days=5))
    check(expired == "CLOSED", "περασμένη προθεσμία υπερισχύει του κειμένου")


# ------------------------------------------------------------------
# Αποθήκευση
# ------------------------------------------------------------------

def _raw(title: str, url: str, body: str = SAMPLE) -> RawProgram:
    return RawProgram(
        source_id="test_source",
        source_name="Δοκιμαστική Πηγή",
        title=title,
        url=url,
        summary=body[:200],
        body=body,
    )


def test_storage() -> None:
    print("\n[Αποθήκευση & ανίχνευση αλλαγών]")
    init_db()

    data = pipeline.enrich(_raw("Ψηφιακός Μετασχηματισμός ΜμΕ", "https://example.gr/p1"))
    with session_scope() as session:
        program, is_new, changes = pipeline.upsert_program(session, data)
        program_id = program.id
    check(is_new, "νέο πρόγραμμα δημιουργείται")
    check(not changes, "κανένα change σε νέα εγγραφή")

    # Ίδια εγγραφή ξανά → ούτε νέο, ούτε αλλαγές.
    with session_scope() as session:
        _, is_new_again, changes_again = pipeline.upsert_program(session, data)
    check(not is_new_again and not changes_again, "idempotent upsert")

    # Αλλαγή προθεσμίας → καταγράφεται ως change.
    changed_text = SAMPLE.replace("30/11/2027", "31/12/2027")
    data2 = pipeline.enrich(_raw("Ψηφιακός Μετασχηματισμός ΜμΕ", "https://example.gr/p1", changed_text))
    with session_scope() as session:
        _, is_new3, changes3 = pipeline.upsert_program(session, data2)
    check(not is_new3, "ενημέρωση, όχι διπλοεγγραφή")
    check(any("Προθεσμία" in c for c in changes3), f"ανίχνευση παράτασης προθεσμίας ({changes3})")

    # Σχεδόν ίδιος τίτλος με διαφορετικό URL → dedupe.
    data3 = pipeline.enrich(_raw("Ψηφιακός Μετασχηματισμός ΜμΕ ", "https://example.gr/p1?ref=2"))
    with session_scope() as session:
        program4, is_new4, _ = pipeline.upsert_program(session, data3)
        same = program4.id == program_id
    check(not is_new4 and same, "dedupe σχεδόν ίδιου τίτλου")

    with session_scope() as session:
        check(session.query(Program).count() == 1, "μία μόνο εγγραφή στη βάση")


# ------------------------------------------------------------------
# Matching
# ------------------------------------------------------------------

def test_matching() -> None:
    print("\n[Μηχανή αντιστοίχισης]")
    with session_scope() as session:
        program = session.query(Program).first()

        good = Profile(
            name="Ψηφιακά Κρήτη",
            sectors=["Ψηφιακός μετασχηματισμός"],
            regions=["Κρήτη"],
            beneficiaries=["ΜμΕ"],
            keywords=["ψηφιακός μετασχηματισμός", "λογισμικό"],
            budget_min=10000,
            budget_max=50000,
            min_subsidy_rate=40,
        )
        result = matching.evaluate(good, program)
        check(result.matched, f"ταιριάζει το σχετικό προφίλ (σκορ {result.score})")
        check(result.score >= 60, f"υψηλό σκορ ({result.score})")
        check(bool(result.reasons), "υπάρχει αιτιολόγηση")

        irrelevant = Profile(
            name="Αλιεία",
            sectors=["Ναυτιλία / Γαλάζια οικονομία"],
            keywords=["υδατοκαλλιέργειες"],
        )
        check(not matching.evaluate(irrelevant, program).matched, "άσχετο προφίλ απορρίπτεται")

        excluded = Profile(name="Με αποκλεισμό", keywords=["ψηφιακός"], exclude_keywords=["ΜμΕ"])
        outcome = matching.evaluate(excluded, program)
        check(not outcome.matched and "αποκλεισμ" in (outcome.rejected_because or ""),
              "λέξη αποκλεισμού μπλοκάρει")

        strict_rate = Profile(name="Υψηλή ένταση", keywords=["ψηφιακός"], min_subsidy_rate=80)
        check(not matching.evaluate(strict_rate, program).matched, "φίλτρο έντασης ενίσχυσης")

        far_budget = Profile(name="Μεγάλα έργα", keywords=["ψηφιακός"], budget_min=5_000_000)
        check(not matching.evaluate(far_budget, program).matched, "φίλτρο προϋπολογισμού")

        session.add(good)


def test_pipeline_matching_and_notify() -> None:
    print("\n[Ροή: matching → ειδοποίηση]")
    created = pipeline.run_matching()
    check(created >= 1, f"δημιουργήθηκαν ταιριάσματα ({created})")

    with session_scope() as session:
        match = session.query(Match).first()
        check(match is not None and match.score > 0, "το ταίριασμα έχει σκορ")
        check(match.notified_at is None, "δεν έχει σταλεί ακόμη")

    sent = pipeline.send_instant_notifications()
    check(sent >= 1, f"στάλθηκε άμεση ειδοποίηση ({sent})")

    # Δεύτερη κλήση δεν ξαναστέλνει.
    check(pipeline.send_instant_notifications() == 0, "δεν στέλνει διπλές ειδοποιήσεις")

    digested = pipeline.send_digest()
    check(digested >= 1, f"στάλθηκε ημερήσια σύνοψη ({digested})")
    check(pipeline.send_digest() == 0, "η σύνοψη δεν επαναλαμβάνεται")

    with session_scope() as session:
        logs = session.query(NotificationLog).all()
        check(all(log.ok for log in logs), "όλες οι ειδοποιήσεις καταγράφηκαν ως επιτυχείς")
        check(len(logs) >= 2, f"υπάρχει ιστορικό ειδοποιήσεων ({len(logs)})")


def test_deadline_reminders() -> None:
    print("\n[Υπενθυμίσεις προθεσμίας]")
    with session_scope() as session:
        program = session.query(Program).first()
        program.deadline = textutils.utcnow() + timedelta(days=2)
        program.status = "OPEN"

    sent = pipeline.send_deadline_reminders()
    check(sent >= 1, f"στάλθηκε υπενθύμιση ({sent})")
    check(pipeline.send_deadline_reminders() == 0, "μία υπενθύμιση ανά ορόσημο")


def test_close_expired() -> None:
    print("\n[Λήξη προγραμμάτων]")
    with session_scope() as session:
        program = session.query(Program).first()
        program.deadline = textutils.utcnow() - timedelta(days=1)
        program.status = "OPEN"

    closed = pipeline.close_expired()
    check(closed >= 1, "τα ληγμένα κλείνουν")

    with session_scope() as session:
        check(session.query(Program).first().status == "CLOSED", "η κατάσταση ενημερώθηκε")


def test_api() -> None:
    print("\n[API]")
    try:
        from fastapi.testclient import TestClient
    except Exception as exc:  # noqa: BLE001
        print(f"  ~ παράλειψη (λείπει το TestClient: {exc})")
        return

    from espa_radar.api import app

    with TestClient(app) as client:
        response = client.get("/health")
        check(response.status_code == 200 and response.json()["database"], "GET /health")

        response = client.get("/")
        check(response.status_code == 200 and "Ραντάρ Επιδοτήσεων" in response.text,
              "GET / (dashboard)")
        check("/api/dashboard" in response.text,
              "η σελίδα τραβά τα δεδομένα από το API")

        response = client.get("/api/taxonomy")
        check(response.status_code == 200 and "Κρήτη" in response.json()["regions"], "GET /api/taxonomy")

        response = client.post("/api/profiles", json={
            "name": "Δοκιμή API",
            "sectors": ["Ψηφιακός μετασχηματισμός"],
            "keywords": ["λογισμικό"],
        })
        check(response.status_code == 201, f"POST /api/profiles ({response.status_code})")
        profile_id = response.json().get("id")

        response = client.get("/api/profiles")
        check(response.status_code == 200 and len(response.json()) >= 1, "GET /api/profiles")

        response = client.get("/api/programs")
        check(response.status_code == 200, "GET /api/programs")

        response = client.get("/api/matches")
        check(response.status_code == 200, "GET /api/matches")

        response = client.get("/api/sources")
        check(response.status_code == 200 and len(response.json()) >= 5, "GET /api/sources")

        if profile_id:
            check(client.delete(f"/api/profiles/{profile_id}").status_code == 204, "DELETE /api/profiles/{id}")


def main() -> int:
    print("=" * 62)
    print("ESPA Radar — έλεγχοι")
    print("=" * 62)

    test_text()
    test_extract()
    test_storage()
    test_matching()
    test_pipeline_matching_and_notify()
    test_deadline_reminders()
    test_close_expired()
    test_api()

    print("\n" + "=" * 62)
    if FAILURES:
        print(f"❌ {len(FAILURES)} αποτυχίες:")
        for failure in FAILURES:
            print(f"   - {failure}")
        return 1
    print("✅ Όλοι οι έλεγχοι πέρασαν")
    return 0


if __name__ == "__main__":
    sys.exit(main())
