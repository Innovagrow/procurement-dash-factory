"""Κοινή δομή μηνύματος και βάση καναλιού."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Notification:
    kind: str  # instant | digest | deadline | error
    subject: str
    text: str
    html: str | None = None
    dedupe_key: str = ""
    profile_id: int | None = None
    # Παραλήπτες ανά κανάλι, όταν το προφίλ ορίζει δικούς του.
    email: str | None = None
    telegram_chat_id: str | None = None
    webhook_url: str | None = None
    data: dict = field(default_factory=dict)


class Notifier:
    channel = "base"

    def send(self, notification: Notification) -> None:  # pragma: no cover - override
        raise NotImplementedError

    def is_configured(self) -> bool:
        return True
