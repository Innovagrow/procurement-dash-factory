# -*- coding: utf-8 -*-
"""
Εθνικός χάρτης ευκαιριών: πού να ψάξει κανείς, πριν ψάξει τι.

Οι πύλες αγγελιών δίνουν το «τι». Αυτό το αρχείο δίνει το «πού», από δύο
δημόσια σύνολα δεδομένων που ενημερώνονται μόνα τους:

* Eurostat tour_occ_nin2 — διανυκτερεύσεις ανά περιφέρεια (NUTS 2). Δείχνει
  πού υπάρχει ζήτηση που πληρώνει με τη νύχτα, και πώς κινείται.
* Διαύγεια — αποφάσεις δημόσιων έργων ανά δήμο. Δείχνει πού ξοδεύει το
  δημόσιο, που είναι το πιο πρώιμο σήμα αλλαγής μιας περιοχής.

Και τα δύο είναι κατατάξεις, όχι απόλυτα μεγέθη. Η σελίδα το γράφει, γιατί
ένα 0/100 που διαβάζεται ως «καθόλου τουρισμός» είναι χειρότερο από καθόλου
δείκτη: η τελευταία περιφέρεια της κατάταξης έχει τριακόσιες σαράντα χιλιάδες
διανυκτερεύσεις.

    python -m akinita.ethniki --out out/chartis.html
"""
from __future__ import annotations

import argparse
import dataclasses
import datetime as _dt
import html
import json
import sys
from typing import Dict, List, Optional, Sequence, Tuple

from . import theme
from .console import ensure_utf8
from .http import PoliteFetcher
from .signals.public_investment import PublicInvestmentSignal
from .signals.regions import GREEK_REGIONS, region_for
from .signals.tourism import TourismSignal

# Έδρες δήμων με συντεταγμένες. Η λίστα καλύπτει και τις 13 περιφέρειες ώστε
# καμία να μην κριθεί από μηδέν δήμους.
MUNICIPALITIES: List[Tuple[str, float, float]] = [
    ("Αθήνα", 37.9838, 23.7275), ("Πειραιάς", 37.9420, 23.6465),
    ("Θεσσαλονίκη", 40.6403, 22.9439), ("Πάτρα", 38.2466, 21.7346),
    ("Ηράκλειο", 35.3387, 25.1442), ("Χανιά", 35.5138, 24.0180),
    ("Λάρισα", 39.6390, 22.4191), ("Βόλος", 39.3621, 22.9420),
    ("Ιωάννινα", 39.6650, 20.8537), ("Καβάλα", 40.9396, 24.4069),
    ("Αλεξανδρούπολη", 40.8476, 25.8744), ("Κέρκυρα", 39.6243, 19.9217),
    ("Ρόδος", 36.4341, 28.2176), ("Κως", 36.8933, 27.2878),
    ("Μύκονος", 37.4467, 25.3289), ("Θήρα", 36.3932, 25.4615),
    ("Χαλκίδα", 38.4638, 23.5987), ("Καλαμάτα", 37.0389, 22.1142),
    ("Ναύπλιο", 37.5675, 22.8000), ("Σπάρτη", 37.0736, 22.4297),
    ("Κόρινθος", 37.9407, 22.9573), ("Τρίκαλα", 39.5556, 21.7679),
    ("Κοζάνη", 40.3007, 21.7887), ("Καστοριά", 40.5167, 21.2667),
    ("Σέρρες", 41.0856, 23.5480), ("Κατερίνη", 40.2719, 22.5024),
    ("Βέροια", 40.5236, 22.2030), ("Δράμα", 41.1533, 24.1467),
    ("Ξάνθη", 41.1352, 24.8880), ("Κομοτηνή", 41.1224, 25.4066),
    ("Μυτιλήνη", 39.1042, 26.5548), ("Χίος", 38.3680, 26.1354),
    ("Σάμος", 37.7547, 26.9770), ("Ρέθυμνο", 35.3667, 24.4833),
    ("Πύργος", 37.6749, 21.4413), ("Άρτα", 39.1600, 20.9856),
    ("Πρέβεζα", 38.9583, 20.7511), ("Λαμία", 38.9000, 22.4333),
    ("Λευκάδα", 38.7333, 20.7000), ("Ζάκυνθος", 37.7870, 20.8990),
    ("Αγρίνιο", 38.6214, 21.4079), ("Τρίπολη", 37.5089, 22.3794),
    ("Φλώρινα", 40.7833, 21.4000), ("Πολύγυρος", 40.3789, 23.4425),
    ("Σύρος", 37.4467, 24.9436), ("Νάξος", 37.1036, 25.3766),
    ("Πάρος", 37.0853, 25.1520), ("Άγιος Νικόλαος", 35.1900, 25.7167),
]


# --------------------------------------------------------------- συλλογή
def collect(fetcher: PoliteFetcher,
            municipalities: Sequence[Tuple[str, float, float]] = MUNICIPALITIES,
            verbose: bool = True) -> Dict:
    """Ζωντανή ανάγνωση και των δύο σημάτων για όλη τη χώρα."""
    data: Dict = {"regions": [], "municipalities": [], "unmatched": [],
                  "generated": _dt.datetime.now().strftime("%d/%m/%Y %H:%M")}

    if verbose:
        print("· Eurostat — διανυκτερεύσεις ανά περιφέρεια …", flush=True)
    tourism = TourismSignal(fetcher)
    tourism.warm()
    for code, (name, points) in GREEK_REGIONS.items():
        reading = tourism.reading(points[0][0], points[0][1], name)
        if reading:
            row = dataclasses.asdict(reading)
            row["code"] = code
            data["regions"].append(row)
    data["regions"].sort(key=lambda r: -r["intensity"])
    if verbose:
        print(f"  ✓ {len(data['regions'])}/{len(GREEK_REGIONS)} περιφέρειες", flush=True)

    if verbose:
        print("· Διαύγεια — αποφάσεις δημόσιων έργων ανά δήμο …", flush=True)
    works = PublicInvestmentSignal(fetcher)
    works.warm()
    by_region = {r["area"]: r for r in data["regions"]}
    for name, lat, lng in municipalities:
        reading = works.reading(lat, lng, name)
        if not reading:
            # Ο ταυτοποιητής αρνείται όταν ένα όνομα ταιριάζει σε πάνω από
            # έναν δήμο. Καλύτερα κενό παρά λάθος δήμος.
            data["unmatched"].append(name)
            continue
        row = dataclasses.asdict(reading)
        row["asked_for"] = name
        located = region_for(lat, lng)
        row["region"] = located[1] if located else ""
        region_row = by_region.get(row["region"])
        row["region_tourism"] = region_row["intensity"] if region_row else None
        row["where_to_look"] = (
            round((row["intensity"] + row["region_tourism"]) / 2.0, 1)
            if row["region_tourism"] is not None else None
        )
        data["municipalities"].append(row)
    data["municipalities"].sort(key=lambda r: -(r["where_to_look"] or -1))
    if verbose:
        print(f"  ✓ {len(data['municipalities'])}/{len(municipalities)} δήμοι ταυτοποιήθηκαν "
              f"· {len(data['unmatched'])} χωρίς ασφαλή ταυτοποίηση", flush=True)
    return data


# --------------------------------------------------------------- εμφάνιση
# Τα ίδια tokens με τη σελίδα αποτελεσμάτων (webreport.py): μία σελίδα, μία
# οπτική γλώσσα. Ένα χρώμα για το μέγεθος, τα σημασιολογικά χρώματα μόνο για
# πρόσημο — ένα μπλε μπάρα δεν σημαίνει «καλό», σημαίνει «πόσο».
PANE_CSS = """
  /* Σκοπευμένο κάτω από #pane-areas: η άλλη καρτέλα έχει δικούς της πίνακες
     και δεν πρέπει να τους αγγίξει τίποτα από εδώ. */
  #pane-areas .panel{background:var(--surface);border:1px solid var(--line);
    border-radius:6px;overflow:hidden}
  #pane-areas .scroller{overflow-x:auto}
  #pane-areas table{border-collapse:collapse;width:100%;min-width:600px;font-size:14px}
  #pane-areas th{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
    color:var(--muted);text-align:left;font-weight:600;padding:10px 13px;
    border-bottom:1px solid var(--line);background:var(--raised);white-space:nowrap;
    font-family:var(--ui)}
  #pane-areas td{padding:9px 13px;border-bottom:1px solid var(--hair);vertical-align:middle}
  #pane-areas tr:last-child td{border-bottom:none}
  #pane-areas .num{font-family:var(--mono);font-variant-numeric:tabular-nums;
    text-align:right;white-space:nowrap}
  #pane-areas .rank{font-family:var(--mono);color:var(--faint);text-align:right;font-size:13px}
  #pane-areas .place{font-family:var(--ui);font-weight:500}
  #pane-areas .sub{display:block;font-family:var(--ui);font-size:11.5px;color:var(--faint);
    font-weight:400}
  #pane-areas .meter{display:flex;align-items:center;gap:8px;min-width:132px}
  #pane-areas .meter i{flex:1;height:6px;background:var(--sunken);border-radius:3px;
    position:relative;display:block;min-width:60px}
  #pane-areas .meter i b{position:absolute;inset:0 auto 0 0;background:var(--accent);
    border-radius:3px}
  #pane-areas .meter em{font-family:var(--mono);font-style:normal;font-size:12.5px;
    color:var(--muted);font-variant-numeric:tabular-nums;width:30px;text-align:right}
  #pane-areas .up{color:var(--good)}
  #pane-areas .down{color:var(--warn)}
"""

def _n(value: Optional[float], decimals: int = 0) -> str:
    """Ελληνική μορφή αριθμού: τελεία για χιλιάδες, κόμμα για δεκαδικά."""
    if value is None:
        return "—"
    text = f"{value:,.{decimals}f}"
    return text.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def _meter(value: Optional[float]) -> str:
    if value is None:
        return '<span class="meter"><em>—</em></span>'
    width = max(1.5, min(100.0, value))
    return (f'<span class="meter"><i><b style="width:{width:.1f}%"></b></i>'
            f'<em>{value:.0f}</em></span>')


def _momentum(value: Optional[float]) -> str:
    if value is None:
        return '<span class="num">—</span>'
    arrow, css = ("▲", "up") if value >= 0 else ("▼", "down")
    return f'<span class="num {css}">{arrow} {value:+.1f}%</span>'


def render_pane(data: Dict) -> str:
    """Το περιεχόμενο της καρτέλας «Περιοχές», έτοιμο να μπει στη σελίδα.

    Οι ωμές διανυκτερεύσεις δεν είναι απάντηση σε κανένα ερώτημα αγοραστή. Ο
    πίνακας οδηγεί με το τι σημαίνουν — πόση ζήτηση υπάρχει για μίσθωση — και
    κρατά τον αριθμό από κάτω, μικρό, ως τεκμήριο.
    """
    regions = data["regions"]
    municipalities = data["municipalities"]
    esc = html.escape
    latest = regions[0]["as_of"] if regions else "—"

    region_rows = []
    for position, row in enumerate(regions, 1):
        evidence = [e for e in row.get("evidence", []) if "%" not in e]
        years = [e.split(":")[0].strip() for e in evidence if e[:4].isdigit()]
        span = f"{years[0]}–{years[-1]}" if len(years) > 1 else (years[0] if years else "—")
        nights = row.get("raw_value")
        nights_text = (f"{nights / 1_000_000:.1f} εκατ. διανυκτερεύσεις {esc(latest)}"
                       if nights else "χωρίς μέτρηση")
        region_rows.append(
            f'<tr><td class="rank">{position}</td>'
            f'<td class="place">{esc(row["area"])}'
            f'<span class="sub">{nights_text} · μετρήσεις {span}</span></td>'
            f'<td>{_meter(row["intensity"])}</td>'
            f'<td>{_momentum(row.get("momentum"))}</td>'
            f'<td>{_momentum((row.get("detail") or {}).get("versus_2019_pct"))}</td>'
            f'</tr>'
        )

    muni_rows = []
    for position, row in enumerate(municipalities, 1):
        sample = next((e.strip() for e in row.get("evidence", []) if e.strip()), "")
        title = f' title="{esc(sample[:170])}"' if sample else ""
        muni_rows.append(
            f'<tr><td class="rank">{position}</td>'
            f'<td class="place">{esc(row["asked_for"])}'
            f'<span class="sub">{esc(row["region"])}</span></td>'
            f'<td>{_meter(row.get("region_tourism"))}</td>'
            f'<td>{_meter(row["intensity"])}</td>'
            f'<td class="num"{title}>{_n(row.get("raw_value"))}</td>'
            f'<td>{_meter(row.get("where_to_look"))}</td>'
            f'</tr>'
        )

    lowest = regions[-1] if regions else None
    lowest_note = ""
    if lowest and lowest["intensity"] <= 0:
        lowest_note = (
            f'<p class="foot-note">Το 0/100 είναι θέση στην κατάταξη, όχι απουσία: η '
            f'{esc(lowest["area"])} έχει {_n(lowest.get("raw_value"))} διανυκτερεύσεις — '
            f'είναι η τελευταία των δεκατριών, όχι περιοχή χωρίς τουρισμό.</p>'
        )

    return f"""<div class="pane-head">
  <h2>Πού να ψάξεις πρώτα</h2>
  <p>Ο μέσος όρος δύο κατατάξεων: πόση ζήτηση για μίσθωση έχει η περιοχή, και πόσα
    δημόσια έργα τρέχουν στον δήμο. Λέει πού να κοιτάξεις — τι θα αγοράσεις το
    κρίνει το ακίνητο, στην καρτέλα «Ευκαιρίες».</p>
</div>
<div class="panel scroller">
  <table>
    <thead><tr><th></th><th>Δήμος</th><th>Ζήτηση περιοχής</th><th>Δημόσια έργα</th>
      <th>Αποφάσεις</th><th>Πού να ψάξεις πρώτα</th></tr></thead>
    <tbody>{"".join(muni_rows)}</tbody>
  </table>
</div>

<div class="pane-head">
  <h2>Οι 13 περιφέρειες, κατά ζήτηση</h2>
  <p>Η ζήτηση μετριέται από τις διανυκτερεύσεις που καταγράφει η Eurostat: πόσοι
    πληρώνουν για να μείνουν εκεί. Η τάση εξαιρεί 2020 και 2021, που μετρούν το
    κλείσιμο των συνόρων και όχι τον τουρισμό.</p>
</div>
<div class="panel scroller">
  <table>
    <thead><tr><th></th><th>Περιφέρεια</th><th>Ζήτηση για μίσθωση</th>
      <th>Τάση/έτος</th><th>Από το 2019</th></tr></thead>
    <tbody>{"".join(region_rows)}</tbody>
  </table>
</div>
{lowest_note}
"""


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Φτιάχνει ΤΗ σελίδα — μία, με καρτέλες.

    Στο droplet δεν υπάρχει σάρωση αγγελιών: οι πύλες απορρίπτουν τις
    διευθύνσεις των data center. Οι περιοχές όμως διαβάζονται από παντού, και
    η σάρωση που έγινε αλλού ανεβαίνει ως αρχείο δεδομένων και μπαίνει στην
    καρτέλα «Ευκαιρίες» χωρίς να ξανατρέξει τίποτα.
    """
    ensure_utf8()
    parser = argparse.ArgumentParser(
        prog="akinita.ethniki",
        description="Η σελίδα: ευκαιρίες και περιοχές, σε μία σελίδα με καρτέλες.")
    parser.add_argument("--out", default="out/index.html", help="Αρχείο HTML")
    parser.add_argument("--scan", default="",
                        help="Δεδομένα σάρωσης (<out>_analysis.json) για την καρτέλα «Ευκαιρίες»")
    parser.add_argument("--json-out", default="", help="Τα δεδομένα περιοχών ως JSON")
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument("--cache-hours", type=float, default=24.0)
    args = parser.parse_args(argv)

    import os
    from .webreport import empty_data, render_page

    fetcher = PoliteFetcher(delay=args.delay, verbose=False, cache_ttl_hours=args.cache_hours)
    data = collect(fetcher)

    scan = None
    if args.scan and os.path.exists(args.scan):
        try:
            with open(args.scan, encoding="utf-8") as handle:
                scan = json.load(handle)
            print(f"  ✓ σάρωση: {len(scan.get('items', []))} ακίνητα από {args.scan}")
        except (ValueError, OSError) as exc:
            print(f"  · η σάρωση δεν διαβάστηκε ({exc}) — η καρτέλα θα είναι κενή")
    elif args.scan:
        print(f"  · δεν βρέθηκε {args.scan} — η καρτέλα «Ευκαιρίες» θα είναι κενή")

    page = render_page(scan or empty_data(), render_pane(data), PANE_CSS)

    directory = os.path.dirname(os.path.abspath(args.out))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(page)
    print(f"  ✓ {args.out}")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=1)
        print(f"  ✓ {args.json_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
