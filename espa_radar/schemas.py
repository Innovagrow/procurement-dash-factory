"""Pydantic σχήματα για το API."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProfileIn(BaseModel):
    """Τα κριτήρια του χρήστη. Κενή λίστα = «δεν με νοιάζει αυτή η διάσταση»."""

    name: str = Field(..., min_length=2, max_length=200)
    owner_email: str | None = None
    is_active: bool = True

    regions: list[str] = Field(default_factory=list)
    sectors: list[str] = Field(default_factory=list)
    beneficiaries: list[str] = Field(default_factory=list)
    aid_types: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    exclude_keywords: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)

    budget_min: float | None = None
    budget_max: float | None = None
    min_subsidy_rate: float | None = Field(default=None, ge=0, le=100)
    min_days_left: int | None = Field(default=None, ge=0)

    include_upcoming: bool = True
    min_score: float | None = Field(default=None, ge=0, le=100)

    notify_channels: list[str] = Field(default_factory=list)
    notify_email: str | None = None
    telegram_chat_id: str | None = None
    webhook_url: str | None = None


class ProfileOut(ProfileIn):
    """Πλήρες προφίλ — περιλαμβάνει τους παραλήπτες ειδοποιήσεων.

    Τα πεδία notify_email / telegram_chat_id / webhook_url είναι στοιχεία
    επικοινωνίας. Όταν έχει οριστεί API key, οι μη αυθεντικοποιημένες
    αναγνώσεις τα παίρνουν κρυμμένα (βλ. redact_profile στο api.py).
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    updated_at: datetime


class ProgramOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_id: str
    source_name: str
    title: str
    summary: str | None
    url: str
    status: str
    published_at: datetime | None
    deadline: datetime | None
    budget_total: float | None
    budget_min: float | None
    budget_max: float | None
    subsidy_rate: float | None
    regions: list[str]
    sectors: list[str]
    beneficiaries: list[str]
    aid_types: list[str]
    first_seen_at: datetime


class MatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    profile_id: int
    score: float
    reasons: list[str]
    breakdown: dict
    notified_at: datetime | None
    is_saved: bool
    is_dismissed: bool
    created_at: datetime
    program: ProgramOut


class SourceStatus(BaseModel):
    source_id: str
    name: str
    type: str
    enabled: bool
    last_run: datetime | None = None
    ok: bool | None = None
    items_found: int | None = None
    items_new: int | None = None
    error: str | None = None


class ScanRequest(BaseModel):
    sources: list[str] | None = None
    notify: bool = True
