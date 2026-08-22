# -*- coding: utf-8 -*-
"""
The results page: every property the run produced, on one screen.

`report.py` printed a fixed top-N. This renders the whole run - all property
types, all of Greece, every plan considered and every plan refused - and lets
the reader filter and re-sort it in the browser instead of re-running the crawl.

Design notes that are decisions, not defaults:

* Property type is a text chip, never a colour. Four types would need a
  CVD-validated categorical palette to be told apart by hue, and a label is
  both cheaper and readable to everyone.
* One accent hue carries every magnitude bar, because they all measure the same
  thing (0-100). Colour changes only for status - a negative stressed return, a
  fragile plan - and always alongside the number it describes.
* The distribution chart is bars because the job is magnitude across bins. It
  is the one chart on the page; the rest of the data is a list, because a list
  is what you act on.
"""
from __future__ import annotations

import datetime as _dt
import html
import json
import os
from typing import Dict, List, Optional, Sequence

from .indicators import INDICATOR_LABELS_EL, INDICATOR_SHORT_EL
from .models import ScoredListing
from .sources import ITEM_TYPE_LABELS_EL


def _payload(scored: Sequence[ScoredListing], analysis: Dict[str, dict],
             full_detail: int = 150) -> List[dict]:
    """Every listing, with full plan detail for the leaders and a summary for the rest.

    A national run can return thousands of properties; embedding twelve fully
    annotated plans for every one of them would produce a file too big to open.
    The leaders carry everything, the tail carries its verdict, and the tail can
    be re-analysed one property at a time with `damasol.analyse`.
    """
    rows: List[dict] = []
    for position, item in enumerate(scored, 1):
        found = analysis.get(item.listing.listing_id)
        if not found:
            continue
        listing = item.listing
        best = found["best"]
        valuation = found["valuation"]
        indicators = best.indicators
        detailed = position <= full_detail

        row = {
            "rank": position,
            "id": listing.listing_id,
            "src": listing.source,
            "price": listing.price,
            "size": listing.size_sqm,
            "ppsm": listing.price_per_sqm,
            "type": listing.item_type,
            "area": listing.sub_area or listing.address or "",
            "region": listing.area_name or "",
            "year": listing.construction_year,
            "url": listing.url,
            "value": valuation.open_market,
            "immediate": valuation.immediate,
            "conf": valuation.confidence_pct,
            "plan": best.name,
            "cat": best.category,
            "capital": best.capital_required,
            "profit": best.net_profit,
            "roi": best.annualised_roi_pct,
            "stressed": best.annualised_roi_stressed_pct,
            "months": best.months_to_exit,
            "income": best.annual_net_income,
            "viable": found["viable"],
            "ret": round(indicators.ret),
            "certainty": round(indicators.certainty),
            "speed": round(indicators.speed),
            "cap": round(indicators.capital),
            "ease": round(indicators.ease),
            "risk": round(indicators.risk),
            "score": round(indicators.combined, 1),
        }
        if detailed:
            row["alts"] = [
                {"name": o.name, "capital": o.capital_required, "profit": o.net_profit,
                 "roi": o.annualised_roi_pct, "stressed": o.annualised_roi_stressed_pct,
                 "months": o.months_to_exit, "certainty": round(o.indicators.certainty)}
                for o in found["outcomes"] if o.feasible
            ][:8]
            seen, blocked = set(), []
            for outcome in found["outcomes"]:
                if outcome.feasible or not outcome.blockers:
                    continue
                reason = outcome.blockers[0]
                if reason in seen:
                    continue
                seen.add(reason)
                blocked.append({"name": outcome.name, "why": reason})
            row["blocked"] = blocked[:5]
            row["factors"] = [
                {"name": n, "effect": e, "why": w, "src": s}
                for n, e, w, s in valuation.factor_table()
            ]
            row["flags"] = item.flags[:3]
            row["notes"] = best.assumptions[:4]
        rows.append(row)
    return rows


def write_dashboard(scored: Sequence[ScoredListing], analysis: Dict[str, dict],
                    path: str, meta: Optional[dict] = None,
                    full_detail: int = 150) -> str:
    meta = meta or {}
    rows = _payload(scored, analysis, full_detail)
    data = {
        "generated": _dt.datetime.now().strftime("%d/%m/%Y %H:%M"),
        "meta": {
            "sources": meta.get("sources", []),
            "scope": meta.get("scope", "Όλη η Ελλάδα"),
            "maxPrice": meta.get("max_price"),
            "types": meta.get("item_types", []),
            "scanned": meta.get("scanned", 0),
            "shortlisted": meta.get("shortlisted", 0),
            "valued": meta.get("valued", len(rows)),
            "fullDetail": full_detail,
        },
        "typeLabels": ITEM_TYPE_LABELS_EL,
        "indicatorLabels": INDICATOR_LABELS_EL,
        "indicatorShort": INDICATOR_SHORT_EL,
        "items": rows,
    }
    document = _TEMPLATE.replace("__DATA__", json.dumps(data, ensure_ascii=False))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(document)
    return path


_TEMPLATE = r"""<title>Ευκαιρίες Ακινήτων</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Literata:opsz,wght@7..72,400;7..72,600&family=Noto+Sans+Mono:wght@400;600&display=swap&subset=greek,latin">
<style>
  :root{
    --ground:#ECEEF1; --surface:#FFFFFF; --raised:#F5F7F9; --sunken:#E1E5EB;
    --ink:#171A1F; --muted:#586170; --faint:#8B94A3;
    --line:#D5DAE2; --hair:#E6E9EE;
    --accent:#2E3A8C; --accent-soft:#E2E5F4;
    --good:#2F6B4A; --warn:#A34A2A; --warn-soft:#F5E9DE;
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
      --good:#6FBF93; --warn:#DB8B68; --warn-soft:#2E2318;
    }
  }
  :root[data-theme="dark"]{
    --ground:#101317; --surface:#181C22; --raised:#1E232A; --sunken:#0B0E12;
    --ink:#E7EBF0; --muted:#98A2B1; --faint:#6C7788;
    --line:#272D36; --hair:#20262E;
    --accent:#8B98E8; --accent-soft:#1C2140;
    --good:#6FBF93; --warn:#DB8B68; --warn-soft:#2E2318;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);
    font-family:var(--body);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .shell{max-width:1180px;margin:0 auto;padding:0 18px 80px}
  .col{max-width:700px}
  h1,h2,h3,.ui,th,button,select,input,summary,label{font-family:var(--ui)}
  h1{font-size:clamp(25px,4vw,36px);line-height:1.1;font-weight:700;letter-spacing:-.025em;margin:0}
  h2{font-size:19px;font-weight:600;letter-spacing:-.015em;margin:0 0 6px}
  p{margin:0 0 12px}
  a{color:var(--accent);text-underline-offset:3px}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}

  header.mast{padding:44px 0 22px;border-bottom:2px solid var(--ink)}
  .kicker{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;
    color:var(--muted);margin:0 0 10px;font-family:var(--ui)}
  .lede{font-size:16.5px;color:var(--muted);margin:12px 0 0;max-width:62ch}

  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;
    background:var(--line);border:1px solid var(--line);border-radius:3px;margin:20px 0 0;
    overflow:hidden}
  .tile{background:var(--surface);padding:12px 15px}
  .tile b{display:block;font-family:var(--mono);font-size:22px;font-weight:600;
    letter-spacing:-.02em;color:var(--accent);font-variant-numeric:tabular-nums}
  .tile span{display:block;font-family:var(--ui);font-size:11.5px;color:var(--muted);
    margin-top:2px;line-height:1.3}

  .note{border-left:3px solid var(--accent);background:var(--surface);padding:13px 16px;
    margin:18px 0 0;font-size:14.5px;border-radius:0 3px 3px 0}
  .note.warn{border-left-color:var(--warn)}
  .note.warn strong{color:var(--warn)}
  .note p:last-child{margin-bottom:0}

  /* distribution: magnitude across bins, one hue, recessive axis */
  .dist{background:var(--surface);border:1px solid var(--line);border-radius:3px;
    padding:15px 17px;margin:20px 0 0}
  .dist h3{font-size:12px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;
    color:var(--muted);margin:0 0 12px}
  .plot{display:flex;align-items:flex-end;gap:2px;height:92px;
    border-bottom:1px solid var(--line);padding-bottom:0}
  .plot .bin{flex:1;display:flex;flex-direction:column;justify-content:flex-end;
    height:100%;position:relative;cursor:default}
  .plot .bin i{display:block;background:var(--accent);border-radius:4px 4px 0 0;min-height:2px}
  .plot .bin:hover i{background:var(--ink)}
  .plot .bin .tip{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);
    background:var(--ink);color:var(--surface);font-family:var(--ui);font-size:11.5px;
    padding:4px 8px;border-radius:3px;white-space:nowrap;opacity:0;pointer-events:none;
    transition:opacity .12s;margin-bottom:5px;z-index:5}
  .plot .bin:hover .tip{opacity:1}
  .axis{display:flex;gap:2px;margin-top:5px}
  .axis span{flex:1;text-align:center;font-family:var(--mono);font-size:10px;color:var(--faint)}

  .controls{position:sticky;top:0;z-index:20;background:var(--ground);
    padding:14px 0 12px;margin:22px 0 0;border-bottom:1px solid var(--line);
    display:flex;flex-wrap:wrap;gap:9px;align-items:center}
  .controls label{font-size:11.5px;font-weight:600;color:var(--muted);margin-right:3px}
  select,input[type=search]{font-family:var(--ui);font-size:13px;background:var(--surface);
    color:var(--ink);border:1px solid var(--line);border-radius:3px;padding:6px 9px}
  input[type=search]{min-width:170px}
  .chip{font-family:var(--ui);font-size:12.5px;background:var(--surface);color:var(--ink);
    border:1px solid var(--line);border-radius:99px;padding:5px 12px;cursor:pointer}
  .chip.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);
    font-weight:600}
  .count{margin-left:auto;font-family:var(--mono);font-size:12.5px;color:var(--muted)}

  .item{background:var(--surface);border:1px solid var(--line);border-radius:4px;
    margin-bottom:8px;overflow:hidden}
  .item.top{border-color:var(--accent)}
  .head{display:grid;grid-template-columns:32px 1fr auto;gap:12px;align-items:start;
    padding:13px 15px;cursor:pointer;list-style:none}
  .head::-webkit-details-marker{display:none}
  .rank{font-family:var(--mono);font-size:15px;font-weight:600;color:var(--faint);text-align:right}
  .item.top .rank{color:var(--accent)}
  .who h3{font-size:15.5px;font-weight:600;margin:0 0 2px}
  .kind{font-family:var(--mono);font-size:10.5px;background:var(--raised);color:var(--muted);
    border:1px solid var(--hair);border-radius:2px;padding:1px 6px;margin-left:7px;
    vertical-align:2px}
  .where{font-family:var(--ui);font-size:12.5px;color:var(--muted)}
  .plan{font-family:var(--ui);font-size:13px;color:var(--accent);font-weight:500;margin-top:5px}
  .nums{text-align:right;white-space:nowrap}
  .nums .big{font-family:var(--mono);font-size:18px;font-weight:600;
    font-variant-numeric:tabular-nums;display:block}
  .nums .small{font-family:var(--mono);font-size:11px;color:var(--muted);display:block;margin-top:1px}
  .nums .small.bad{color:var(--warn)}

  .bars{display:flex;gap:3px;margin-top:8px;flex-wrap:wrap}
  .bar{flex:1;min-width:58px}
  .bar span{display:block;font-family:var(--ui);font-size:9px;letter-spacing:.04em;
    text-transform:uppercase;color:var(--faint);margin-bottom:3px}
  .bar i{display:block;height:5px;background:var(--sunken);border-radius:2px;position:relative}
  .bar i b{position:absolute;left:0;top:0;bottom:0;background:var(--accent);border-radius:2px}
  .bar i b.low{background:var(--warn)}

  .detail{padding:0 15px 14px 59px;border-top:1px solid var(--hair)}
  .detail h4{font-family:var(--ui);font-size:10.5px;font-weight:600;letter-spacing:.08em;
    text-transform:uppercase;color:var(--muted);margin:14px 0 6px}
  .tw{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:12.5px}
  th,td{padding:5px 9px;text-align:left;border-bottom:1px solid var(--hair)}
  th{font-family:var(--ui);font-size:9.5px;font-weight:600;letter-spacing:.06em;
    text-transform:uppercase;color:var(--muted);white-space:nowrap}
  td.n,th.n{text-align:right;font-family:var(--mono);font-size:11.5px;
    font-variant-numeric:tabular-nums;white-space:nowrap}
  tr:last-child td{border-bottom:0}
  .why{font-size:12.5px;color:var(--muted);margin:2px 0}
  .why b{color:var(--ink);font-weight:600}
  .flag{color:var(--warn);font-size:12.5px;margin:2px 0}
  .open{display:inline-block;margin-top:11px;font-family:var(--ui);font-size:12.5px;
    font-weight:600;text-decoration:none}
  .more{text-align:center;padding:16px}
  .more button{font-family:var(--ui);font-size:13px;font-weight:600;background:var(--surface);
    color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:8px 20px;
    cursor:pointer}
  .empty{padding:36px;text-align:center;color:var(--muted)}
  footer{padding:32px 0 0;font-family:var(--ui);font-size:12.5px;color:var(--faint)}
</style>

<div class="shell">
<header class="mast">
  <div class="col">
    <p class="kicker">Damasol Limited · Αποτελέσματα σάρωσης</p>
    <h1 id="title">Ευκαιρίες ακινήτων</h1>
    <p class="lede" id="lede"></p>
  </div>
  <div class="tiles" id="tiles"></div>
</header>

<section>
  <div class="dist" id="dist"></div>
  <div class="col"><div class="note" id="legend"></div></div>
</section>

<div class="controls">
  <label for="f-type">Τύπος</label><select id="f-type"></select>
  <label for="f-region">Περιοχή</label><select id="f-region"></select>
  <label for="f-sort">Κατάταξη</label><select id="f-sort"></select>
  <input type="search" id="f-text" placeholder="Αναζήτηση περιοχής…">
  <button class="chip" id="f-solid">Μόνο ανθεκτικά</button>
  <button class="chip" id="f-positive">Θετικά στη φούσκα</button>
  <span class="count" id="count"></span>
</div>

<section id="list"></section>
<div class="more" id="more"></div>

<footer class="col" id="foot"></footer>
</div>

<script>
const D = __DATA__;
const gr = n => (n === null || n === undefined || Number.isNaN(n)) ? "—"
  : Math.round(n).toLocaleString("el-GR");
const pct = n => (n === null || n === undefined) ? "—" : (n > 0 ? "+" : "") + n.toFixed(1) + "%";
const el = id => document.getElementById(id);

document.title = "Ευκαιρίες Ακινήτων";
el("title").textContent = D.meta.scope === "Όλη η Ελλάδα"
  ? "Ευκαιρίες σε όλη την Ελλάδα" : "Ευκαιρίες · " + D.meta.scope;
el("lede").textContent =
  `Κάθε ακίνητο περασμένο από κάθε τρόπο αξιοποίησης, τιμολογημένο με πλήρες ελληνικό `
  + `κόστος, και κατατεταγμένο σε αυτό που αντέχει. Πηγές: `
  + (D.meta.sources.join(", ") || "—") + ` · έως ` + gr(D.meta.maxPrice) + ` € · `
  + D.generated;

el("tiles").innerHTML = [
  [D.meta.scanned, "αγγελίες σαρώθηκαν"],
  [D.meta.shortlisted, "μπήκαν σε ανάλυση"],
  [D.items.length, "με εφικτό πλάνο"],
  [D.meta.types.map(t => D.typeLabels[t] || t).length, "τύποι ακινήτων"],
  [D.items.length ? Math.max(...D.items.map(i => i.viable)) : 0, "πλάνα ανά ακίνητο"],
].map(([v, l]) => `<div class="tile"><b>${gr(v)}</b><span>${l}</span></div>`).join("");

el("legend").innerHTML =
  `<p><strong>Πώς διαβάζονται οι αριθμοί.</strong> Ο μεγάλος αριθμός δεξιά είναι η
   <b>απόδοση με τα νούμερα της αγγελίας</b>. Από κάτω, η <b>ίδια απόδοση αν οι τιμές
   αποδειχθούν φουσκωμένες</b> — τιμές πώλησης 20% χαμηλότερα, ενοίκια 15%. Οι έξι
   μπάρες είναι: `
  + Object.keys(D.indicatorLabels).map(k =>
      `<b>${D.indicatorShort[k]}</b> ${D.indicatorLabels[k].toLowerCase()}`).join(" · ")
  + `.</p>`;

/* ---- distribution of annual return, magnitude across bins ---- */
const BINS = [[-100, 0, "<0"], [0, 3, "0–3"], [3, 6, "3–6"], [6, 9, "6–9"],
              [9, 12, "9–12"], [12, 18, "12–18"], [18, 25, "18–25"], [25, 1e9, "25+"]];
{
  const counts = BINS.map(([lo, hi]) =>
    D.items.filter(i => i.roi >= lo && i.roi < hi).length);
  const peak = Math.max(1, ...counts);
  el("dist").innerHTML = `<h3>Κατανομή ετήσιας απόδοσης — ${D.items.length} ακίνητα</h3>
    <div class="plot">${counts.map((c, i) => `
      <span class="bin"><span class="tip">${BINS[i][2]}% · ${c} ακίνητα</span>
      <i style="height:${(c / peak * 100).toFixed(1)}%"></i></span>`).join("")}</div>
    <div class="axis">${BINS.map(b => `<span>${b[2]}</span>`).join("")}</div>`;
}

/* ---- filters ---- */
const SORTS = [
  ["score", "Συνολικό σκορ"], ["roi", "Απόδοση (αγγελία)"],
  ["stressed", "Απόδοση (φούσκα)"], ["certainty", "Αντοχή"],
  ["capital", "Λιγότερο κεφάλαιο"], ["profit", "Κέρδος σε ευρώ"],
  ["months", "Ταχύτερη έξοδος"], ["price", "Φθηνότερο"],
];
el("f-sort").innerHTML = SORTS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("");

const types = [...new Set(D.items.map(i => i.type))];
el("f-type").innerHTML = `<option value="">Όλοι (${D.items.length})</option>` + types.map(t =>
  `<option value="${t}">${D.typeLabels[t] || t} (${D.items.filter(i => i.type === t).length})</option>`
).join("");

const regions = [...new Set(D.items.map(i => i.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, "el"));
el("f-region").innerHTML = `<option value="">Όλες</option>` +
  regions.map(r => `<option value="${r}">${r}</option>`).join("");

const state = {type: "", region: "", sort: "score", text: "", solid: false, positive: false, shown: 40};

function filtered() {
  let list = D.items.filter(i =>
    (!state.type || i.type === state.type) &&
    (!state.region || i.region === state.region) &&
    (!state.solid || i.certainty >= 40) &&
    (!state.positive || i.stressed > 0) &&
    (!state.text || (i.area + " " + i.region).toLowerCase().includes(state.text.toLowerCase())));
  const key = state.sort;
  const ascending = key === "capital" || key === "months" || key === "price";
  list = [...list].sort((a, b) => {
    const va = key === "capital" ? a.capital : a[key];
    const vb = key === "capital" ? b.capital : b[key];
    return ascending ? va - vb : vb - va;
  });
  return list;
}

const AXES = [["ret", "ret"], ["certainty", "certainty"], ["speed", "speed"],
              ["cap", "capital"], ["ease", "ease"], ["risk", "risk"]];

function card(item, position) {
  const bars = AXES.map(([field, key]) => {
    const v = item[field];
    return `<span class="bar"><span>${D.indicatorShort[key]} ${v}</span>
      <i><b class="${v < 35 ? "low" : ""}" style="width:${Math.max(2, v)}%"></b></i></span>`;
  }).join("");

  const alts = (item.alts || []).map(a => `<tr><td>${a.name}</td>
      <td class="n">${gr(a.capital)} €</td><td class="n">${gr(a.profit)} €</td>
      <td class="n">${pct(a.roi)}</td>
      <td class="n" style="color:${a.stressed < 1 ? "var(--warn)" : "var(--good)"}">${pct(a.stressed)}</td>
      <td class="n">${a.months}</td><td class="n">${a.certainty}</td></tr>`).join("");
  const factors = (item.factors || []).map(f => `<tr><td>${f.name}</td>
      <td class="n">${f.effect}</td><td>${f.why}</td><td>${f.src}</td></tr>`).join("");
  const blocked = (item.blocked || []).map(b =>
    `<p class="why"><b>${b.name}</b> — ${b.why}</p>`).join("");
  const flags = (item.flags || []).map(f => `<p class="flag">⚠ ${f}</p>`).join("");
  const notes = (item.notes || []).map(n => `<p class="why">· ${n}</p>`).join("");

  const detail = item.alts ? `<div class="detail">
      <h4>Αποτίμηση</h4>
      <p class="why">Αξία ανοιχτής αγοράς <b>${gr(item.value)} €</b> ·
        άμεση ρευστοποίηση <b>${gr(item.immediate)} €</b> ·
        εμπιστοσύνη <b>${Math.round(item.conf)}%</b>
        ${item.income ? ` · καθαρό εισόδημα <b>${gr(item.income)} €/έτος</b>` : ""}</p>
      ${factors ? `<div class="tw"><table><thead><tr><th>Συντελεστής</th>
        <th class="n">Επίδραση</th><th>Αιτιολογία</th><th>Πηγή</th></tr></thead>
        <tbody>${factors}</tbody></table></div>` : ""}
      ${flags}
      <h4>Οι εναλλακτικές που εξετάστηκαν</h4>
      <div class="tw"><table><thead><tr><th>Πλάνο</th><th class="n">Κεφάλαιο</th>
        <th class="n">Κέρδος</th><th class="n">Αγγελία</th><th class="n">Φούσκα</th>
        <th class="n">Μήνες</th><th class="n">Αντοχή</th></tr></thead>
        <tbody>${alts}</tbody></table></div>
      ${notes ? `<h4>Παραδοχές του κορυφαίου πλάνου</h4>${notes}` : ""}
      ${blocked ? `<h4>Δεν γίνονται, και γιατί</h4>${blocked}` : ""}
      ${item.url ? `<a class="open" href="${item.url}" target="_blank" rel="noopener">Άνοιγμα αγγελίας →</a>` : ""}
    </div>` : `<div class="detail"><p class="why">Πλήρης ανάλυση για τα πρώτα
      ${D.meta.fullDetail}. Για αυτό:
      <code>python -m damasol.analyse --from-json &lt;αρχείο&gt;.json --rank ${item.rank}</code></p>
      ${item.url ? `<a class="open" href="${item.url}" target="_blank" rel="noopener">Άνοιγμα αγγελίας →</a>` : ""}</div>`;

  return `<details class="item${position === 1 ? " top" : ""}">
    <summary class="head">
      <span class="rank">${position}</span>
      <span class="who">
        <h3>${gr(item.price)} € · ${gr(item.size)} τ.μ.
          <span class="kind">${D.typeLabels[item.type] || item.type}</span></h3>
        <span class="where">${item.area}${item.year ? " · " + item.year : ""}
          ${item.ppsm ? " · " + gr(item.ppsm) + " €/τ.μ." : ""}</span>
        <span class="plan">→ ${item.plan}</span>
        <span class="bars">${bars}</span>
      </span>
      <span class="nums">
        <b class="big">${pct(item.roi)}</b>
        <span class="small ${item.stressed < 1 ? "bad" : ""}">αν φουσκωμένες ${pct(item.stressed)}</span>
        <span class="small">κεφάλαιο ${gr(item.capital)} €</span>
        <span class="small">κέρδος ${gr(item.profit)} €</span>
      </span>
    </summary>${detail}</details>`;
}

function render() {
  const list = filtered();
  const slice = list.slice(0, state.shown);
  el("list").innerHTML = slice.length
    ? slice.map((item, i) => card(item, i + 1)).join("")
    : `<p class="empty">Κανένα ακίνητο με αυτά τα φίλτρα.</p>`;
  el("count").textContent = `${list.length} από ${D.items.length}`;
  el("more").innerHTML = list.length > state.shown
    ? `<button id="more-btn">Δείξε άλλα ${Math.min(40, list.length - state.shown)}
       (απομένουν ${list.length - state.shown})</button>` : "";
  const btn = el("more-btn");
  if (btn) btn.addEventListener("click", () => { state.shown += 40; render(); });
}

el("f-type").addEventListener("change", e => { state.type = e.target.value; state.shown = 40; render(); });
el("f-region").addEventListener("change", e => { state.region = e.target.value; state.shown = 40; render(); });
el("f-sort").addEventListener("change", e => { state.sort = e.target.value; state.shown = 40; render(); });
el("f-text").addEventListener("input", e => { state.text = e.target.value; state.shown = 40; render(); });
el("f-solid").addEventListener("click", e => {
  state.solid = !state.solid; e.target.classList.toggle("on", state.solid); state.shown = 40; render();
});
el("f-positive").addEventListener("click", e => {
  state.positive = !state.positive; e.target.classList.toggle("on", state.positive); state.shown = 40; render();
});

el("foot").innerHTML = `Damasol Limited · Έξοδος μοντέλου, όχι εκτίμηση αξίας ούτε
  επενδυτική συμβουλή. Πριν από κάθε δέσμευση: αυτοψία, έλεγχος τίτλων και βαρών,
  πολεοδομικός έλεγχος, τεχνική αξιολόγηση.`;

render();
</script>
"""
