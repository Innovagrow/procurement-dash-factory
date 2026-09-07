"""Μοντέλα βάσης (SQLAlchemy 2.0)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .textutils import utcnow


class Base(DeclarativeBase):
    pass


class Program(Base):
    """Μία πρόσκληση / πρόγραμμα επιδότησης, κανονικοποιημένη."""

    __tablename__ = "programs"

    id: Mapped[int] = mapped_column(primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64), unique=True, index=True)

    source_id: Mapped[str] = mapped_column(String(64), index=True)
    source_name: Mapped[str] = mapped_column(String(200))
    external_id: Mapped[str | None] = mapped_column(String(255))

    title: Mapped[str] = mapped_column(String(600))
    summary: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str] = mapped_column(String(1000))

    # Εξαγόμενα χαρακτηριστικά
    status: Mapped[str] = mapped_column(String(20), default="UNKNOWN", index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    opens_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    budget_total: Mapped[float | None] = mapped_column(Float)
    budget_min: Mapped[float | None] = mapped_column(Float)
    budget_max: Mapped[float | None] = mapped_column(Float)
    subsidy_rate: Mapped[float | None] = mapped_column(Float)

    regions: Mapped[list] = mapped_column(JSON, default=list)
    sectors: Mapped[list] = mapped_column(JSON, default=list)
    beneficiaries: Mapped[list] = mapped_column(JSON, default=list)
    aid_types: Mapped[list] = mapped_column(JSON, default=list)

    content_hash: Mapped[str] = mapped_column(String(64))
    raw: Mapped[dict] = mapped_column(JSON, default=dict)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    changes: Mapped[list["ProgramChange"]] = relationship(
        back_populates="program", cascade="all, delete-orphan"
    )
    matches: Mapped[list["Match"]] = relationship(
        back_populates="program", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_programs_status_deadline", "status", "deadline"),
    )

    @property
    def searchable(self) -> str:
        return " ".join(filter(None, [self.title, self.summary, self.body]))


class ProgramChange(Base):
    """Ιστορικό μεταβολών σε πρόγραμμα (π.χ. παράταση προθεσμίας)."""

    __tablename__ = "program_changes"

    id: Mapped[int] = mapped_column(primary_key=True)
    program_id: Mapped[int] = mapped_column(ForeignKey("programs.id", ondelete="CASCADE"), index=True)
    field: Mapped[str] = mapped_column(String(60))
    old_value: Mapped[str | None] = mapped_column(Text)
    new_value: Mapped[str | None] = mapped_column(Text)
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    program: Mapped[Program] = relationship(back_populates="changes")


class Profile(Base):
    """Τα κριτήρια του χρήστη. Ό,τι ταιριάζει, ειδοποιείται."""

    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    owner_email: Mapped[str | None] = mapped_column(String(320))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)

    # Κριτήρια — κενή λίστα σημαίνει «δεν με νοιάζει αυτή η διάσταση».
    regions: Mapped[list] = mapped_column(JSON, default=list)
    sectors: Mapped[list] = mapped_column(JSON, default=list)
    beneficiaries: Mapped[list] = mapped_column(JSON, default=list)
    aid_types: Mapped[list] = mapped_column(JSON, default=list)
    keywords: Mapped[list] = mapped_column(JSON, default=list)
    exclude_keywords: Mapped[list] = mapped_column(JSON, default=list)
    sources: Mapped[list] = mapped_column(JSON, default=list)

    budget_min: Mapped[float | None] = mapped_column(Float)
    budget_max: Mapped[float | None] = mapped_column(Float)
    min_subsidy_rate: Mapped[float | None] = mapped_column(Float)
    min_days_left: Mapped[int | None] = mapped_column(Integer)

    include_upcoming: Mapped[bool] = mapped_column(Boolean, default=True)
    min_score: Mapped[float | None] = mapped_column(Float)

    # Κανάλια ειδοποίησης (κενό = οι default του συστήματος).
    notify_channels: Mapped[list] = mapped_column(JSON, default=list)
    notify_email: Mapped[str | None] = mapped_column(String(320))
    telegram_chat_id: Mapped[str | None] = mapped_column(String(64))
    webhook_url: Mapped[str | None] = mapped_column(String(1000))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    matches: Mapped[list["Match"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )


class Match(Base):
    """Σύνδεση προγράμματος με προφίλ + σκορ και αιτιολόγηση."""

    __tablename__ = "matches"

    id: Mapped[int] = mapped_column(primary_key=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("profiles.id", ondelete="CASCADE"), index=True)
    program_id: Mapped[int] = mapped_column(ForeignKey("programs.id", ondelete="CASCADE"), index=True)

    score: Mapped[float] = mapped_column(Float, index=True)
    reasons: Mapped[list] = mapped_column(JSON, default=list)
    breakdown: Mapped[dict] = mapped_column(JSON, default=dict)

    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    digested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_reminder_day: Mapped[int | None] = mapped_column(Integer)

    is_dismissed: Mapped[bool] = mapped_column(Boolean, default=False)
    is_saved: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    profile: Mapped[Profile] = relationship(back_populates="matches")
    program: Mapped[Program] = relationship(back_populates="matches")

    __table_args__ = (UniqueConstraint("profile_id", "program_id", name="uq_match_profile_program"),)


class SourceRun(Base):
    """Τηλεμετρία ανά πηγή — για να φαίνεται πότε «σπάει» ένας scraper."""

    __tablename__ = "source_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[str] = mapped_column(String(64), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ok: Mapped[bool] = mapped_column(Boolean, default=False)
    items_found: Mapped[int] = mapped_column(Integer, default=0)
    items_new: Mapped[int] = mapped_column(Integer, default=0)
    items_updated: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)


class NotificationLog(Base):
    """Τι στάλθηκε, πού, πότε — για idempotency και audit."""

    __tablename__ = "notification_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    profile_id: Mapped[int | None] = mapped_column(Integer, index=True)
    channel: Mapped[str] = mapped_column(String(40))
    kind: Mapped[str] = mapped_column(String(40))  # instant | digest | deadline | error
    dedupe_key: Mapped[str] = mapped_column(String(120), index=True)
    subject: Mapped[str | None] = mapped_column(String(500))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    ok: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
