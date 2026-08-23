# -*- coding: utf-8 -*-
"""
Οι περιοχές της πύλης, ανά νομό.

Η πύλη δεν έχει σελίδα «όλη η Ελλάδα» με αποτελέσματα: η διαδρομή
`/pwliseis-katoikies` χωρίς περιοχή είναι σελίδα κατηγορίας με κείμενα, και το
`/ellada` επιστρέφει 404. Τα αποτελέσματα ζουν σε
`/pwliseis-katoikies/<περιοχή>`. Άρα «όλη η χώρα» σημαίνει: όλοι οι νομοί, ένας
ένας.

Τα slug εδώ είναι υποψήφια, όχι επιβεβαιωμένα — γράφτηκαν από τη λατινική
απόδοση που χρησιμοποιεί η πύλη (`thessaloniki-kentro`), χωρίς πρόσβαση στον
κατάλογό της. Γι' αυτό υπάρχει το `--discover-locations`: δοκιμάζει το καθένα,
κρατά όσα δίνουν αγγελίες, και γράφει τη λίστα που επιβεβαιώθηκε. Η μεγάλη
σάρωση διαβάζει μόνο επιβεβαιωμένα.
"""
from __future__ import annotations

from typing import Dict, List

# νομός -> (ελληνικό όνομα, περιφέρεια για τα σήματα)
PREFECTURES: Dict[str, tuple] = {
    "attiki": ("Αττική", "Αττική"),
    "thessaloniki": ("Θεσσαλονίκη", "Κεντρική Μακεδονία"),
    "achaia": ("Αχαΐα", "Δυτική Ελλάδα"),
    "irakleio": ("Ηράκλειο", "Κρήτη"),
    "chania": ("Χανιά", "Κρήτη"),
    "rethymno": ("Ρέθυμνο", "Κρήτη"),
    "lasithi": ("Λασίθι", "Κρήτη"),
    "larisa": ("Λάρισα", "Θεσσαλία"),
    "magnisia": ("Μαγνησία", "Θεσσαλία"),
    "trikala": ("Τρίκαλα", "Θεσσαλία"),
    "karditsa": ("Καρδίτσα", "Θεσσαλία"),
    "ioannina": ("Ιωάννινα", "Ήπειρος"),
    "arta": ("Άρτα", "Ήπειρος"),
    "preveza": ("Πρέβεζα", "Ήπειρος"),
    "thesprotia": ("Θεσπρωτία", "Ήπειρος"),
    "kavala": ("Καβάλα", "Αν. Μακεδονία & Θράκη"),
    "drama": ("Δράμα", "Αν. Μακεδονία & Θράκη"),
    "xanthi": ("Ξάνθη", "Αν. Μακεδονία & Θράκη"),
    "rodopi": ("Ροδόπη", "Αν. Μακεδονία & Θράκη"),
    "evros": ("Έβρος", "Αν. Μακεδονία & Θράκη"),
    "serres": ("Σέρρες", "Κεντρική Μακεδονία"),
    "kilkis": ("Κιλκίς", "Κεντρική Μακεδονία"),
    "pella": ("Πέλλα", "Κεντρική Μακεδονία"),
    "imathia": ("Ημαθία", "Κεντρική Μακεδονία"),
    "pieria": ("Πιερία", "Κεντρική Μακεδονία"),
    "chalkidiki": ("Χαλκιδική", "Κεντρική Μακεδονία"),
    "kozani": ("Κοζάνη", "Δυτική Μακεδονία"),
    "grevena": ("Γρεβενά", "Δυτική Μακεδονία"),
    "kastoria": ("Καστοριά", "Δυτική Μακεδονία"),
    "florina": ("Φλώρινα", "Δυτική Μακεδονία"),
    "korinthia": ("Κορινθία", "Πελοπόννησος"),
    "argolida": ("Αργολίδα", "Πελοπόννησος"),
    "arkadia": ("Αρκαδία", "Πελοπόννησος"),
    "messinia": ("Μεσσηνία", "Πελοπόννησος"),
    "lakonia": ("Λακωνία", "Πελοπόννησος"),
    "ilia": ("Ηλεία", "Δυτική Ελλάδα"),
    "aitoloakarnania": ("Αιτωλοακαρνανία", "Δυτική Ελλάδα"),
    "fthiotida": ("Φθιώτιδα", "Στερεά Ελλάδα"),
    "voiotia": ("Βοιωτία", "Στερεά Ελλάδα"),
    "evvoia": ("Εύβοια", "Στερεά Ελλάδα"),
    "fokida": ("Φωκίδα", "Στερεά Ελλάδα"),
    "evrytania": ("Ευρυτανία", "Στερεά Ελλάδα"),
    "kerkyra": ("Κέρκυρα", "Ιόνια Νησιά"),
    "lefkada": ("Λευκάδα", "Ιόνια Νησιά"),
    "kefallinia": ("Κεφαλληνία", "Ιόνια Νησιά"),
    "zakynthos": ("Ζάκυνθος", "Ιόνια Νησιά"),
    "lesvos": ("Λέσβος", "Βόρειο Αιγαίο"),
    "chios": ("Χίος", "Βόρειο Αιγαίο"),
    "samos": ("Σάμος", "Βόρειο Αιγαίο"),
    "kyklades": ("Κυκλάδες", "Νότιο Αιγαίο"),
    "dodekanisa": ("Δωδεκάνησα", "Νότιο Αιγαίο"),
}

# Εναλλακτικές γραφές που χρησιμοποιούν οι πύλες για τα ίδια μέρη. Δοκιμάζονται
# όταν το κύριο slug δεν δώσει αποτελέσματα.
ALIASES: Dict[str, List[str]] = {
    "attiki": ["athina", "attica", "athens"],
    "thessaloniki": ["thessaloniki-kentro", "salonica"],
    "irakleio": ["heraklion", "iraklio"],
    "kefallinia": ["kefalonia"],
    "evvoia": ["evia"],
    "kyklades": ["cyclades", "mykonos", "santorini", "paros", "naxos", "syros"],
    "dodekanisa": ["dodecanese", "rodos", "kos"],
    "achaia": ["patra"],
    "magnisia": ["volos"],
    "lasithi": ["agios-nikolaos"],
}

VERIFIED_FILE = "akinita/data/perioxes_epalitheumenes.json"


def candidates(slug: str) -> List[str]:
    """Το slug και οι εναλλακτικές του, με σειρά προτεραιότητας."""
    return [slug] + ALIASES.get(slug, [])


def all_candidates() -> List[str]:
    seen, out = set(), []
    for slug in PREFECTURES:
        for candidate in candidates(slug):
            if candidate not in seen:
                seen.add(candidate)
                out.append(candidate)
    return out
