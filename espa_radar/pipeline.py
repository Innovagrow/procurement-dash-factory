"""Ο πυρήνας: συλλογή → εμπλουτισμός → αποθήκευση → αντιστοίχιση → ειδοποίηση."""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import session_scope
from .extract import extract_budgets, extract_deadline, extract_opens_at, extract_subsidy_rate
from .matching import evaluate
from .messages import change_message, deadline_message, digest_message, instant_message
from .models import Match, NotificationLog, Profile, Program, ProgramChange, SourceRun
from .notifiers import Notification, notify
from .sources import RawProgram, Source, build_sources
from .taxonomy import (
    STATUS_CLOSED,
    detect_aid_types,
    detect_beneficiaries,
    detect_regions,
    detect_sectors,
    detect_status,
)
from .textutils import canonical_url, fingerprint, fmt_date, fmt_money, similarity, utcnow

logger = logging.getLogger(__name__)

# Πεδία που, όταν αλλάξουν, αξίζουν ειδοποίηση.
WATCHED_FIELDS = ("deadline", "status", "budget_max", "subsidy_rate")


@dataclass
class ScanReport:
    sources_ok: int = 0
    sources_failed: int = 0
    found: int = 0
    new: int = 0
    updated: int = 0
    matches_created: int = 0
    notifications_sent: int = 0
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "sources_ok": self.sources_ok,
            "sources_failed": self.sources_failed,
            "found": self.found,
            "new": self.new,
            "updated": self.updated,
            "matches_created": self.matches_created,
            "notifications_sent": self.notifications_sent,
            "errors": self.errors,
        }


# ============================================================
# 1. Εμπλουτισμός
# ============================================================

def enrich(raw: RawProgram) -> dict:
    """Από ακατέργαστη εγγραφή σε δομημένα πεδία προγράμματος."""
    blob = raw.text_blob()

    deadline = raw.deadline or extract_deadline(blob)
    opens_at = raw.opens_at or extract_opens_at(blob)
    budget_total, budget_min, budget_max = extract_budgets(blob)
    if raw.budget_total is not None:
        budget_total = raw.budget_total

    return {
        "source_id": raw.source_id,
        "source_name": raw.source_name,
        "external_id": (raw.external_id or raw.url)[:255],
        "title": raw.title[:600],
        "summary": raw.summary,
        "body": (raw.body or "")[:60000] or None,
        "url": raw.url[:1000],
        "status": detect_status(f"{blob} {raw.status_hint or ''}", deadline),
        "published_at": raw.published_at,
        "opens_at": opens_at,
        "deadline": deadline,
        "budget_total": budget_total,
        "budget_min": budget_min,
        "budget_max": budget_max,
        "subsidy_rate": extract_subsidy_rate(blob),
        "regions": detect_regions(blob),
        "sectors": detect_sectors(blob),
        "beneficiaries": detect_beneficiaries(blob),
        "aid_types": detect_aid_types(blob),
        "raw": raw.extra or {},
    }


def _content_hash(data: dict) -> str:
    return fingerprint(
        data["title"],
        data.get("summary") or "",
        str(data.get("deadline")),
        str(data.get("budget_max")),
        str(data.get("subsidy_rate")),
        data.get("status") or "",
    )


def _fingerprint_for(data: dict) -> str:
    return fingerprint(canonical_url(data["url"]))


# ============================================================
# 2. Αποθήκευση με dedupe & ανίχνευση αλλαγών
# ============================================================

# Πάνω από αυτό το όριο ομοιότητας τίτλων θεωρούμε ότι πρόκειται για το ίδιο
# πρόγραμμα. Παραμένει αρκετά αυστηρό ώστε «Ενίσχυση επιχειρήσεων Περιφέρειας Α»
# και «… Περιφέρειας Β» να μένουν ξεχωριστά.
TITLE_DUPLICATE_THRESHOLD = 0.92
_DEDUPE_WINDOW_DAYS = 240
_DEDUPE_SCAN_LIMIT = 3000


def _find_near_duplicate(session: Session, data: dict) -> Program | None:
    """Σχεδόν ίδιος τίτλος — ίδιο πρόγραμμα, ακόμη κι αν το βρήκε άλλη πηγή."""
    cutoff = utcnow() - timedelta(days=_DEDUPE_WINDOW_DAYS)
    candidates = session.scalars(
        select(Program)
        .where(Program.last_seen_at >= cutoff)
        .order_by(Program.last_seen_at.desc())
        .limit(_DEDUPE_SCAN_LIMIT)
    ).all()
    for candidate in candidates:
        if similarity(candidate.title, data["title"]) >= TITLE_DUPLICATE_THRESHOLD:
            return candidate
    return None


def upsert_program(session: Session, data: dict) -> tuple[Program, bool, list[str]]:
    """Επιστρέφει (πρόγραμμα, είναι_νέο, λίστα_αλλαγών)."""
    fp = _fingerprint_for(data)
    program = session.scalar(select(Program).where(Program.fingerprint == fp))

    if program is None:
        program = _find_near_duplicate(session, data)

    now = utcnow()
    content_hash = _content_hash(data)

    if program is None:
        program = Program(fingerprint=fp, content_hash=content_hash, first_seen_at=now, last_seen_at=now, **data)
        session.add(program)
        session.flush()
        return program, True, []

    program.last_seen_at = now
    _record_extra_source(program, data)
    if program.content_hash == content_hash:
        return program, False, []

    changes: list[str] = []
    for field_name in WATCHED_FIELDS:
        old = getattr(program, field_name)
        new = data.get(field_name)
        if old == new or new is None:
            continue
        changes.append(_describe_change(field_name, old, new))
        session.add(
            ProgramChange(
                program_id=program.id,
                field=field_name,
                old_value=str(old) if old is not None else None,
                new_value=str(new),
            )
        )

    for key, value in data.items():
        # Η πηγή που το πρωτοβρήκε παραμένει η «κύρια» — οι υπόλοιπες
        # καταγράφονται στο raw["also_seen_in"].
        if key in {"source_id", "source_name", "external_id", "raw"}:
            continue
        # Δεν σβήνουμε υπάρχουσα πληροφορία με κενό από μια φτωχότερη σάρωση.
        if value in (None, [], {}) and getattr(program, key, None):
            continue
        setattr(program, key, value)
    program.content_hash = content_hash
    program.updated_at = now

    return program, False, changes


def _record_extra_source(program: Program, data: dict) -> None:
    """Σημειώνει ότι το ίδιο πρόγραμμα εντοπίστηκε και από άλλη πηγή."""
    incoming = data.get("source_id")
    if not incoming or incoming == program.source_id:
        return
    raw = dict(program.raw or {})
    others = set(raw.get("also_seen_in") or [])
    if incoming in others:
        return
    others.add(incoming)
    raw["also_seen_in"] = sorted(others)
    program.raw = raw


def _describe_change(field_name: str, old, new) -> str:
    labels = {
        "deadline": "Προθεσμία",
        "status": "Κατάσταση",
        "budget_max": "Μέγιστος προϋπολογισμός",
        "subsidy_rate": "Ένταση ενίσχυσης",
    }
    label = labels.get(field_name, field_name)
    if field_name == "deadline":
        return f"{label}: {fmt_date(old)} → {fmt_date(new)}"
    if field_name in {"budget_max"}:
        return f"{label}: {fmt_money(old)} → {fmt_money(new)}"
    if field_name == "subsidy_rate":
        return f"{label}: {old or '—'}% → {new}%"
    return f"{label}: {old or '—'} → {new}"


# ============================================================
# 3. Σάρωση πηγών
# ============================================================

def _run_source(source: Source) -> tuple[str, list[RawProgram], str | None]:
    try:
        return source.source_id, source.apply_filters(source.fetch()), None
    except Exception as exc:  # noqa: BLE001 - μια πηγή δεν ρίχνει το scan
        logger.error("[%s] απέτυχε: %s", source.source_id, exc)
        return source.source_id, [], str(exc)


def scan(only: list[str] | None = None, notify_matches: bool = True) -> ScanReport:
    """Πλήρης κύκλος: όλες οι πηγές, αποθήκευση, matching, ειδοποιήσεις."""
    report = ScanReport()
    sources = build_sources(only=only)
    if not sources:
        report.errors.append("Δεν βρέθηκαν ενεργές πηγές")
        return report

    started = {s.source_id: utcnow() for s in sources}
    results: list[tuple[str, list[RawProgram], str | None]] = []

    with ThreadPoolExecutor(max_workers=max(1, settings.http_concurrency)) as pool:
        futures = {pool.submit(_run_source, s): s for s in sources}
        for future in as_completed(futures):
            results.append(future.result())

    changed_programs: list[tuple[int, list[str]]] = []

    for source_id, raws, error in results:
        run = SourceRun(source_id=source_id, started_at=started.get(source_id, utcnow()))
        new_count = updated_count = 0

        if error:
            report.sources_failed += 1
            report.errors.append(f"{source_id}: {error}")
        else:
            report.sources_ok += 1

        for raw in raws:
            try:
                data = enrich(raw)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[%s] αποτυχία εμπλουτισμού '%s': %s", source_id, raw.title[:60], exc)
                continue

            try:
                with session_scope() as session:
                    program, is_new, changes = upsert_program(session, data)
                    program_id = program.id
                if is_new:
                    new_count += 1
                elif changes:
                    updated_count += 1
                    changed_programs.append((program_id, changes))
            except Exception as exc:  # noqa: BLE001
                logger.warning("[%s] αποτυχία αποθήκευσης '%s': %s", source_id, raw.title[:60], exc)

        report.found += len(raws)
        report.new += new_count
        report.updated += updated_count

        run.finished_at = utcnow()
        run.ok = error is None
        run.error = error
        run.items_found = len(raws)
        run.items_new = new_count
        run.items_updated = updated_count
        with session_scope() as session:
            session.add(run)

    logger.info(
        "Σάρωση: %s πηγές OK / %s απέτυχαν, %s εγγραφές (%s νέες, %s ενημερωμένες)",
        report.sources_ok, report.sources_failed, report.found, report.new, report.updated,
    )

    report.matches_created = run_matching()

    if notify_matches:
        report.notifications_sent += send_instant_notifications()
        report.notifications_sent += notify_program_changes(changed_programs)

    return report


# ============================================================
# 4. Αντιστοίχιση
# ============================================================

def run_matching(profile_id: int | None = None) -> int:
    """Αξιολογεί όλα τα ενεργά προγράμματα για κάθε ενεργό προφίλ."""
    created = 0
    with session_scope() as session:
        profiles_query = select(Profile).where(Profile.is_active.is_(True))
        if profile_id is not None:
            profiles_query = select(Profile).where(Profile.id == profile_id)
        profiles = session.scalars(profiles_query).all()
        if not profiles:
            return 0

        programs = session.scalars(
            select(Program).where(Program.status != STATUS_CLOSED)
        ).all()

        existing = {
            (m.profile_id, m.program_id): m
            for m in session.scalars(select(Match)).all()
        }

        for profile in profiles:
            for program in programs:
                result = evaluate(profile, program)
                key = (profile.id, program.id)
                current = existing.get(key)

                if not result.matched:
                    # Αν έπαψε να ταιριάζει, το κρατάμε αλλά δεν το ξαναστέλνουμε.
                    continue

                if current is None:
                    session.add(
                        Match(
                            profile_id=profile.id,
                            program_id=program.id,
                            score=result.score,
                            reasons=result.reasons,
                            breakdown=result.breakdown,
                        )
                    )
                    created += 1
                elif abs(current.score - result.score) >= 0.5:
                    current.score = result.score
                    current.reasons = result.reasons
                    current.breakdown = result.breakdown

    if created:
        logger.info("Δημιουργήθηκαν %s νέα ταιριάσματα", created)
    return created


# ============================================================
# 5. Ειδοποιήσεις
# ============================================================

def _channels_for(profile: Profile) -> list[str]:
    return list(profile.notify_channels or []) or settings.notify_channels


def _address(profile: Profile, notification: Notification) -> Notification:
    notification.email = profile.notify_email or profile.owner_email
    notification.telegram_chat_id = profile.telegram_chat_id
    notification.webhook_url = profile.webhook_url
    notification.profile_id = profile.id
    return notification


def send_instant_notifications() -> int:
    """Άμεση ειδοποίηση για ταιριάσματα υψηλού σκορ που δεν έχουν σταλεί."""
    sent = 0
    with session_scope() as session:
        matches = session.scalars(
            select(Match)
            .where(Match.notified_at.is_(None), Match.is_dismissed.is_(False))
            .order_by(Match.score.desc())
        ).all()

        for match in matches:
            profile = match.profile
            if profile is None or not profile.is_active:
                continue

            threshold = max(
                settings.notify_instant_min_score,
                profile.min_score if profile.min_score is not None else 0.0,
            )
            if match.score < threshold:
                continue

            subject, text, body = instant_message(profile, match)
            notification = _address(
                profile,
                Notification(
                    kind="instant",
                    subject=subject,
                    text=text,
                    html=body,
                    dedupe_key=f"instant:{match.id}",
                    data={
                        "program_id": match.program_id,
                        "title": match.program.title,
                        "url": match.program.url,
                        "score": match.score,
                        "deadline": fmt_date(match.program.deadline),
                    },
                ),
            )
            results = notify(notification, _channels_for(profile))
            if any(results.values()):
                match.notified_at = utcnow()
                sent += 1

    if sent:
        logger.info("Στάλθηκαν %s άμεσες ειδοποιήσεις", sent)
    return sent


def notify_program_changes(changed: list[tuple[int, list[str]]]) -> int:
    """Ειδοποίηση όταν αλλάζει πρόγραμμα που ήδη ταιριάζει σε κάποιο προφίλ."""
    if not changed:
        return 0

    sent = 0
    change_map = dict(changed)
    with session_scope() as session:
        matches = session.scalars(
            select(Match).where(Match.program_id.in_(list(change_map)), Match.is_dismissed.is_(False))
        ).all()

        for match in matches:
            profile = match.profile
            if profile is None or not profile.is_active:
                continue
            changes = change_map.get(match.program_id) or []
            if not changes:
                continue

            subject, text, body = change_message(profile, match, changes)
            key = f"change:{match.id}:{fingerprint(*changes)}"
            notification = _address(
                profile,
                Notification(
                    kind="change",
                    subject=subject,
                    text=text,
                    html=body,
                    dedupe_key=key,
                    data={"program_id": match.program_id, "changes": changes, "url": match.program.url},
                ),
            )
            if any(notify(notification, _channels_for(profile)).values()):
                sent += 1

    return sent


def send_digest() -> int:
    """Ημερήσια σύνοψη ανά προφίλ, με ό,τι δεν έχει ήδη σταλεί σε digest."""
    sent = 0
    with session_scope() as session:
        profiles = session.scalars(select(Profile).where(Profile.is_active.is_(True))).all()

        for profile in profiles:
            matches = session.scalars(
                select(Match)
                .where(
                    Match.profile_id == profile.id,
                    Match.digested_at.is_(None),
                    Match.is_dismissed.is_(False),
                )
                .order_by(Match.score.desc())
                .limit(25)
            ).all()

            matches = [m for m in matches if m.program.status != STATUS_CLOSED]
            if not matches:
                continue

            subject, text, body = digest_message(profile, matches)
            notification = _address(
                profile,
                Notification(
                    kind="digest",
                    subject=subject,
                    text=text,
                    html=body,
                    dedupe_key=f"digest:{profile.id}:{utcnow().date().isoformat()}",
                    data={
                        "count": len(matches),
                        "programs": [
                            {"title": m.program.title, "url": m.program.url, "score": m.score}
                            for m in matches
                        ],
                    },
                ),
            )
            if any(notify(notification, _channels_for(profile)).values()):
                stamp = utcnow()
                for match in matches:
                    match.digested_at = stamp
                sent += 1

    if sent:
        logger.info("Στάλθηκαν %s ημερήσιες συνόψεις", sent)
    return sent


def send_deadline_reminders() -> int:
    """Υπενθυμίσεις X ημέρες πριν τη λήξη, μία φορά ανά ορόσημο."""
    sent = 0
    milestones = sorted(settings.deadline_reminder_days)
    if not milestones:
        return 0

    now = utcnow()
    horizon = now + timedelta(days=max(milestones))

    with session_scope() as session:
        matches = session.scalars(
            select(Match)
            .join(Program, Match.program_id == Program.id)
            .where(
                Match.is_dismissed.is_(False),
                Program.deadline.is_not(None),
                Program.deadline >= now,
                Program.deadline <= horizon,
            )
        ).all()

        for match in matches:
            profile = match.profile
            if profile is None or not profile.is_active:
                continue

            remaining = (match.program.deadline.date() - now.date()).days
            milestone = next((d for d in milestones if remaining <= d), None)
            if milestone is None:
                continue
            if match.last_reminder_day is not None and match.last_reminder_day <= milestone:
                continue

            subject, text, body = deadline_message(profile, match, remaining)
            notification = _address(
                profile,
                Notification(
                    kind="deadline",
                    subject=subject,
                    text=text,
                    html=body,
                    dedupe_key=f"deadline:{match.id}:{milestone}",
                    data={
                        "program_id": match.program_id,
                        "url": match.program.url,
                        "days_left": remaining,
                    },
                ),
            )
            if any(notify(notification, _channels_for(profile)).values()):
                match.last_reminder_day = milestone
                sent += 1

    if sent:
        logger.info("Στάλθηκαν %s υπενθυμίσεις προθεσμίας", sent)
    return sent


def close_expired() -> int:
    """Σημειώνει ως ληγμένα όσα προγράμματα πέρασε η προθεσμία τους."""
    now = utcnow()
    with session_scope() as session:
        programs = session.scalars(
            select(Program).where(Program.status != STATUS_CLOSED, Program.deadline.is_not(None))
        ).all()
        closed = 0
        for program in programs:
            deadline = program.deadline
            if deadline is not None and deadline.replace(tzinfo=deadline.tzinfo or now.tzinfo) < now:
                program.status = STATUS_CLOSED
                closed += 1
    if closed:
        logger.info("Έκλεισαν %s ληγμένα προγράμματα", closed)
    return closed


def purge_old_logs(days: int = 90) -> int:
    """Καθαρισμός παλιών εγγραφών τηλεμετρίας/ειδοποιήσεων."""
    cutoff = utcnow() - timedelta(days=days)
    with session_scope() as session:
        removed = (
            session.query(NotificationLog).filter(NotificationLog.created_at < cutoff).delete()
        )
        removed += session.query(SourceRun).filter(SourceRun.started_at < cutoff).delete()
    return removed
