"""FastAPI εφαρμογή: REST API + dashboard + συνεχής scheduler."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from .config import BASE_DIR, settings
from .db import get_session, init_db
from .models import Match, NotificationLog, Profile, Program, SourceRun
from .pipeline import (
    reclassify_all,
    run_matching,
    scan,
    send_deadline_reminders,
    send_digest,
)
from .schemas import MatchOut, ProfileIn, ProfileOut, ProgramOut, ScanRequest, SourceStatus
from .scheduler import scheduler_status, start_scheduler, stop_scheduler
from .sources import load_source_config
from .taxonomy import ALL_AID_TYPES, ALL_BENEFICIARIES, ALL_REGIONS, ALL_SECTORS
from .textutils import utcnow

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)



def _validate_settings() -> None:
    """Προειδοποιήσεις για ρυθμίσεις που θα αποτύγχαναν σιωπηλά."""
    if settings.api_key:
        try:
            settings.api_key.encode("ascii")
        except UnicodeEncodeError:
            logger.warning(
                "Το ESPA_API_KEY περιέχει μη-ASCII χαρακτήρες. Οι HTTP headers "
                "επιτρέπουν μόνο ASCII, οπότε κανένας client δεν θα μπορεί να "
                "αυθεντικοποιηθεί. Χρησιμοποίησε λατινικούς χαρακτήρες/αριθμούς."
            )
    if settings.notify_instant_min_score < settings.default_min_score:
        logger.warning(
            "Το ESPA_INSTANT_MIN_SCORE (%s) είναι κάτω από το ESPA_MIN_SCORE (%s): "
            "κάθε ταίριασμα θα στέλνεται ως άμεση ειδοποίηση.",
            settings.notify_instant_min_score, settings.default_min_score,
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    _validate_settings()
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


# Το /api/dashboard είναι εκατοντάδες KB JSON· χωρίς συμπίεση το φόρτωμα
# μέσω SSH τούνελ ή κινητού είναι αισθητά αργό.
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ============================================================
# Ασφάλεια (προαιρετικό API key για τα endpoints εγγραφής)
# ============================================================

def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if settings.api_key and x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="Μη έγκυρο API key")


def is_authenticated(x_api_key: str | None = Header(default=None)) -> bool:
    """Χωρίς ρυθμισμένο κλειδί όλα είναι ανοιχτά (τοπική χρήση)."""
    if not settings.api_key:
        return True
    return x_api_key == settings.api_key


# Πεδία που είναι στοιχεία επικοινωνίας, όχι κριτήρια αναζήτησης.
_CONTACT_FIELDS = ("notify_email", "telegram_chat_id", "webhook_url", "owner_email")


def redact_profile(profile: Profile, authenticated: bool) -> dict:
    """Το προφίλ ως dict, με κρυμμένους τους παραλήπτες αν δεν έχει κλειδί.

    Χωρίς αυτό, μια δημόσια εγκατάσταση θα έδινε σε οποιονδήποτε το email,
    το Telegram chat id και το webhook URL κάθε χρήστη.
    """
    data = {
        column.name: getattr(profile, column.name)
        for column in Profile.__table__.columns
    }
    if not authenticated:
        for field in _CONTACT_FIELDS:
            if data.get(field):
                data[field] = "···"
    return data


# ============================================================
# Dashboard
# ============================================================

DASHBOARD_FILE = BASE_DIR / "templates" / "dashboard.html"


@app.get("/", response_class=HTMLResponse)
def dashboard() -> HTMLResponse:
    """Η σελίδα. Τα δεδομένα έρχονται από το /api/dashboard με μία κλήση."""
    try:
        return HTMLResponse(DASHBOARD_FILE.read_text(encoding="utf-8"))
    except OSError as exc:
        logger.error("Δεν βρέθηκε το dashboard: %s", exc)
        raise HTTPException(status_code=500, detail="Λείπει το αρχείο της σελίδας")


# ============================================================
# Προφίλ κριτηρίων
# ============================================================

@app.get("/api/profiles", response_model=list[ProfileOut])
def list_profiles(
    session: Session = Depends(get_session),
    authenticated: bool = Depends(is_authenticated),
):
    profiles = session.scalars(select(Profile).order_by(Profile.created_at)).all()
    return [redact_profile(p, authenticated) for p in profiles]


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
def get_profile(
    profile_id: int,
    session: Session = Depends(get_session),
    authenticated: bool = Depends(is_authenticated),
):
    profile = session.get(Profile, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Το προφίλ δεν βρέθηκε")
    return redact_profile(profile, authenticated)


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


@app.get("/api/sources/{source_id}/probe", dependencies=[Depends(require_api_key)])
def probe_source(source_id: str):
    """Τι βλέπει ο server σε μια πηγή — για διόρθωση selector από απόσταση.

    Πολλά ελληνικά δημόσια sites μπλοκάρουν αιτήματα από άλλα δίκτυα, οπότε
    όταν ένας selector σπάει δεν μπορεί να τον ελέγξει κανείς εκτός του
    μηχανήματος. Το endpoint φέρνει ΜΟΝΟ URL που ήδη υπάρχουν στο sources.yml,
    ώστε να μη γίνεται γενικός fetcher ξένων διευθύνσεων.
    """
    entry = next((e for e in load_source_config() if e.get("id") == source_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Άγνωστη πηγή")

    url = entry.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Η πηγή δεν έχει url (π.χ. τύπου diavgeia)")

    from .sources.http import get

    try:
        response = get(url, timeout=45, retries=1)
    except Exception as exc:  # noqa: BLE001
        return {"source_id": source_id, "url": url, "error": str(exc)[:500]}

    from .sources.http import _decode

    text = _decode(response.content, response.charset_encoding)
    result = {
        "source_id": source_id,
        "url": url,
        "status": response.status_code,
        "content_type": response.headers.get("content-type"),
        "bytes": len(response.content),
        "head": text[:1500],
    }

    if "xml" in (response.headers.get("content-type") or "") or text.lstrip().startswith("<?xml"):
        return result

    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(text, "lxml")
    except Exception as exc:  # noqa: BLE001
        result["parse_error"] = str(exc)[:200]
        return result

    # Υποψήφιοι selectors με πλήθος, ώστε να φαίνεται ποιος περιγράφει λίστα.
    candidates = [
        "article", "table tr", "tbody tr", "li", ".row", ".card", ".item",
        ".news-item", ".list-item", ".views-row", ".post", ".entry",
        ".proclamation", ".call", "div.result", "ul li a", "h2 a", "h3 a",
        ".panel", ".accordion-item", "[class*=item]", "[class*=list]", "[class*=row]",
    ]
    counts = {}
    for sel in candidates:
        try:
            n = len(soup.select(sel))
        except Exception:  # noqa: BLE001
            continue
        if n:
            counts[sel] = n
    result["selector_counts"] = dict(sorted(counts.items(), key=lambda kv: -kv[1])[:25])

    links = []
    for a in soup.find_all("a", href=True)[:400]:
        label = " ".join(a.get_text(" ", strip=True).split())
        if len(label) >= 25:
            links.append({"text": label[:130], "href": a["href"][:220],
                          "parent": a.parent.name,
                          "parent_class": " ".join(a.parent.get("class") or [])[:60]})
    result["long_links"] = links[:30]

    classes = {}
    for node in soup.find_all(class_=True)[:3000]:
        for cls in node.get("class") or []:
            classes[cls] = classes.get(cls, 0) + 1
    result["common_classes"] = dict(sorted(classes.items(), key=lambda kv: -kv[1])[:30])
    return result


@app.post("/api/scan", dependencies=[Depends(require_api_key)])
def trigger_scan(payload: ScanRequest | None = None):
    """Χειροκίνητη σάρωση (σύγχρονη — μπορεί να πάρει λεπτά)."""
    payload = payload or ScanRequest()
    report = scan(only=payload.sources, notify_matches=payload.notify)
    return report.as_dict()


@app.post("/api/reclassify", dependencies=[Depends(require_api_key)])
def trigger_reclassify():
    """Ξαναταξινομεί ό,τι υπάρχει, χωρίς νέα σάρωση."""
    return reclassify_all()


@app.post("/api/digest", dependencies=[Depends(require_api_key)])
def trigger_digest():
    return {"sent": send_digest()}


@app.post("/api/reminders", dependencies=[Depends(require_api_key)])
def trigger_reminders():
    return {"sent": send_deadline_reminders()}


@app.get("/api/dashboard")
def dashboard_data(
    session: Session = Depends(get_session),
    limit: int = Query(default=1000, le=5000),
):
    """Ό,τι χρειάζεται η σελίδα, με μία κλήση.

    Το φιλτράρισμα και η βαθμολόγηση γίνονται στον browser, ώστε να μη χρειάζεται
    ένα αίτημα ανά αλλαγή κριτηρίου σε μηχάνημα με 1 vCPU.
    """
    programs = session.scalars(
        select(Program).order_by(desc(Program.first_seen_at)).limit(limit)
    ).all()

    last_runs = {}
    for run in session.scalars(select(SourceRun).order_by(SourceRun.started_at)).all():
        last_runs[run.source_id] = run

    latest = max((r.started_at for r in last_runs.values()), default=None)

    return {
        "generated": utcnow(),
        "stats": {
            "programs": session.scalar(select(func.count(Program.id))) or 0,
            "open": session.scalar(
                select(func.count(Program.id)).where(Program.status == "OPEN")
            ) or 0,
            "deadline": session.scalar(
                select(func.count(Program.id)).where(Program.deadline.is_not(None))
            ) or 0,
            "profiles": session.scalar(
                select(func.count(Profile.id)).where(Profile.is_active.is_(True))
            ) or 0,
            "matches": session.scalar(
                select(func.count(Match.id)).where(Match.is_dismissed.is_(False))
            ) or 0,
            "notifications": session.scalar(
                select(func.count(NotificationLog.id)).where(NotificationLog.ok.is_(True))
            ) or 0,
        },
        "scheduler": {"jobs": scheduler_status()},
        "last_scan": latest,
        "sources": [
            {
                "id": entry.get("id"),
                "name": entry.get("name"),
                "type": entry.get("type"),
                "enabled": bool(entry.get("enabled", True)),
                "ok": last_runs[entry["id"]].ok if entry.get("id") in last_runs else None,
                "n": last_runs[entry["id"]].items_found if entry.get("id") in last_runs else None,
                "new": last_runs[entry["id"]].items_new if entry.get("id") in last_runs else None,
                "err": (last_runs[entry["id"]].error or "")[:200] if entry.get("id") in last_runs else None,
                "at": last_runs[entry["id"]].started_at if entry.get("id") in last_runs else None,
            }
            for entry in load_source_config()
            if entry.get("id")
        ],
        "taxonomy": {
            "regions": ALL_REGIONS,
            "sectors": ALL_SECTORS,
            "beneficiaries": ALL_BENEFICIARIES,
            "aid_types": ALL_AID_TYPES,
        },
        "programs": [
            {
                "id": p.id,
                "t": p.title,
                "u": p.url,
                "s": p.source_id,
                "sn": p.source_name,
                "st": p.status,
                "k": p.kind,
                "dl": p.deadline.date().isoformat() if p.deadline else None,
                "pd": p.published_at.date().isoformat() if p.published_at else None,
                "bmin": p.budget_min,
                "bmax": p.budget_max,
                "r": p.subsidy_rate,
                "reg": p.regions or [],
                "sec": p.sectors or [],
                "ben": p.beneficiaries or [],
                "sum": (p.summary or "")[:400] or None,
                "ada": (p.raw or {}).get("ada"),
            }
            for p in programs
        ],
    }


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
