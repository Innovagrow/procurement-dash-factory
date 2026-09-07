"""Ξεχωρίζει τις ανοιχτές προσκλήσεις από τις ατομικές διοικητικές αποφάσεις.

Η Διαύγεια δημοσιεύει και τα δύο με παρόμοια γλώσσα. Μια «απόφαση υπαγωγής
της επιχείρησης Χ με ΑΦΜ …» δεν είναι ευκαιρία χρηματοδότησης — είναι πράξη
που αφορά έναν συγκεκριμένο δικαιούχο και δεν δέχεται αιτήσεις.
"""
from __future__ import annotations

import re

from .textutils import normalize

KIND_CALL = "CALL"          # ανοιχτή πρόσκληση / πρόγραμμα
KIND_DECISION = "DECISION"  # ατομική διοικητική πράξη
KIND_NEWS = "NEWS"          # ανακοίνωση, εκδήλωση, δελτίο τύπου
KIND_UNKNOWN = "UNKNOWN"

KIND_LABELS = {
    KIND_CALL: "Πρόσκληση",
    KIND_DECISION: "Ατομική απόφαση",
    KIND_NEWS: "Ανακοίνωση",
    KIND_UNKNOWN: "Άγνωστο",
}


def _cues(*phrases: str) -> tuple[str, ...]:
    return tuple(normalize(p) for p in phrases)


# --- Ενδείξεις ατομικής πράξης ----------------------------------------------

# Ο ΑΦΜ είναι το πιο καθαρό σημάδι: μπαίνει μόνο όταν η πράξη αφορά
# συγκεκριμένο πρόσωπο ή εταιρεία.
_TAX_ID = re.compile(r"\bα\.?φ\.?μ\.?\b", re.IGNORECASE)
_COMPANY_FORM = re.compile(
    r"ανωνυμ[ηθ]\s+εταιρ|α\.?ε\.?\b|ε\.?π\.?ε\.?\b|ι\.?κ\.?ε\.?\b|ο\.?ε\.?\b|"
    r"μονοπροσωπ|ατομικη επιχειρηση"
)

_DECISION_ACTS = _cues(
    "ολοκλήρωση", "οριστικοποίηση", "πιστοποίηση της έναρξης",
    "πιστοποίηση έναρξης", "καταβολή", "εκταμίευση", "ανάκληση",
    "απένταξη", "απόρριψη αιτήματος", "παραλαβή", "αποπληρωμή",
    "χρηματικό ένταλμα", "ανάληψη υποχρέωσης", "δέσμευση πίστωσης",
    "σύναψη συμβάσεων", "σύμβαση", "ορισμός ορκωτού", "επικύρωση πρακτικού",
    "πίνακα αποτελεσμάτων", "λογιστική τακτοποίηση", "απόδοση προμήθειας",
)

# Ο Αναπτυξιακός Νόμος δημοσιεύει δεκάδες τροποποιήσεις ατομικών αποφάσεων.
# Αναγνωρίζονται από τον κωδικό φακέλου (π.χ. «Π02/7/00080/Π») και από την
# αναφορά σε προηγούμενη απόφαση με αριθμό πρωτοκόλλου και ΦΕΚ.
_CASE_CODE = re.compile(r"π\s?\d{2}\s?/\s?\d\s?/\s?\d{4,5}", re.IGNORECASE)
_PRIOR_DECISION = re.compile(
    r"(υπ[\.\s'’]*\s*αριθ|αριθ\.?\s*πρωτ|υπ[όο]\s+στοιχε[ίι]α)", re.IGNORECASE
)
_GAZETTE = re.compile(r"φεκ\s*[αβγδ]?['’\s]", re.IGNORECASE)
_REGIONAL_ACT = _cues(
    "απόφασης του περιφερειάρχη", "απόφασης της περιφερειάρχη",
    "απόφασης υπαγωγής", "απόφαση υπαγωγής", "απόφασης ένταξης",
)

_BENEFICIARY_MARKERS = _cues(
    "της επιχείρησης", "την επιχείρηση", "της εταιρείας", "της εταιρίας",
    "στην εταιρεία", "στην εταιρία", "του δικαιούχου", "της δικαιούχου",
    "φορέα υλοποίησης", "με δ.τ.", "με διακριτικό τίτλο",
)

# --- Ενδείξεις ανοιχτής πρόσκλησης ------------------------------------------

_CALL_STRONG = _cues(
    "πρόσκληση υποβολής αιτήσεων", "πρόσκληση υποβολής προτάσεων",
    "πρόσκληση εκδήλωσης ενδιαφέροντος", "προκήρυξη",
    "υποβολή αιτήσεων χρηματοδότησης", "αιτήσεις συμμετοχής",
    "πρόσκληση συμμετοχής", "ανοιχτή πρόσκληση", "νέος κύκλος",
    "προδημοσίευση", "οδηγός προγράμματος", "καθεστώς ενίσχυσης",
)
_CALL_WEAK = _cues("πρόσκληση", "δράση", "πρόγραμμα", "δικαιούχοι", "επιλέξιμες δαπάνες")

# Τίτλοι που ΞΕΚΙΝΟΥΝ έτσι περιγράφουν το ίδιο το πρόγραμμα, όχι πράξη πάνω σε
# αυτό: «Πρόγραμμα για την ενίσχυση…», «Εξοικονομώ 2025», «Σπίτι μου II».
_CALL_OPENERS = _cues(
    "προγραμμα", "προγραμματα", "πιλοτικο προγραμμα", "δραση", "δρασεις",
    "νεο προγραμμα", "στεγαστικο προγραμμα", "καθεστως",
)

# --- Ενδείξεις ανακοίνωσης ---------------------------------------------------

_NEWS = _cues(
    "δεθ", "ημερίδα", "συνέδριο", "φόρουμ", "forum", "εκδήλωση",
    "δελτίο τύπου", "συμμετέχει", "παρουσίαση", "ενημερωτική",
    "συνάντηση", "επίσκεψη", "ομιλία", "βραβεί", "webinar",
)


def _hits(cues: tuple[str, ...], haystack: str) -> int:
    return sum(1 for cue in cues if cue in haystack)


def classify(title: str | None, summary: str | None = None,
             source_kind: str | None = None) -> str:
    """CALL | DECISION | NEWS | UNKNOWN.

    Το `source_kind` δηλώνει πηγή που εξ ορισμού δημοσιεύει μόνο προσκλήσεις
    (π.χ. το endpoint «calls» του Ελλάδα 2.0) — χρησιμοποιείται μόνο αφού
    αποκλειστεί ότι πρόκειται για ατομική πράξη.
    """
    raw = " ".join(filter(None, [title, summary]))
    if not raw.strip():
        return KIND_UNKNOWN
    hay = normalize(raw)
    head = normalize(title or "")[:40]

    call_strong = _hits(_CALL_STRONG, hay)
    decision_acts = _hits(_DECISION_ACTS, hay)
    beneficiary = _hits(_BENEFICIARY_MARKERS, hay)
    has_tax_id = bool(_TAX_ID.search(hay))
    has_company = bool(_COMPANY_FORM.search(hay))
    quoted_name = "«" in raw and has_company

    # Ο ΑΦΜ, ή διοικητική πράξη πάνω σε ονομαστικό δικαιούχο, δεν αφήνει
    # περιθώριο: αφορά έναν και μόνο δικαιούχο.
    if has_tax_id:
        return KIND_DECISION
    if decision_acts and (beneficiary or quoted_name):
        return KIND_DECISION

    # Αναφορά σε προηγούμενη ονομαστική απόφαση: τροποποίηση/ανάκληση πράξης
    # που αφορά έναν δικαιούχο, όχι νέα πρόσκληση.
    refers_back = bool(_PRIOR_DECISION.search(raw)) and (
        bool(_GAZETTE.search(raw)) or bool(_CASE_CODE.search(hay))
    )
    if refers_back or _hits(_REGIONAL_ACT, hay) or _CASE_CODE.search(hay):
        if not call_strong:
            return KIND_DECISION

    if call_strong:
        return KIND_CALL

    if source_kind == KIND_CALL:
        return KIND_CALL

    # «Πρόγραμμα …», «Δράση …» στην αρχή του τίτλου = το ίδιο το πρόγραμμα.
    if any(head.startswith(opener) for opener in _CALL_OPENERS):
        return KIND_CALL

    if _hits(_NEWS, hay):
        return KIND_NEWS

    # Διοικητική πράξη χωρίς ρητό δικαιούχο: πιθανότατα πάλι πράξη.
    if decision_acts >= 2:
        return KIND_DECISION
    if decision_acts == 1 and not _hits(_CALL_WEAK, hay):
        return KIND_DECISION

    if _hits(_CALL_WEAK, hay) >= 2:
        return KIND_CALL

    return KIND_UNKNOWN
