"""Έξοδος στα logs — πάντα διαθέσιμη, χρήσιμη σε dev και ως fallback."""
from __future__ import annotations

import logging

from .base import Notification, Notifier

logger = logging.getLogger("espa_radar.notify")


class ConsoleNotifier(Notifier):
    channel = "console"

    def send(self, notification: Notification) -> None:
        logger.info(
            "\n%s\n%s\n%s\n%s",
            "=" * 70,
            notification.subject,
            "-" * 70,
            notification.text,
        )
