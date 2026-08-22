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
CSS = """
  :root{
    --ground:#ECEEF1; --surface:#FFFFFF; --raised:#F5F7F9; --sunken:#E1E5EB;
    --ink:#171A1F; --muted:#586170; --faint:#8B94A3;
    --line:#D5DAE2; --hair:#E6E9EE;
    --accent:#2E3A8C; --accent-soft:#E2E5F4;
    --good:#2F6B4A; --warn:#A34A2A;
    --ui:"IBM Plex Sans",-apple-system,"Segoe UI",sans-serif;
    --body:"Literata",Georgia,serif;
    --mono:"Noto Sans Mono",ui-monospace,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --ground:#101317; --surface:#181C22; --raised:#1E232A; --sunken:#0B0E12;
      --ink:#E7EBF0; --muted:#98A2B1; --faint:#6C7788;
      --line:#272D36; --hair:#20262E;
      --accent:#8B98E8; --accent-soft:#1C2140;
      --good:#6FBF93; --warn:#DB8B68;
    }
  }
  :root[data-theme="dark"]{
    --ground:#101317; --surface:#181C22; --raised:#1E232A; --sunken:#0B0E12;
    --ink:#E7EBF0; --muted:#98A2B1; --faint:#6C7788;
    --line:#272D36; --hair:#20262E;
    --accent:#8B98E8; --accent-soft:#1C2140;
    --good:#6FBF93; --warn:#DB8B68;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);
    font-family:var(--body);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1060px;margin:0 auto;padding:34px 20px 72px;
    display:flex;flex-direction:column;gap:34px}
  h1,h2,h3,.ui,th,label,.eyebrow{font-family:var(--ui)}
  h1{font-size:31px;line-height:1.16;margin:0;letter-spacing:-.02em;text-wrap:balance;font-weight:600}
  h2{font-size:19px;margin:0;letter-spacing:-.01em;font-weight:600;text-wrap:balance}
  h3{font-size:14px;margin:0;font-weight:600}
  p{margin:0;max-width:68ch}
  a{color:var(--accent);text-underline-offset:3px}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
  .eyebrow{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);
    font-weight:600}
  .lede{color:var(--muted);font-size:16.5px}
  header{display:flex;flex-direction:column;gap:13px;
    border-bottom:1px solid var(--line);padding-bottom:26px}
  .stamp{font-family:var(--mono);font-size:11.5px;color:var(--faint);
    display:flex;flex-wrap:wrap;gap:6px 16px}
  section{display:flex;flex-direction:column;gap:15px}
  .head{display:flex;flex-direction:column;gap:5px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px}
  .tile{background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:14px 15px}
  .tile b{display:block;font-family:var(--mono);font-size:23px;font-weight:600;
    letter-spacing:-.02em;color:var(--accent);font-variant-numeric:tabular-nums}
  .tile b.name{font-family:var(--ui);font-size:19px;letter-spacing:-.01em;line-height:1.25}
  .tile span{display:block;font-family:var(--ui);font-size:11.5px;color:var(--muted);
    margin-top:3px;line-height:1.35}
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:11px;overflow:hidden}
  .scroller{overflow-x:auto}
  table{border-collapse:collapse;width:100%;min-width:620px;font-size:14px}
  th{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);
    text-align:left;font-weight:600;padding:11px 14px;border-bottom:1px solid var(--line);
    background:var(--raised);white-space:nowrap}
  td{padding:11px 14px;border-bottom:1px solid var(--hair);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
  .place{font-family:var(--ui);font-weight:500}
  .sub{display:block;font-family:var(--ui);font-size:11.5px;color:var(--faint);font-weight:400}
  .rank{font-family:var(--mono);color:var(--faint);text-align:right;font-size:13px}
  .meter{display:flex;align-items:center;gap:9px;min-width:150px}
  .meter i{flex:1;height:6px;background:var(--sunken);border-radius:3px;position:relative;
    display:block;min-width:70px}
  .meter i b{position:absolute;inset:0 auto 0 0;background:var(--accent);border-radius:3px}
  .meter em{font-family:var(--mono);font-style:normal;font-size:12.5px;color:var(--muted);
    font-variant-numeric:tabular-nums;width:34px;text-align:right}
  .up{color:var(--good)} .down{color:var(--warn)}
  .note{border-left:3px solid var(--accent);background:var(--surface);
    border-radius:0 9px 9px 0;padding:13px 16px;font-size:14.5px}
  .note b{font-family:var(--ui);font-size:13px;display:block;margin-bottom:3px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(258px,1fr));gap:11px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:14px 15px;
    display:flex;flex-direction:column;gap:7px}
  .card p{font-size:13.5px;color:var(--muted);margin:0}
  .quote{font-size:12.5px;color:var(--faint);border-left:2px solid var(--hair);padding-left:10px;
    line-height:1.45}
  .pills{display:flex;flex-wrap:wrap;gap:6px}
  .pill{font-family:var(--ui);font-size:12px;background:var(--raised);color:var(--muted);
    border:1px solid var(--line);border-radius:999px;padding:3px 10px}
  pre{font-family:var(--mono);font-size:12.5px;background:var(--sunken);color:var(--ink);
    border:1px solid var(--line);border-radius:9px;padding:14px 15px;margin:0;
    overflow-x:auto;line-height:1.65;white-space:pre;-webkit-text-size-adjust:100%}
  footer{border-top:1px solid var(--line);padding-top:20px;font-size:13px;color:var(--muted);
    display:flex;flex-direction:column;gap:7px}
  ul{margin:0;padding-left:19px;display:flex;flex-direction:column;gap:6px;max-width:68ch}
  li::marker{color:var(--faint)}
  @media (max-width:640px){
    h1{font-size:25px} .wrap{padding:26px 15px 56px;gap:28px}
  }
"""

# Ένα αντιγράψιμο μπλοκ για γραμμή εντολών των Windows, από το μηδέν: κατέβασμα,
# εξαρτήσεις, σάρωση, άνοιγμα της σελίδας. Το `tar` και το `curl` υπάρχουν ήδη
# στα Windows 10 και 11.
BRANCH_ZIP = ("https://github.com/Innovagrow/procurement-dash-factory/archive/"
              "refs/heads/claude/greek-brokers-investment-outreach-gr5j9p.zip")
FOLDER = "procurement-dash-factory-claude-greek-brokers-investment-outreach-gr5j9p"
DEFAULT_COMMAND = (
    f'cd /d "%USERPROFILE%\\Desktop" && curl -L -o akinita.zip "{BRANCH_ZIP}"'
    f' && tar -xf akinita.zip && cd {FOLDER}\n'
    "py -3 -m pip install -r requirements-akinita.txt && py -3 -m playwright install chromium\n"
    "py -3 -m akinita.screener --source spitogatos --all-types --personal-use "
    "--max-price 50000 --enrich-top 150 --top 400 --delay 2.5 "
    "--out out\\eukairies --html-out out\\apotelesmata.html && start out\\apotelesmata.html"
)


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


def render(data: Dict, command: str = DEFAULT_COMMAND) -> str:
    """Η σελίδα ως απόσπασμα HTML — δικό της <title>, χωρίς document tags."""
    regions = data["regions"]
    municipalities = data["municipalities"]
    esc = html.escape

    total_nights = sum(r.get("raw_value") or 0 for r in regions)
    latest = regions[0]["as_of"] if regions else "—"
    top_region = regions[0]["area"] if regions else "—"
    fastest = max(regions, key=lambda r: r.get("momentum") if r.get("momentum") is not None else -99)

    region_rows = []
    for position, row in enumerate(regions, 1):
        nights = _n(row.get("raw_value"))
        evidence = [e for e in row.get("evidence", []) if "%" not in e]
        measured_years = [e.split(":")[0].strip() for e in evidence if e[:4].isdigit()]
        span = (f"{measured_years[0]}–{measured_years[-1]}" if len(measured_years) > 1
                else (measured_years[0] if measured_years else "—"))
        against_2019 = (row.get("detail") or {}).get("versus_2019_pct")
        region_rows.append(
            f'<tr><td class="rank">{position}</td>'
            f'<td class="place">{esc(row["area"])}<span class="sub">{esc(row["code"])}'
            f' · μετρήσεις {span}</span></td>'
            f'<td>{_meter(row["intensity"])}</td>'
            f'<td class="num">{nights}</td>'
            f'<td>{_momentum(row.get("momentum"))}</td>'
            f'<td>{_momentum(against_2019)}</td>'
            f'</tr>'
        )

    muni_rows = []
    for position, row in enumerate(municipalities, 1):
        muni_rows.append(
            f'<tr><td class="rank">{position}</td>'
            f'<td class="place">{esc(row["asked_for"])}<span class="sub">{esc(row["area"])}</span></td>'
            f'<td class="num">{esc(row["region"])}</td>'
            f'<td>{_meter(row.get("region_tourism"))}</td>'
            f'<td>{_meter(row["intensity"])}</td>'
            f'<td class="num">{_n(row.get("raw_value"))}</td>'
            f'<td>{_meter(row.get("where_to_look"))}</td>'
            f'</tr>'
        )

    cards = []
    for row in municipalities[:4]:
        seen, quotes = set(), []
        for line in row.get("evidence", []):
            trimmed = line.strip()
            if trimmed and trimmed not in seen:
                seen.add(trimmed)
                quotes.append(trimmed)
            if len(quotes) == 2:
                break
        quoted = "".join(f'<span class="quote">{esc(q[:190])}…</span>' for q in quotes)
        cards.append(
            f'<div class="card"><h3>{esc(row["asked_for"])}</h3>'
            f'<p>{_n(row.get("raw_value"))} αποφάσεις έργων στους τελευταίους 18 μήνες · '
            f'τουρισμός περιφέρειας {row.get("region_tourism"):.0f}/100</p>{quoted}</div>'
            if row.get("region_tourism") is not None else
            f'<div class="card"><h3>{esc(row["asked_for"])}</h3>'
            f'<p>{_n(row.get("raw_value"))} αποφάσεις έργων στους τελευταίους 18 μήνες</p>{quoted}</div>'
        )

    unmatched = "".join(f'<span class="pill">{esc(name)}</span>' for name in data["unmatched"])
    lowest = regions[-1] if regions else None
    lowest_note = ""
    if lowest:
        lowest_note = (
            f'<div class="note"><b>Το 0/100 δεν σημαίνει «καθόλου»</b>'
            f'Η ένταση είναι κατάταξη ανάμεσα στις 13 περιφέρειες, όχι απόλυτο μέγεθος. '
            f'Η τελευταία της κατάταξης, {esc(lowest["area"])}, γράφει '
            f'{lowest["intensity"]:.0f}/100 έχοντας {_n(lowest.get("raw_value"))} '
            f'διανυκτερεύσεις. Είναι η λιγότερο τουριστική περιφέρεια της χώρας, όχι μια '
            f'περιφέρεια χωρίς τουρισμό.</div>'
        )

    return f"""<title>Χάρτης Ευκαιριών Ελλάδας</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Literata:opsz,wght@7..72,400;7..72,600&family=Noto+Sans+Mono:wght@400;600&display=swap&subset=greek,latin">
<style>{CSS}</style>
<div class="wrap">
  <header>
    <span class="eyebrow">Πού να ψάξεις, πριν ψάξεις τι</span>
    <h1>Χάρτης ευκαιριών ακινήτων στην Ελλάδα</h1>
    <p class="lede">Δύο δημόσια σύνολα δεδομένων, διαβασμένα ζωντανά: πόση ζήτηση
      πληρώνει με τη νύχτα σε κάθε περιφέρεια, και πού ξοδεύει το δημόσιο σε έργα.
      Το πρώτο δείχνει πού υπάρχει εισόδημα σήμερα· το δεύτερο, πού αλλάζει η
      περιοχή αύριο. Καμία τιμή ακινήτου δεν χρειάστηκε για αυτή τη σελίδα.</p>
    <div class="stamp">
      <span>Παράχθηκε {esc(data["generated"])}</span>
      <span>Eurostat tour_occ_nin2 · έτος αναφοράς {esc(latest)}</span>
      <span>Διαύγεια · κυλιόμενο 18μηνο</span>
    </div>
  </header>

  <section>
    <div class="tiles">
      <div class="tile"><b>{len(regions)}</b><span>περιφέρειες με πλήρη σειρά μετρήσεων</span></div>
      <div class="tile"><b>{_n(total_nights)}</b><span>διανυκτερεύσεις πανελλαδικά, {esc(latest)}</span></div>
      <div class="tile"><b>{len(municipalities)}</b><span>δήμοι με ασφαλή ταυτοποίηση στη Διαύγεια</span></div>
      <div class="tile"><b class="name">{esc(top_region)}</b><span>πρώτη σε τουριστική ζήτηση</span></div>
    </div>
  </section>

  <section>
    <div class="head">
      <span class="eyebrow">01 · Ζήτηση που πληρώνει με τη νύχτα</span>
      <h2>Οι 13 περιφέρειες, κατά σειρά</h2>
      <p class="lede">Η ένταση κατατάσσει· ο ρυθμός δείχνει προς τα πού πάει. Τα έτη
        2020 και 2021 εξαιρούνται από τον ρυθμό: μετρούν το κλείσιμο των συνόρων,
        όχι τον τουρισμό. Η ταχύτερα ανερχόμενη είναι η {esc(fastest["area"])}.</p>
    </div>
    <div class="panel scroller">
      <table>
        <thead><tr><th></th><th>Περιφέρεια</th><th>Πόσος τουρισμός</th>
          <th>Διανυκτερεύσεις {esc(latest)}</th><th>Ρυθμός/έτος</th><th>Έναντι 2019</th></tr></thead>
        <tbody>{"".join(region_rows)}</tbody>
      </table>
    </div>
    {lowest_note}
  </section>

  <section>
    <div class="head">
      <span class="eyebrow">02 · Πού συναντιούνται τα δύο σήματα</span>
      <h2>Δήμοι με ζήτηση και με έργα ταυτόχρονα</h2>
      <p class="lede">Η τελευταία στήλη είναι ο μέσος όρος των δύο κατατάξεων και τίποτα
        παραπάνω. Λέει πού αξίζει να ψάξει κανείς πρώτα — δεν λέει τι να αγοράσει.
        Αυτό το κρίνει το ακίνητο, με τους δικούς του αριθμούς.</p>
    </div>
    <div class="panel scroller">
      <table>
        <thead><tr><th></th><th>Δήμος</th><th>Περιφέρεια</th><th>Τουρισμός</th>
          <th>Δημόσια έργα</th><th>Αποφάσεις</th><th>Πού να ψάξεις πρώτα</th></tr></thead>
        <tbody>{"".join(muni_rows)}</tbody>
      </table>
    </div>
  </section>

  <section>
    <div class="head">
      <span class="eyebrow">03 · Τι λένε οι ίδιες οι αποφάσεις</span>
      <h2>Δείγμα από τα τεκμήρια</h2>
      <p class="lede">Ο δείκτης έργων δεν είναι γνώμη· είναι μέτρημα αναρτημένων
        αποφάσεων. Αυτά είναι αυτούσια αποσπάσματα από τους τέσσερις πρώτους δήμους.</p>
    </div>
    <div class="cards">{"".join(cards)}</div>
  </section>

  <section>
    <div class="head">
      <span class="eyebrow">04 · Τα όρια αυτής της σελίδας</span>
      <h2>Τι δεν μετρήθηκε, και γιατί</h2>
    </div>
    <ul>
      <li><b>Οι δείκτες είναι κατατάξεις, όχι τιμές.</b> Δείχνουν σειρά μεταξύ περιοχών,
        και στα δύο σήματα: ο τελευταίος δήμος της κατάταξης έργων γράφει 0/100 ενώ έχει
        αναρτημένες αποφάσεις — γι' αυτό η στήλη «Αποφάσεις» δείχνει το ωμό πλήθος δίπλα
        στη μπάρα. Κανένας από τους δύο δείκτες δεν λέει αν ένα συγκεκριμένο ακίνητο
        είναι φθηνό.</li>
      <li><b>Η περιφέρεια είναι χονδρικό επίπεδο.</b> Η Μύκονος και η Σύρος μοιράζονται
        τον ίδιο τουριστικό δείκτη, επειδή η Eurostat δημοσιεύει σε επίπεδο NUTS 2.</li>
      <li><b>Η Διαύγεια μετριέται με λέξεις-κλειδιά.</b> Είναι δείγμα αποφάσεων έργων,
        όχι πλήρες μητρώο δαπανών.</li>
      <li><b>{len(data["unmatched"])} δήμοι έμειναν χωρίς μέτρηση</b> επειδή το όνομά τους
        ταιριάζει σε πάνω από έναν φορέα. Ο ταυτοποιητής αρνείται αντί να μαντέψει —
        ένα λάθος «Ηράκλειο» θα μετρούσε τις αποφάσεις της Ηράκλειας Σερρών.</li>
    </ul>
    <div class="pills">{unmatched}</div>
  </section>

  <section>
    <div class="head">
      <span class="eyebrow">05 · Το επόμενο βήμα</span>
      <h2>Οι τιμές ακινήτων θέλουν τον δικό σας υπολογιστή</h2>
      <p class="lede">Οι πύλες αγγελιών απορρίπτουν τα αιτήματα αυτού του διακομιστή στο
        επίπεδο του CDN — απάντηση 403 πριν καν φτάσει το αίτημα στον ιστότοπο. Το ίδιο
        εργαλείο τρέχει κανονικά από οικιακή σύνδεση. Οι όροι χρήσης επιτρέπουν ρητά την
        προσωπική χρήση των δεδομένων και απαγορεύουν την αναδημοσίευσή τους: τα
        αποτελέσματα της σάρωσης μένουν τοπικά, σε αντίθεση με αυτή τη σελίδα, που
        στηρίζεται αποκλειστικά σε ανοιχτά δημόσια δεδομένα.</p>
    </div>
    <pre>{esc(command)}</pre>
  </section>

  <footer>
    <span>Πηγές: Eurostat (tour_occ_nin2, ελεύθερη χρήση με αναφορά πηγής) ·
      Διαύγεια diavgeia.gov.gr (ανοικτά δεδομένα δημόσιου τομέα).</span>
    <span>Οι αριθμοί είναι μοντέλο και κατάταξη, όχι εκτίμηση αξίας. Πριν από κάθε
      δέσμευση: αυτοψία, έλεγχος τίτλων και βαρών, πολεοδομικός και τεχνικός έλεγχος.</span>
  </footer>
</div>
"""


def main(argv: Optional[Sequence[str]] = None) -> int:
    ensure_utf8()
    parser = argparse.ArgumentParser(
        prog="akinita.ethniki",
        description="Εθνικός χάρτης ευκαιριών από ανοιχτά δεδομένα.")
    parser.add_argument("--out", default="out/chartis.html", help="Αρχείο HTML")
    parser.add_argument("--json-out", default="", help="Προαιρετικά, τα δεδομένα ως JSON")
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument("--cache-hours", type=float, default=24.0)
    args = parser.parse_args(argv)

    import os
    fetcher = PoliteFetcher(delay=args.delay, verbose=False, cache_ttl_hours=args.cache_hours)
    data = collect(fetcher)

    directory = os.path.dirname(os.path.abspath(args.out))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(render(data))
    print(f"  ✓ {args.out}")
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=1)
        print(f"  ✓ {args.json_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
