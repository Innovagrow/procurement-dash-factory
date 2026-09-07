"""Ειδοποιήσεις μέσω Telegram bot."""
from __future__ import annotations

from ..config import settings
from ..sources.http import request
from .base import Notification, Notifier

MAX_LENGTH = 4000


class TelegramNotifier(Notifier):
    channel = "telegram"

    def is_configured(self) -> bool:
        return bool(settings.telegram_bot_token)

    def send(self, notification: Notification) -> None:
        if not self.is_configured():
            raise RuntimeError("Λείπει το ESPA_TELEGRAM_BOT_TOKEN")

        chat_id = notification.telegram_chat_id or settings.telegram_chat_id
        if not chat_id:
            raise RuntimeError("Δεν ορίστηκε chat_id για Telegram")

        body = f"*{_escape(notification.subject)}*\n\n{_escape(notification.text)}"
        url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"

        for chunk in _chunks(body):
            request(
                "POST",
                url,
                json={
                    "chat_id": chat_id,
                    "text": chunk,
                    "parse_mode": "Markdown",
                    "disable_web_page_preview": False,
                },
            )


def _escape(text: str) -> str:
    # Ελάχιστο escaping ώστε τα «*» και «_» των τίτλων να μην σπάνε το Markdown.
    return text.replace("*", "∗").replace("_", "＿")


def _chunks(text: str) -> list[str]:
    if len(text) <= MAX_LENGTH:
        return [text]
    parts: list[str] = []
    current = ""
    for line in text.splitlines(keepends=True):
        if len(current) + len(line) > MAX_LENGTH:
            parts.append(current)
            current = ""
        current += line
    if current:
        parts.append(current)
    return parts
