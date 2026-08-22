"""Standalone HTML report for a scored shortlist (Greek, print-friendly)."""
from __future__ import annotations

import datetime as _dt
import html
import os
from typing import Dict, Optional, Sequence

from .models import ScoredListing
from .scoring import COMPONENT_LABELS_EL

GRADE_COLOURS = {
    "A+": "#0f9d58",
    "A": "#3fa34d",
    "B": "#c9a227",
    "C": "#d9822b",
    "D": "#b3402f",
}

ITEM_TYPE_EL = {
    "residence": "Κατοικία",
    "prof": "Επαγγελματικός χώρος",
    "land": "Γη / Οικόπεδο",
    "parking": "Parking",
}


def _gr(value: Optional[float], decimals: int = 0, suffix: str = "") -> str:
    if value is None:
        return "—"
    formatted = f"{value:,.{decimals}f}"
    formatted = formatted.replace(",", "\x00").replace(".", ",").replace("\x00", ".")
    return formatted + suffix


def _esc(value) -> str:
    return html.escape(str(value or ""))


def _card(position: int, scored: ScoredListing) -> str:
    listing = scored.listing
    colour = GRADE_COLOURS.get(scored.grade, "#666")

    bars = "".join(
        f'<div class="bar-row"><span class="bar-label">{_esc(COMPONENT_LABELS_EL.get(k, k))}</span>'
        f'<span class="bar-track"><span class="bar-fill" style="width:{v:.0f}%"></span></span>'
        f'<span class="bar-value">{v:.0f}</span></div>'
        for k, v in scored.components.items()
    )
    evidence = "".join(f"<li>{_esc(e)}</li>" for e in scored.evidence)
    flags = "".join(f"<li>{_esc(f)}</li>" for f in scored.flags)

    facts = [
        ("Τίμημα", _gr(listing.price, 0, " €")),
        ("Εμβαδόν", _gr(listing.size_sqm, 0, " τ.μ.")),
        ("€/τ.μ.", _gr(listing.price_per_sqm, 0)),
        ("Διάμεσος περιοχής", _gr(scored.market_price_per_sqm, 0, " €/τ.μ.")),
        ("Έκπτωση", _gr(scored.discount_pct, 1, "%")),
        ("Εκτ. ενοίκιο", _gr(scored.est_monthly_rent, 0, " €/μήνα")),
        ("Μεικτή απόδοση", _gr(scored.gross_yield_pct, 1, "%")),
        ("Έτος", _esc(listing.construction_year or "—")),
    ]
    fact_html = "".join(
        f'<div class="fact"><dt>{label}</dt><dd>{value}</dd></div>' for label, value in facts
    )

    return f"""
<article class="card">
  <header class="card-head">
    <span class="rank">#{position}</span>
    <span class="grade" style="background:{colour}">{_esc(scored.grade)} · {scored.score:.1f}</span>
    <div class="headline">
      <h3>{_esc(listing.title or 'Ακίνητο')}</h3>
      <p class="where">{_esc(listing.address or '—')} · {_esc(ITEM_TYPE_EL.get(listing.item_type, listing.item_type))}</p>
    </div>
  </header>
  <dl class="facts">{fact_html}</dl>
  <div class="split">
    <div class="bars">{bars}</div>
    <div class="notes">
      <h4>Γιατί ξεχωρίζει</h4>
      <ul class="evidence">{evidence or '<li>—</li>'}</ul>
      {'<h4 class="risk">Σημεία ελέγχου</h4><ul class="flags">' + flags + '</ul>' if flags else ''}
    </div>
  </div>
  <footer><a href="{_esc(listing.url)}" target="_blank" rel="noopener">Άνοιγμα αγγελίας →</a>
  <span class="src">{_esc(listing.source)} · ID {_esc(listing.listing_id)}</span></footer>
</article>"""


def write_html_report(
    scored: Sequence[ScoredListing], path: str, meta: Optional[Dict] = None
) -> str:
    meta = meta or {}
    generated = _dt.datetime.now().strftime("%d/%m/%Y %H:%M")
    grades: Dict[str, int] = {}
    for item in scored:
        grades[item.grade] = grades.get(item.grade, 0) + 1
    grade_chips = "".join(
        f'<span class="chip" style="border-color:{GRADE_COLOURS.get(g, "#666")}">'
        f'{g}: <b>{n}</b></span>'
        for g, n in sorted(grades.items())
    )
    weight_rows = "".join(
        f"<li>{_esc(COMPONENT_LABELS_EL.get(k, k))}: <b>{v * 100:.0f}%</b></li>"
        for k, v in (meta.get("weights") or {}).items()
    )
    cards = "".join(_card(i, s) for i, s in enumerate(scored, 1))

    document = f"""<!doctype html>
<html lang="el"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ευκαιρίες Ακινήτων</title>
<style>
  :root {{
    --bg:#f6f7f9; --panel:#ffffff; --ink:#16181d; --muted:#5f6672;
    --line:#e3e6ea; --accent:#1f4e79;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#0f1216; --panel:#171b21; --ink:#e9ecf1; --muted:#9aa3b0;
             --line:#262c35; --accent:#6ea8dc; }}
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.55 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif; }}
  .wrap {{ max-width:1080px; margin:0 auto; padding:32px 20px 64px; }}
  header.top {{ border-bottom:2px solid var(--accent); padding-bottom:18px; margin-bottom:28px; }}
  header.top h1 {{ margin:0 0 4px; font-size:26px; letter-spacing:-.02em; }}
  header.top p {{ margin:0; color:var(--muted); font-size:14px; }}
  .summary {{ display:flex; flex-wrap:wrap; gap:10px; margin:18px 0 6px; }}
  .chip {{ border:2px solid; border-radius:999px; padding:3px 12px; font-size:13px; }}
  .method {{ background:var(--panel); border:1px solid var(--line); border-radius:10px;
    padding:14px 18px; margin:18px 0 30px; }}
  .method h2 {{ margin:0 0 8px; font-size:15px; }}
  .method ul {{ margin:0; padding-left:20px; color:var(--muted); font-size:13.5px;
    columns:2; column-gap:28px; }}
  .card {{ background:var(--panel); border:1px solid var(--line); border-radius:12px;
    padding:18px; margin-bottom:18px; }}
  .card-head {{ display:flex; gap:12px; align-items:flex-start; }}
  .rank {{ font-size:20px; font-weight:700; color:var(--muted); min-width:44px; }}
  .grade {{ color:#fff; border-radius:8px; padding:5px 11px; font-weight:700;
    font-size:13px; white-space:nowrap; }}
  .headline h3 {{ margin:0; font-size:17px; }}
  .where {{ margin:2px 0 0; color:var(--muted); font-size:13.5px; }}
  .facts {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(128px,1fr));
    gap:10px; margin:16px 0; padding:14px 0; border-top:1px solid var(--line);
    border-bottom:1px solid var(--line); }}
  .fact dt {{ color:var(--muted); font-size:11.5px; text-transform:uppercase;
    letter-spacing:.05em; }}
  .fact dd {{ margin:2px 0 0; font-weight:600; font-size:15px; }}
  .split {{ display:grid; grid-template-columns:minmax(240px,1fr) 1.4fr; gap:22px; }}
  @media (max-width:760px) {{ .split {{ grid-template-columns:1fr; }}
    .method ul {{ columns:1; }} }}
  .bar-row {{ display:grid; grid-template-columns:118px 1fr 30px; gap:8px;
    align-items:center; margin-bottom:6px; font-size:12.5px; }}
  .bar-label {{ color:var(--muted); }}
  .bar-track {{ background:var(--line); border-radius:4px; height:8px; overflow:hidden; }}
  .bar-fill {{ display:block; height:100%; background:var(--accent); }}
  .bar-value {{ text-align:right; font-variant-numeric:tabular-nums; color:var(--muted); }}
  .notes h4 {{ margin:0 0 6px; font-size:13px; text-transform:uppercase;
    letter-spacing:.05em; color:var(--muted); }}
  .notes h4.risk {{ margin-top:12px; color:#c0602c; }}
  .notes ul {{ margin:0; padding-left:18px; font-size:13.5px; }}
  .notes .flags li {{ color:#c0602c; }}
  footer {{ display:flex; justify-content:space-between; align-items:center;
    margin-top:14px; padding-top:12px; border-top:1px solid var(--line); font-size:13px; }}
  footer a {{ color:var(--accent); font-weight:600; text-decoration:none; }}
  .src {{ color:var(--muted); font-size:12px; }}
  .disclaimer {{ margin-top:36px; padding:16px 18px; border-left:3px solid #c0602c;
    background:var(--panel); color:var(--muted); font-size:13px; border-radius:0 8px 8px 0; }}
</style></head><body><div class="wrap">
<header class="top">
  <h1>Ευκαιρίες Ακινήτων</h1>
  <p>Πηγή: {_esc(meta.get('source', '—'))} · Φίλτρα: {_esc(meta.get('transaction', ''))} ·
     {_esc(', '.join(ITEM_TYPE_EL.get(t, t) for t in meta.get('item_types', [])))} ·
     έως {_gr(meta.get('max_price'), 0, ' €')} · {_esc(meta.get('bbox', ''))}</p>
  <p>Σαρώθηκαν <b>{_esc(meta.get('candidates', '—'))}</b> αγγελίες ·
     Αναφορά: <b>{len(scored)}</b> ακίνητα · Δημιουργήθηκε {generated}</p>
  <div class="summary">{grade_chips}</div>
</header>

<section class="method">
  <h2>Πώς προκύπτει η βαθμολογία (0–100)</h2>
  <ul>{weight_rows or '<li>Προεπιλεγμένα βάρη</li>'}</ul>
</section>

{cards}

<p class="disclaimer"><b>Σημείωση.</b> Οι βαθμολογίες βασίζονται αποκλειστικά σε
δημοσιευμένα στοιχεία αγγελιών και σε συγκριτικά τιμών που υπολογίζονται από το
ίδιο δείγμα. Δεν αποτελούν εκτίμηση αξίας, ούτε επενδυτική συμβουλή. Πριν από
κάθε δέσμευση απαιτείται αυτοψία, νομικός έλεγχος τίτλων και βαρών, πολεοδομικός
έλεγχος και τεχνική αξιολόγηση.</p>
</div></body></html>"""

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(document)
    return path
