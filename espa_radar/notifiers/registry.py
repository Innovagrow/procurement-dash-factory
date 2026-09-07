"""Δρομολόγηση ειδοποιήσεων στα ενεργά κανάλια, με log & idempotency."""
from __future__ import annotations

import logging

from dataclasses import dataclass, field

from ..config import settings
from ..db import session_scope
from ..models import NotificationLog
from .base import Notification, Notifier
from .console import ConsoleNotifier
from .email_smtp import EmailNotifier
from .telegram import TelegramNotifier
from .webhook import WebhookNotifier

logger = logging.getLogger(__name__)

CHANNELS: dict[str, type[Notifier]] = {
    "console": ConsoleNotifier,
    "email": EmailNotifier,
    "telegram": TelegramNotifier,
    "webhook": WebhookNotifier,
}


def get_notifiers(channels: list[str] | None = None) -> list[Notifier]:
    """Τα ζητούμενα κανάλια που είναι όντως ρυθμισμένα."""
    wanted = channels or settings.notify_channels or ["console"]
    active: list[Notifier] = []
    for name in wanted:
        factory = CHANNELS.get(name.strip().lower())
        if factory is None:
            logger.warning("Άγνωστο κανάλι ειδοποίησης: %s", name)
            continue
        notifier = factory()
        if not notifier.is_configured():
            logger.warning("Το κανάλι '%s' δεν είναι ρυθμισμένο — παραλείπεται", name)
            continue
        active.append(notifier)

    if not active:
        logger.warning("Κανένα ρυθμισμένο κανάλι — χρήση console")
        active.append(ConsoleNotifier())
    return active


def already_sent(dedupe_key: str, channel: str) -> bool:
    with session_scope() as session:
        return (
            session.query(NotificationLog)
            .filter(
                NotificationLog.dedupe_key == dedupe_key,
                NotificationLog.channel == channel,
                NotificationLog.ok.is_(True),
            )
            .first()
            is not None
        )


SENT = "sent"
SKIPPED = "skipped"  # ήδη σταλμένο (dedupe)
FAILED = "failed"


@dataclass
class NotifyResult:
    """Αποτέλεσμα ανά κανάλι.

    Ξεχωρίζει το «στάλθηκε» από το «παραλείφθηκε ως διπλότυπο»: και τα δύο
    σημαίνουν ότι η ειδοποίηση έχει διεκπεραιωθεί, αλλά μόνο το πρώτο είναι
    πραγματική αποστολή — αλλιώς οι μετρητές θα έδειχναν ειδοποιήσεις που
    ποτέ δεν έφυγαν.
    """

    statuses: dict[str, str] = field(default_factory=dict)

    @property
    def delivered(self) -> bool:
        """Έφυγε όντως μήνυμα σε τουλάχιστον ένα κανάλι."""
        return any(status == SENT for status in self.statuses.values())

    @property
    def handled(self) -> bool:
        """Στάλθηκε τώρα ή είχε ήδη σταλεί."""
        return any(status in (SENT, SKIPPED) for status in self.statuses.values())

    def values(self):  # συμβατότητα με dict-like χρήση
        return [status == SENT for status in self.statuses.values()]

    def get(self, channel: str) -> str | None:
        return self.statuses.get(channel)


def notify(notification: Notification, channels: list[str] | None = None) -> NotifyResult:
    """Στέλνει σε όλα τα κανάλια. Ένα κανάλι που αποτυγχάνει δεν ρίχνει τα άλλα."""
    result = NotifyResult()

    for notifier in get_notifiers(channels):
        if notification.dedupe_key and already_sent(notification.dedupe_key, notifier.channel):
            logger.debug("Παράλειψη διπλής ειδοποίησης %s/%s", notification.dedupe_key, notifier.channel)
            result.statuses[notifier.channel] = SKIPPED
            continue

        error: str | None = None
        try:
            notifier.send(notification)
            ok = True
        except Exception as exc:  # noqa: BLE001 - μια αποτυχία δεν ρίχνει τα υπόλοιπα κανάλια
            ok = False
            error = str(exc)
            logger.error("Αποτυχία ειδοποίησης στο '%s': %s", notifier.channel, exc)

        result.statuses[notifier.channel] = SENT if ok else FAILED
        with session_scope() as session:
            session.add(
                NotificationLog(
                    profile_id=notification.profile_id,
                    channel=notifier.channel,
                    kind=notification.kind,
                    dedupe_key=notification.dedupe_key or "",
                    subject=notification.subject[:500],
                    payload=notification.data,
                    ok=ok,
                    error=error,
                )
            )

    return result
