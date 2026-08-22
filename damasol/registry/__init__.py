# -*- coding: utf-8 -*-
"""
Two registries, one audit.

`ideas.yml`       every signal we think might predict value, whether or not it
                  is built. This is where a thought goes the day someone has it.
`mechanisms.yml`  every mechanism actually running in the system, pointing at
                  real code.

The pair is only useful if it stays honest, which is what `audit` is for: it
checks that every mechanism points at code that exists, that every idea marked
implemented really has a mechanism, and - the one that catches real drift - that
the weights written in the registry still match the weights in `scoring.py`.
Documentation that cannot be wrong is documentation worth reading.

    python -m damasol.registry audit
    python -m damasol.registry list --status idea
    python -m damasol.registry show SIG-008
    python -m damasol.registry add-idea --title "..." --hypothesis "..."
    python -m damasol.registry render > ΜΗΤΡΩΟ.md
"""
from __future__ import annotations

import dataclasses
import datetime as _dt
import os
import re
from typing import Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
IDEAS_PATH = os.path.join(HERE, "ideas.yml")
MECHANISMS_PATH = os.path.join(HERE, "mechanisms.yml")
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))

VALID_STATUS_IDEA = {"idea", "research", "prototype", "implemented", "rejected"}
VALID_STATUS_MECH = {"active", "experimental", "deprecated"}
VALID_FEASIBILITY = {"proven", "probable", "hard", "blocked"}

STATUS_LABEL_EL = {
    "idea": "ιδέα", "research": "έρευνα", "prototype": "πρωτότυπο",
    "implemented": "υλοποιημένο", "rejected": "απορρίφθηκε",
    "active": "ενεργός", "experimental": "πειραματικός", "deprecated": "καταργημένος",
}


def _load_yaml(path: str) -> dict:
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(
            "Το μητρώο χρειάζεται PyYAML: pip install pyyaml"
        ) from exc
    with open(path, encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def load_ideas(path: str = IDEAS_PATH) -> List[dict]:
    return _load_yaml(path).get("ideas", [])


def load_mechanisms(path: str = MECHANISMS_PATH) -> List[dict]:
    return _load_yaml(path).get("mechanisms", [])


# ------------------------------------------------------------------- audit


@dataclasses.dataclass
class AuditResult:
    errors: List[str] = dataclasses.field(default_factory=list)
    warnings: List[str] = dataclasses.field(default_factory=list)
    checks_run: int = 0

    @property
    def ok(self) -> bool:
        return not self.errors


def _entrypoint_exists(module_path: str, entrypoint: str) -> bool:
    """Is `entrypoint` (function, class, or Class.method) defined in the module?"""
    full = os.path.join(PROJECT_ROOT, module_path)
    if not os.path.exists(full):
        return False
    source = open(full, encoding="utf-8").read()
    name = entrypoint.split(".")[-1]
    return bool(re.search(rf"^\s*(?:def|class)\s+{re.escape(name)}\b", source, re.M))


def audit(ideas: Optional[List[dict]] = None,
          mechanisms: Optional[List[dict]] = None) -> AuditResult:
    ideas = load_ideas() if ideas is None else ideas
    mechanisms = load_mechanisms() if mechanisms is None else mechanisms
    result = AuditResult()

    idea_ids = {i.get("id") for i in ideas}
    mech_ids = {m.get("id") for m in mechanisms}

    result.checks_run += 1
    if len(idea_ids) != len(ideas):
        result.errors.append("Διπλότυπα id στο ideas.yml")
    if len(mech_ids) != len(mechanisms):
        result.errors.append("Διπλότυπα id στο mechanisms.yml")

    for idea in ideas:
        ident = idea.get("id", "?")
        result.checks_run += 1
        for field in ("title", "hypothesis", "status", "feasibility", "category"):
            if not idea.get(field):
                result.errors.append(f"{ident}: λείπει το πεδίο «{field}»")
        if idea.get("status") not in VALID_STATUS_IDEA:
            result.errors.append(f"{ident}: άκυρο status «{idea.get('status')}»")
        if idea.get("feasibility") not in VALID_FEASIBILITY:
            result.errors.append(f"{ident}: άκυρο feasibility «{idea.get('feasibility')}»")

        if idea.get("status") == "implemented":
            linked = idea.get("implemented_by")
            if not linked:
                result.errors.append(f"{ident}: υλοποιημένο αλλά χωρίς implemented_by")
            elif linked not in mech_ids:
                result.errors.append(f"{ident}: implemented_by «{linked}» δεν υπάρχει")
        elif idea.get("implemented_by"):
            result.warnings.append(
                f"{ident}: έχει implemented_by αλλά status «{idea.get('status')}»"
            )

    for mech in mechanisms:
        ident = mech.get("id", "?")
        result.checks_run += 1
        for field in ("title", "module", "entrypoint", "validation", "status"):
            if not mech.get(field):
                result.errors.append(f"{ident}: λείπει το πεδίο «{field}»")
        if mech.get("status") not in VALID_STATUS_MECH:
            result.errors.append(f"{ident}: άκυρο status «{mech.get('status')}»")

        implements = mech.get("implements")
        if implements and implements not in idea_ids:
            result.errors.append(f"{ident}: implements «{implements}» δεν υπάρχει στο ideas.yml")

        module = mech.get("module", "")
        if module and not os.path.exists(os.path.join(PROJECT_ROOT, module)):
            result.errors.append(f"{ident}: το αρχείο «{module}» δεν υπάρχει")
        elif module and mech.get("entrypoint"):
            if not _entrypoint_exists(module, mech["entrypoint"]):
                result.errors.append(
                    f"{ident}: το «{mech['entrypoint']}» δεν βρέθηκε στο {module}"
                )

    # The check that actually catches drift: registry weights vs. live code.
    result.checks_run += 1
    try:
        from ..scoring import DEFAULT_WEIGHTS

        declared: Dict[str, float] = {}
        for mech in mechanisms:
            axis = mech.get("feeds_score")
            weight = float(mech.get("weight") or 0)
            if axis in DEFAULT_WEIGHTS and weight:
                declared[axis] = declared.get(axis, 0.0) + weight
        for axis, weight in DEFAULT_WEIGHTS.items():
            registered = declared.get(axis)
            if registered is None:
                result.warnings.append(f"Ο άξονας «{axis}» δεν έχει μηχανισμό στο μητρώο")
            elif abs(registered - weight) > 1e-6:
                result.errors.append(
                    f"Απόκλιση βάρους «{axis}»: μητρώο {registered} vs κώδικας {weight}"
                )
        total = sum(declared.values())
        if declared and abs(total - 1.0) > 1e-6:
            result.errors.append(f"Τα βάρη του μητρώου αθροίζουν {total}, όχι 1.0")
    except ImportError:
        result.warnings.append("Δεν έγινε διασταύρωση βαρών (scoring.py μη διαθέσιμο)")

    return result


# ------------------------------------------------------------------ writing


def next_id(entries: List[dict], prefix: str) -> str:
    numbers = [
        int(match.group(1))
        for entry in entries
        if (match := re.match(rf"{prefix}-(\d+)$", entry.get("id", "")))
    ]
    return f"{prefix}-{max(numbers, default=0) + 1:03d}"


def add_idea(title: str, hypothesis: str, category: str = "ζήτηση",
             horizon: str = "immediate", feasibility: str = "probable",
             source_name: str = "", source_url: str = "",
             path: str = IDEAS_PATH) -> str:
    """Append a new idea. Written as text so the file keeps its comments."""
    ideas = load_ideas(path)
    ident = next_id(ideas, "SIG")
    today = _dt.date.today().isoformat()
    block = f"""
  - id: {ident}
    title: {title}
    hypothesis: >-
      {hypothesis}
    category: {category}
    horizon: {horizon}
    affects: []
    source:
      name: {source_name or '""'}
      url: {source_url or '""'}
      access: ""
      licence: ""
    feasibility: {feasibility}
    effort: ""
    expected_lift: ""
    status: idea
    notes: "Προστέθηκε {today}."
"""
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(block)
    return ident


# ---------------------------------------------------------------- rendering


def render_markdown(ideas: Optional[List[dict]] = None,
                    mechanisms: Optional[List[dict]] = None) -> str:
    ideas = load_ideas() if ideas is None else ideas
    mechanisms = load_mechanisms() if mechanisms is None else mechanisms
    lines = ["# Μητρώο σημάτων & μηχανισμών", ""]

    lines += ["## Υλοποιημένοι μηχανισμοί", "",
              "| id | Μηχανισμός | Άξονας | Βάρος | Κατάσταση | Κώδικας |",
              "|---|---|---|---|---|---|"]
    for mech in mechanisms:
        weight = f"{mech.get('weight', 0):.0%}" if mech.get("weight") else "—"
        lines.append(
            f"| {mech['id']} | {mech['title']} | {mech.get('feeds_score', '—')} | "
            f"{weight} | {STATUS_LABEL_EL.get(mech.get('status'), mech.get('status'))} | "
            f"`{mech.get('module', '')}` |"
        )

    lines += ["", "## Ιδέες σημάτων", ""]
    by_status: Dict[str, List[dict]] = {}
    for idea in ideas:
        by_status.setdefault(idea.get("status", "idea"), []).append(idea)
    for status in ("implemented", "prototype", "research", "idea", "rejected"):
        group = by_status.get(status)
        if not group:
            continue
        lines += [f"### {STATUS_LABEL_EL.get(status, status)} ({len(group)})", ""]
        for idea in group:
            lines.append(
                f"- **{idea['id']} · {idea['title']}** "
                f"_(εφικτότητα: {idea.get('feasibility')}, ορίζοντας: {idea.get('horizon')})_"
            )
            lines.append(f"  - {(idea.get('hypothesis') or '').strip()}")
            if idea.get("notes"):
                lines.append(f"  - ⚑ {idea['notes'].strip()}")
        lines.append("")
    return "\n".join(lines)
