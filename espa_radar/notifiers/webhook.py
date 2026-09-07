"""Ειδοποιήσεις μέσω webhook (Slack, Make, n8n, δικό σου endpoint)."""
from __future__ import annotations

import hashlib
import hmac
import json

from ..config import settings
from ..sources.http import request
from .base import Notification, Notifier


class WebhookNotifier(Notifier):
    channel = "webhook"

    def is_configured(self) -> bool:
        return bool(settings.webhook_url)

    def send(self, notification: Notification) -> None:
        url = notification.webhook_url or settings.webhook_url
        if not url:
            raise RuntimeError("Δεν ορίστηκε webhook URL")

        payload = {
            "kind": notification.kind,
            "subject": notification.subject,
            "text": notification.text,
            "profile_id": notification.profile_id,
            "dedupe_key": notification.dedupe_key,
            "data": notification.data,
            # Το «text» βοηθά να δουλεύει αυτούσιο και σε Slack incoming webhooks.
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        headers = {"Content-Type": "application/json; charset=utf-8"}
        if settings.webhook_secret:
            signature = hmac.new(
                settings.webhook_secret.encode("utf-8"), body, hashlib.sha256
            ).hexdigest()
            headers["X-Espa-Signature"] = f"sha256={signature}"

        request("POST", url, content=body, headers=headers)
