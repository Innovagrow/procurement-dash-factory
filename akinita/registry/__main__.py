# -*- coding: utf-8 -*-
"""CLI for the two registries: python -m akinita.registry <command>"""
from __future__ import annotations

import argparse
import sys
from typing import Optional, Sequence

from ..console import ensure_utf8
from . import (
    STATUS_LABEL_EL,
    add_idea,
    audit,
    load_ideas,
    load_mechanisms,
    render_markdown,
)


def _print_table(rows, headers, widths):
    line = "  ".join(h[:w].ljust(w) for h, w in zip(headers, widths))
    print(line)
    print("─" * len(line))
    for row in rows:
        print("  ".join(str(cell)[:w].ljust(w) for cell, w in zip(row, widths)))


def cmd_list(args) -> int:
    if args.what in ("ideas", "all"):
        ideas = load_ideas()
        if args.status:
            ideas = [i for i in ideas if i.get("status") == args.status]
        if args.category:
            ideas = [i for i in ideas if i.get("category") == args.category]
        print(f"\nΙΔΕΕΣ ΣΗΜΑΤΩΝ ({len(ideas)})\n")
        _print_table(
            [(i["id"], i["title"], i.get("category", ""),
              STATUS_LABEL_EL.get(i.get("status"), i.get("status")),
              i.get("feasibility", ""), i.get("expected_lift", ""))
             for i in ideas],
            ("id", "τίτλος", "κατηγορία", "κατάσταση", "εφικτότητα", "όφελος"),
            (9, 42, 16, 13, 11, 26),
        )
    if args.what in ("mechanisms", "all"):
        mechanisms = load_mechanisms()
        if args.status:
            mechanisms = [m for m in mechanisms if m.get("status") == args.status]
        print(f"\nΥΛΟΠΟΙΗΜΕΝΟΙ ΜΗΧΑΝΙΣΜΟΙ ({len(mechanisms)})\n")
        _print_table(
            [(m["id"], m["title"], m.get("feeds_score", "—"),
              f"{m.get('weight', 0):.0%}" if m.get("weight") else "—",
              STATUS_LABEL_EL.get(m.get("status"), m.get("status")), m.get("module", ""))
             for m in mechanisms],
            ("id", "μηχανισμός", "άξονας", "βάρος", "κατάσταση", "κώδικας"),
            (10, 42, 15, 6, 13, 34),
        )
    return 0


def cmd_show(args) -> int:
    entries = load_ideas() + load_mechanisms()
    match = next((e for e in entries if e.get("id") == args.id), None)
    if not match:
        print(f"Δεν βρέθηκε: {args.id}")
        return 1
    width = max(len(k) for k in match)
    for key, value in match.items():
        if isinstance(value, dict):
            print(f"{key.ljust(width)} :")
            for sub, sub_value in value.items():
                print(f"{' ' * width}   {sub}: {sub_value}")
        elif isinstance(value, list):
            print(f"{key.ljust(width)} : {', '.join(str(v) for v in value) or '—'}")
        else:
            text = str(value).strip().replace("\n", "\n" + " " * (width + 3))
            print(f"{key.ljust(width)} : {text}")
    return 0


def cmd_audit(args) -> int:
    result = audit()
    print(f"Έλεγχοι: {result.checks_run}")
    for error in result.errors:
        print(f"  ✗ {error}")
    for warning in result.warnings:
        print(f"  ⚠ {warning}")
    if result.ok:
        print(f"\n✓ Τα μητρώα είναι συνεπή "
              f"({len(load_ideas())} ιδέες, {len(load_mechanisms())} μηχανισμοί)")
        return 0
    print(f"\n✗ {len(result.errors)} σφάλματα")
    return 1


def cmd_add_idea(args) -> int:
    ident = add_idea(
        title=args.title, hypothesis=args.hypothesis, category=args.category,
        horizon=args.horizon, feasibility=args.feasibility,
        source_name=args.source_name, source_url=args.source_url,
    )
    print(f"✓ Προστέθηκε {ident}. Επεξεργαστείτε το ideas.yml για τα υπόλοιπα πεδία.")
    return 0


def cmd_render(args) -> int:
    print(render_markdown())
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="akinita.registry",
        description="Μητρώα ιδεών σημάτων και υλοποιημένων μηχανισμών.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    listing = sub.add_parser("list", help="Λίστα ιδεών και/ή μηχανισμών")
    listing.add_argument("what", nargs="?", default="all",
                         choices=["ideas", "mechanisms", "all"])
    listing.add_argument("--status")
    listing.add_argument("--category")
    listing.set_defaults(func=cmd_list)

    show = sub.add_parser("show", help="Πλήρης εγγραφή για ένα id")
    show.add_argument("id")
    show.set_defaults(func=cmd_show)

    checking = sub.add_parser("audit", help="Έλεγχος συνέπειας μητρώων και κώδικα")
    checking.set_defaults(func=cmd_audit)

    adding = sub.add_parser("add-idea", help="Προσθήκη νέας ιδέας")
    adding.add_argument("--title", required=True)
    adding.add_argument("--hypothesis", required=True)
    adding.add_argument("--category", default="ζήτηση")
    adding.add_argument("--horizon", default="immediate",
                        choices=["immediate", "1-2y", "3-5y"])
    adding.add_argument("--feasibility", default="probable",
                        choices=["proven", "probable", "hard", "blocked"])
    adding.add_argument("--source-name", default="")
    adding.add_argument("--source-url", default="")
    adding.set_defaults(func=cmd_add_idea)

    rendering = sub.add_parser("render", help="Έξοδος σε Markdown")
    rendering.set_defaults(func=cmd_render)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    ensure_utf8()
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
