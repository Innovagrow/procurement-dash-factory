"""Ειδοποιήσεις μέσω email (SMTP)."""
from __future__ import annotations

import smtplib
from email.message import EmailMessage

from ..config import settings
from .base import Notification, Notifier


class EmailNotifier(Notifier):
    channel = "email"

    def is_configured(self) -> bool:
        return bool(settings.smtp_host and (settings.smtp_from or settings.smtp_user))

    def send(self, notification: Notification) -> None:
        if not self.is_configured():
            raise RuntimeError("Το SMTP δεν έχει ρυθμιστεί (ESPA_SMTP_HOST/ESPA_SMTP_FROM)")

        recipient = notification.email
        if not recipient:
            raise RuntimeError("Δεν ορίστηκε παραλήπτης email για την ειδοποίηση")

        message = EmailMessage()
        message["Subject"] = notification.subject
        message["From"] = settings.smtp_from or settings.smtp_user
        message["To"] = recipient
        message.set_content(notification.text)
        if notification.html:
            message.add_alternative(notification.html, subtype="html")

        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as server:
            if settings.smtp_starttls:
                server.starttls()
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(message)
