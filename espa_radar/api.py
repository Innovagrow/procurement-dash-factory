"""FastAPI εφαρμογή: REST API + dashboard + συνεχής scheduler."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from .config import BASE_DIR, settings
from .db import get_session, init_db
from .models import Match, NotificationLog, Profile, Program, SourceRun
from .pipeline import run_matching, scan, send_deadline_reminders, send_digest
from .schemas import MatchOut, ProfileIn, ProfileOut, ProgramOut, ScanRequest, SourceStatus
from .scheduler import scheduler_status, start_scheduler, stop_scheduler
from .sources import load_source_config
from .taxonomy import ALL_AID_TYPES, ALL_BENEFICIARIES, ALL_REGIONS, ALL_SECTORS
from .textutils import days_until, fmt_date, fmt_money

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.filters["money"] = fmt_money
templates.env.filters["date"] = fmt_date
templates.env.filters["days_left"] = days_until


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info("📡 ESPA Radar ξεκινά — βάση: %s", settings.database_url.split("@")[-1])
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(
    title="ESPA Radar",
    description="Συνεχής εντοπισμός προγραμμάτων ΕΣΠΑ και άλλων επιδοτήσεων, με ειδοποιήσεις.",
    version="1.0.0",
    lifespan=lifespan,
)


# ============================================================
# Ασφάλεια (προαιρετικό API key για τα endpoints εγγραφής)
# ============================================================

def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if settings.api_key and x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="Μη έγκυρο API key")


# ============================================================
# Dashboard
# ============================================================

@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request, session: Session = Depends(get_session)):
    profiles = session.scalars(select(Profile).order_by(Profile.created_at)).all()

    matches = session.scalars(
        select(Match)
        .where(Match.is_dismissed.is_(False))
        .order_by(desc(Match.score), desc(Match.created_at))
        .limit(60)
    ).all()

    stats = {
        "programs": session.scalar(select(func.count(Program.id))) or 0,
        "open": session.scalar(select(func.count(Program.id)).where(Program.status == "OPEN")) or 0,
        "profiles": len([p for p in profiles if p.is_active]),
        "matches": session.scalar(select(func.count(Match.id)).where(Match.is_dismissed.is_(False))) or 0,
        "notifications": session.scalar(
            select(func.count(NotificationLog.id)).where(NotificationLog.ok.is_(True))
        ) or 0,
    }

    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "stats": stats,
            "matches": matches,
            "profiles": profiles,
            "sources": _source_status(session),
            "jobs": scheduler_status(),
            "taxonomy": {
                "regions": ALL_REGIONS,
                "sectors": ALL_SECTORS,
                "beneficiaries": ALL_BENEFICIARIES,
                "aid_types": ALL_AID_TYPES,
            },
        },
    )


# ============================================================
# Προφίλ κριτηρίων
# ============================================================

@app.get("/api/profiles", response_model=list[ProfileOut])
def list_profiles(session: Session = Depends(get_session)):
    return session.scalars(select(Profile).order_by(Profile.created_at)).all()


@app.post("/api/profiles", response_model=ProfileOut, status_code=201,
          dependencies=[Depends(require_api_key)])
def create_profile(payload: ProfileIn, session: Session = Depends(get_session)):
    profile = Profile(**payload.model_dump())
    session.add(profile)
    session.commit()
    session.refresh(profile)
    # Αξιολόγηση αμέσως, ώστε ο χρήστης να δει άμεσα αποτελέσματα.
    run_matching(profile_id=profile.id)
    return profile


@app.get("/api/profiles/{profile_id}", response_model=ProfileOut)
def get_profile(profile_id: int, session: Session = Depends(get_session)):
    profile = session.get(Profile, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Το προφίλ δεν βρέθηκε")
    return profile


@app.put("/api/profiles/{profile_id}", response_model=ProfileOut,
         dependencies=[Depends(require_api_key)])
def update_profile(profile_id: int, payload: ProfileIn, session: Session = Depends(get_session)):
    profile = session.get(Profile, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Το προφίλ δεν βρέθηκε")
    for key, value in payload.model_dump().items():
        setattr(profile, key, value)
    session.commit()
    session.refresh(profile)
    run_matching(profile_id=profile.id)
    return profile


@app.delete("/api/profiles/{profile_id}", status_code=204,
            dependencies=[Depends(require_api_key)])
def delete_profile(profile_id: int, session: Session = Depends(get_session)):
    profile = session.get(Profile, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Το προφίλ δεν βρέθηκε")
    session.delete(profile)
    session.commit()


# ============================================================
# Προγράμματα & ταιριάσματα
# ============================================================

@app.get("/api/programs", response_model=list[ProgramOut])
def list_programs(
    session: Session = Depends(get_session),
    status: str | None = None,
    source: str | None = None,
    q: str | None = None,
    limit: int = Query(default=50, le=500),
    offset: int = 0,
):
    query = select(Program)
    if status:
        query = query.where(Program.status == status.upper())
    if source:
        query = query.where(Program.source_id == source)
    if q:
        pattern = f"%{q}%"
        query = query.where(Program.title.ilike(pattern) | Program.summary.ilike(pattern))
    query = query.order_by(desc(Program.first_seen_at)).limit(limit).offset(offset)
    return session.scalars(query).all()


@app.get("/api/programs/{program_id}", response_model=ProgramOut)
def get_program(program_id: int, session: Session = Depends(get_session)):
    program = session.get(Program, program_id)
    if program is None:
        raise HTTPException(status_code=404, detail="Το πρόγραμμα δεν βρέθηκε")
    return program


@app.get("/api/matches", response_model=list[MatchOut])
def list_matches(
    session: Session = Depends(get_session),
    profile_id: int | None = None,
    min_score: float = 0.0,
    include_dismissed: bool = False,
    limit: int = Query(default=50, le=500),
):
    query = select(Match).where(Match.score >= min_score)
    if profile_id is not None:
        query = query.where(Match.profile_id == profile_id)
    if not include_dismissed:
        query = query.where(Match.is_dismissed.is_(False))
    query = query.order_by(desc(Match.score)).limit(limit)
    return session.scalars(query).all()


@app.post("/api/matches/{match_id}/save", dependencies=[Depends(require_api_key)])
def save_match(match_id: int, session: Session = Depends(get_session)):
    return _flag_match(session, match_id, saved=True)


@app.post("/api/matches/{match_id}/dismiss", dependencies=[Depends(require_api_key)])
def dismiss_match(match_id: int, session: Session = Depends(get_session)):
    return _flag_match(session, match_id, dismissed=True)


def _flag_match(session: Session, match_id: int, saved: bool | None = None,
                dismissed: bool | None = None) -> dict:
    match = session.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Το ταίριασμα δεν βρέθηκε")
    if saved is not None:
        match.is_saved = saved
    if dismissed is not None:
        match.is_dismissed = dismissed
    session.commit()
    return {"id": match.id, "is_saved": match.is_saved, "is_dismissed": match.is_dismissed}


# ============================================================
# Λειτουργία συστήματος
# ============================================================

@app.get("/api/sources", response_model=list[SourceStatus])
def list_sources(session: Session = Depends(get_session)):
    return _source_status(session)


def _source_status(session: Session) -> list[SourceStatus]:
    """Κατάσταση κάθε πηγής με βάση την τελευταία εκτέλεση."""
    statuses: list[SourceStatus] = []
    for entry in load_source_config():
        source_id = entry.get("id")
        if not source_id:
            continue
        last = session.scalars(
            select(SourceRun)
            .where(SourceRun.source_id == source_id)
            .order_by(desc(SourceRun.started_at))
            .limit(1)
        ).first()
        statuses.append(
            SourceStatus(
                source_id=source_id,
                name=entry.get("name", source_id),
                type=entry.get("type", "?"),
                enabled=bool(entry.get("enabled", True)),
                last_run=last.started_at if last else None,
                ok=last.ok if last else None,
                items_found=last.items_found if last else None,
                items_new=last.items_new if last else None,
                error=last.error if last else None,
            )
        )
    return statuses


@app.post("/api/scan", dependencies=[Depends(require_api_key)])
def trigger_scan(payload: ScanRequest | None = None):
    """Χειροκίνητη σάρωση (σύγχρονη — μπορεί να πάρει λεπτά)."""
    payload = payload or ScanRequest()
    report = scan(only=payload.sources, notify_matches=payload.notify)
    return report.as_dict()


@app.post("/api/digest", dependencies=[Depends(require_api_key)])
def trigger_digest():
    return {"sent": send_digest()}


@app.post("/api/reminders", dependencies=[Depends(require_api_key)])
def trigger_reminders():
    return {"sent": send_deadline_reminders()}


@app.get("/api/taxonomy")
def get_taxonomy():
    """Οι έγκυρες τιμές για τα πεδία κριτηρίων."""
    return {
        "regions": ALL_REGIONS,
        "sectors": ALL_SECTORS,
        "beneficiaries": ALL_BENEFICIARIES,
        "aid_types": ALL_AID_TYPES,
        "sources": [
            {"id": e.get("id"), "name": e.get("name")} for e in load_source_config()
        ],
    }


@app.get("/api/notifications")
def list_notifications(session: Session = Depends(get_session), limit: int = Query(50, le=500)):
    logs = session.scalars(
        select(NotificationLog).order_by(desc(NotificationLog.created_at)).limit(limit)
    ).all()
    return [
        {
            "id": log.id,
            "profile_id": log.profile_id,
            "channel": log.channel,
            "kind": log.kind,
            "subject": log.subject,
            "ok": log.ok,
            "error": log.error,
            "created_at": log.created_at,
        }
        for log in logs
    ]


@app.get("/health")
def health(session: Session = Depends(get_session)):
    try:
        programs = session.scalar(select(func.count(Program.id))) or 0
        db_ok = True
    except Exception as exc:  # noqa: BLE001
        logger.error("Health check DB error: %s", exc)
        programs, db_ok = 0, False

    return JSONResponse(
        status_code=200 if db_ok else 503,
        content={
            "status": "ok" if db_ok else "degraded",
            "database": db_ok,
            "programs": programs,
            "scheduler": bool(scheduler_status()),
            "jobs": scheduler_status(),
        },
    )
