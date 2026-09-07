"""Ρυθμίσεις του ESPA Radar (όλα μέσω environment variables)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("ESPA_DATA_DIR", BASE_DIR.parent / "data"))


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "ναι"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "").strip() or default)
    except (TypeError, ValueError):
        return default


def _list(name: str, default: str = "") -> list[str]:
    raw = os.getenv(name, default) or ""
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass
class Settings:
    """Κεντρική διαμόρφωση. Διαβάζεται μία φορά στο import."""

    # --- Βάση δεδομένων -------------------------------------------------
    database_url: str = field(
        default_factory=lambda: os.getenv("ESPA_DATABASE_URL")
        or os.getenv("DATABASE_URL")
        or f"sqlite:///{DATA_DIR / 'espa_radar.db'}"
    )

    # --- Scheduler ------------------------------------------------------
    # Πόσο συχνά σαρώνονται οι πηγές (λεπτά).
    scan_interval_minutes: int = field(default_factory=lambda: _int("ESPA_SCAN_INTERVAL_MINUTES", 180))
    # Ώρα ημερήσιας σύνοψης (τοπική ώρα, 24ωρο).
    digest_hour: int = field(default_factory=lambda: _int("ESPA_DIGEST_HOUR", 8))
    digest_minute: int = field(default_factory=lambda: _int("ESPA_DIGEST_MINUTE", 30))
    # Υπενθυμίσεις λήξης προθεσμίας (ημέρες πριν).
    deadline_reminder_days: list[int] = field(
        default_factory=lambda: [int(d) for d in _list("ESPA_DEADLINE_REMINDER_DAYS", "14,7,3,1")]
    )
    timezone: str = field(default_factory=lambda: os.getenv("ESPA_TIMEZONE", "Europe/Athens"))
    scan_on_startup: bool = field(default_factory=lambda: _bool("ESPA_SCAN_ON_STARTUP", True))
    scheduler_enabled: bool = field(default_factory=lambda: _bool("ESPA_SCHEDULER_ENABLED", True))

    # --- HTTP -----------------------------------------------------------
    http_timeout: float = field(default_factory=lambda: _float("ESPA_HTTP_TIMEOUT", 30.0))
    http_retries: int = field(default_factory=lambda: _int("ESPA_HTTP_RETRIES", 3))
    http_concurrency: int = field(default_factory=lambda: _int("ESPA_HTTP_CONCURRENCY", 4))
    user_agent: str = field(
        default_factory=lambda: os.getenv(
            "ESPA_USER_AGENT",
            "ESPA-Radar/1.0 (+funding monitor; contact via app owner)",
        )
    )
    # Δευτερόλεπτα καθυστέρησης ανά αίτημα προς την ίδια πηγή (ευγένεια).
    politeness_delay: float = field(default_factory=lambda: _float("ESPA_POLITENESS_DELAY", 1.0))

    # --- Matching -------------------------------------------------------
    # Κάτω από αυτό το σκορ (0-100) δεν δημιουργείται match.
    default_min_score: float = field(default_factory=lambda: _float("ESPA_MIN_SCORE", 45.0))

    # --- Ειδοποιήσεις ---------------------------------------------------
    notify_channels: list[str] = field(default_factory=lambda: _list("ESPA_NOTIFY_CHANNELS", "console"))
    notify_instant_min_score: float = field(default_factory=lambda: _float("ESPA_INSTANT_MIN_SCORE", 70.0))

    smtp_host: str = field(default_factory=lambda: os.getenv("ESPA_SMTP_HOST", ""))
    smtp_port: int = field(default_factory=lambda: _int("ESPA_SMTP_PORT", 587))
    smtp_user: str = field(default_factory=lambda: os.getenv("ESPA_SMTP_USER", ""))
    smtp_password: str = field(default_factory=lambda: os.getenv("ESPA_SMTP_PASSWORD", ""))
    smtp_from: str = field(default_factory=lambda: os.getenv("ESPA_SMTP_FROM", ""))
    smtp_starttls: bool = field(default_factory=lambda: _bool("ESPA_SMTP_STARTTLS", True))

    telegram_bot_token: str = field(default_factory=lambda: os.getenv("ESPA_TELEGRAM_BOT_TOKEN", ""))
    telegram_chat_id: str = field(default_factory=lambda: os.getenv("ESPA_TELEGRAM_CHAT_ID", ""))

    webhook_url: str = field(default_factory=lambda: os.getenv("ESPA_WEBHOOK_URL", ""))
    webhook_secret: str = field(default_factory=lambda: os.getenv("ESPA_WEBHOOK_SECRET", ""))

    # --- API ------------------------------------------------------------
    api_key: str = field(default_factory=lambda: os.getenv("ESPA_API_KEY", ""))
    public_base_url: str = field(default_factory=lambda: os.getenv("ESPA_PUBLIC_BASE_URL", ""))

    def ensure_dirs(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.ensure_dirs()
