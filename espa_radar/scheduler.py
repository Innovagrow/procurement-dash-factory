"""Συνεχής λειτουργία: περιοδική σάρωση, σύνοψη, υπενθυμίσεις."""
from __future__ import annotations

import logging
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from .config import settings
from .pipeline import (
    close_expired,
    purge_old_logs,
    scan,
    send_deadline_reminders,
    send_digest,
)

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _job_scan() -> None:
    logger.info("⏱️  Προγραμματισμένη σάρωση πηγών…")
    try:
        report = scan()
        logger.info("Σάρωση ολοκληρώθηκε: %s", report.as_dict())
    except Exception:  # noqa: BLE001 - ο scheduler δεν πρέπει ποτέ να πεθάνει
        logger.exception("Η σάρωση απέτυχε")


def _job_digest() -> None:
    logger.info("📋 Ημερήσια σύνοψη…")
    try:
        close_expired()
        send_digest()
    except Exception:
        logger.exception("Η ημερήσια σύνοψη απέτυχε")


def _job_deadlines() -> None:
    logger.info("⏰ Έλεγχος προθεσμιών…")
    try:
        send_deadline_reminders()
    except Exception:
        logger.exception("Ο έλεγχος προθεσμιών απέτυχε")


def _job_maintenance() -> None:
    try:
        close_expired()
        purge_old_logs()
    except Exception:
        logger.exception("Η συντήρηση απέτυχε")


def start_scheduler() -> BackgroundScheduler | None:
    """Ξεκινά τον scheduler. Επιστρέφει None αν είναι απενεργοποιημένος."""
    global _scheduler

    if not settings.scheduler_enabled:
        logger.info("Ο scheduler είναι απενεργοποιημένος (ESPA_SCHEDULER_ENABLED=false)")
        return None
    if _scheduler is not None:
        return _scheduler

    try:
        timezone = ZoneInfo(settings.timezone)
    except Exception:  # noqa: BLE001 - άγνωστη ζώνη: συνεχίζουμε σε UTC
        logger.warning("Άγνωστη ζώνη ώρας '%s' — χρήση UTC", settings.timezone)
        timezone = ZoneInfo("UTC")
    scheduler = BackgroundScheduler(
        timezone=timezone,
        job_defaults={"coalesce": True, "max_instances": 1, "misfire_grace_time": 3600},
    )

    scheduler.add_job(
        _job_scan,
        IntervalTrigger(minutes=settings.scan_interval_minutes, timezone=timezone),
        id="scan",
        name="Σάρωση πηγών",
        replace_existing=True,
    )
    scheduler.add_job(
        _job_digest,
        CronTrigger(hour=settings.digest_hour, minute=settings.digest_minute, timezone=timezone),
        id="digest",
        name="Ημερήσια σύνοψη",
        replace_existing=True,
    )
    scheduler.add_job(
        _job_deadlines,
        CronTrigger(
            hour=settings.digest_hour,
            minute=(settings.digest_minute + 10) % 60,
            timezone=timezone,
        ),
        id="deadlines",
        name="Υπενθυμίσεις προθεσμιών",
        replace_existing=True,
    )
    scheduler.add_job(
        _job_maintenance,
        CronTrigger(hour=3, minute=0, timezone=timezone),
        id="maintenance",
        name="Συντήρηση",
        replace_existing=True,
    )

    scheduler.start()
    _scheduler = scheduler
    logger.info(
        "✅ Scheduler ενεργός: σάρωση κάθε %s λεπτά, σύνοψη %02d:%02d (%s)",
        settings.scan_interval_minutes, settings.digest_hour, settings.digest_minute, settings.timezone,
    )

    if settings.scan_on_startup:
        # Άμεση πρώτη σάρωση, χωρίς να μπλοκάρει την εκκίνηση του web server.
        scheduler.add_job(_job_scan, id="scan-startup", name="Αρχική σάρωση", replace_existing=True)

    return scheduler


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler σταμάτησε")


def scheduler_status() -> list[dict]:
    if _scheduler is None:
        return []
    return [
        {
            "id": job.id,
            "name": job.name,
            "next_run": job.next_run_time.isoformat() if job.next_run_time else None,
        }
        for job in _scheduler.get_jobs()
    ]
