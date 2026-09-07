"""CLI: python -m espa_radar.cli <εντολή>"""
from __future__ import annotations

import argparse
import json
import logging
import sys

from .config import settings
from .db import init_db, session_scope
from .models import Match, Profile, Program
from .pipeline import (
    close_expired,
    run_matching,
    scan,
    send_deadline_reminders,
    send_digest,
)
from .sources import build_sources
from .textutils import fmt_date, fmt_money


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    )


def cmd_init(args) -> int:
    print(f"✅ Βάση έτοιμη: {settings.database_url}")
    return 0


def cmd_scan(args) -> int:
    close_expired()
    report = scan(only=args.source or None, notify_matches=not args.no_notify)
    print(json.dumps(report.as_dict(), ensure_ascii=False, indent=2))
    return 0 if report.sources_ok else 1


def cmd_sources(args) -> int:
    for source in build_sources():
        print(f"{source.source_id:24} {type(source).__name__:16} {source.name}")
    return 0


def cmd_test_source(args) -> int:
    sources = build_sources(only=[args.source_id])
    if not sources:
        print(f"❌ Δεν βρέθηκε πηγή '{args.source_id}'", file=sys.stderr)
        return 1

    from .pipeline import enrich

    source = sources[0]
    try:
        fetched = source.fetch()
    except Exception as exc:  # noqa: BLE001
        print(f"❌ {source.source_id}: {exc}", file=sys.stderr)
        return 1

    # Ίδια φίλτρα με το pipeline, ώστε το test να δείχνει την πραγματική έξοδο.
    raws = source.apply_filters(fetched)
    dropped = len(fetched) - len(raws)
    print(f"✅ {source.source_id}: {len(raws)} εγγραφές"
          + (f" ({dropped} φιλτραρίστηκαν ως άσχετες)" if dropped else "") + "\n")
    for raw in raws[: args.limit]:
        data = enrich(raw)
        print(f"• {data['title'][:100]}")
        print(f"  {data['url']}")
        print(f"  κατάσταση={data['status']} λήξη={fmt_date(data['deadline'])} "
              f"ενίσχυση={data['subsidy_rate']}% προϋπ.={fmt_money(data['budget_max'])}")
        print(f"  κλάδοι={data['sectors']} περιοχές={data['regions']}")
        print()
    return 0


def cmd_add_profile(args) -> int:
    profile = Profile(
        name=args.name,
        owner_email=args.email,
        notify_email=args.email,
        regions=args.region or [],
        sectors=args.sector or [],
        beneficiaries=args.beneficiary or [],
        keywords=args.keyword or [],
        exclude_keywords=args.exclude or [],
        budget_min=args.budget_min,
        budget_max=args.budget_max,
        min_subsidy_rate=args.min_rate,
        min_score=args.min_score,
        notify_channels=args.channel or [],
    )
    with session_scope() as session:
        session.add(profile)
        session.flush()
        profile_id = profile.id
    created = run_matching(profile_id=profile_id)
    print(f"✅ Προφίλ #{profile_id} «{args.name}» — {created} ταιριάσματα")
    return 0


def cmd_profiles(args) -> int:
    with session_scope() as session:
        profiles = session.query(Profile).all()
        if not profiles:
            print("Κανένα προφίλ.")
            return 0
        for profile in profiles:
            state = "ενεργό" if profile.is_active else "παύση"
            print(f"#{profile.id} {profile.name} [{state}]")
            print(f"   κλάδοι={profile.sectors or '—'} περιοχές={profile.regions or 'όλες'}")
            print(f"   λέξεις={profile.keywords or '—'} κατώφλι={profile.min_score or settings.default_min_score}")
    return 0


def cmd_matches(args) -> int:
    close_expired()
    with session_scope() as session:
        query = session.query(Match).filter(Match.is_dismissed.is_(False))
        if args.profile:
            query = query.filter(Match.profile_id == args.profile)
        matches = query.order_by(Match.score.desc()).limit(args.limit).all()
        if not matches:
            print("Κανένα ταίριασμα.")
            return 0
        for match in matches:
            program = match.program
            print(f"[{match.score:5.1f}] {program.title[:95]}")
            print(f"        {program.source_name} | λήξη {fmt_date(program.deadline)} | {program.url}")
            if match.reasons:
                print(f"        ✓ {'; '.join(match.reasons[:3])}")
    return 0


def cmd_match(args) -> int:
    created = run_matching(profile_id=args.profile)
    print(f"✅ {created} νέα ταιριάσματα")
    return 0


def cmd_digest(args) -> int:
    close_expired()
    print(f"✅ {send_digest()} συνόψεις στάλθηκαν")
    return 0


def cmd_reminders(args) -> int:
    print(f"✅ {send_deadline_reminders()} υπενθυμίσεις στάλθηκαν")
    return 0


def cmd_stats(args) -> int:
    close_expired()
    with session_scope() as session:
        print(f"Προγράμματα:  {session.query(Program).count()}")
        print(f"  ανοιχτά:    {session.query(Program).filter(Program.status == 'OPEN').count()}")
        print(f"  έληξαν:     {session.query(Program).filter(Program.status == 'CLOSED').count()}")
        print(f"Προφίλ:       {session.query(Profile).count()}")
        print(f"Ταιριάσματα:  {session.query(Match).count()}")
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    uvicorn.run("espa_radar.api:app", host=args.host, port=args.port, reload=args.reload)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="espa_radar",
        description="Ραντάρ προγραμμάτων ΕΣΠΑ & επιδοτήσεων",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="Δημιουργία βάσης").set_defaults(func=cmd_init)

    p_scan = sub.add_parser("scan", help="Σάρωση πηγών + matching + ειδοποιήσεις")
    p_scan.add_argument("--source", action="append", help="Μόνο αυτή την πηγή (επαναλαμβανόμενο)")
    p_scan.add_argument("--no-notify", action="store_true", help="Χωρίς αποστολή ειδοποιήσεων")
    p_scan.set_defaults(func=cmd_scan)

    sub.add_parser("sources", help="Λίστα πηγών").set_defaults(func=cmd_sources)

    p_test = sub.add_parser("test-source", help="Δοκιμή μίας πηγής χωρίς αποθήκευση")
    p_test.add_argument("source_id")
    p_test.add_argument("--limit", type=int, default=5)
    p_test.set_defaults(func=cmd_test_source)

    p_add = sub.add_parser("add-profile", help="Νέο προφίλ κριτηρίων")
    p_add.add_argument("name")
    p_add.add_argument("--email")
    p_add.add_argument("--region", action="append")
    p_add.add_argument("--sector", action="append")
    p_add.add_argument("--beneficiary", action="append")
    p_add.add_argument("--keyword", action="append")
    p_add.add_argument("--exclude", action="append")
    p_add.add_argument("--channel", action="append")
    p_add.add_argument("--budget-min", type=float)
    p_add.add_argument("--budget-max", type=float)
    p_add.add_argument("--min-rate", type=float)
    p_add.add_argument("--min-score", type=float)
    p_add.set_defaults(func=cmd_add_profile)

    sub.add_parser("profiles", help="Λίστα προφίλ").set_defaults(func=cmd_profiles)

    p_matches = sub.add_parser("matches", help="Τα ταιριάσματα")
    p_matches.add_argument("--profile", type=int)
    p_matches.add_argument("--limit", type=int, default=20)
    p_matches.set_defaults(func=cmd_matches)

    p_match = sub.add_parser("match", help="Επανυπολογισμός ταιριασμάτων")
    p_match.add_argument("--profile", type=int)
    p_match.set_defaults(func=cmd_match)

    sub.add_parser("digest", help="Αποστολή ημερήσιας σύνοψης").set_defaults(func=cmd_digest)
    sub.add_parser("reminders", help="Αποστολή υπενθυμίσεων").set_defaults(func=cmd_reminders)
    sub.add_parser("stats", help="Στατιστικά").set_defaults(func=cmd_stats)

    p_serve = sub.add_parser("serve", help="Web dashboard + API + scheduler")
    p_serve.add_argument("--host", default="0.0.0.0")
    p_serve.add_argument("--port", type=int, default=8000)
    p_serve.add_argument("--reload", action="store_true")
    p_serve.set_defaults(func=cmd_serve)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _setup_logging(args.verbose)
    init_db()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
