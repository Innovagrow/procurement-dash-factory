"""Σύνθεση κειμένου ειδοποιήσεων (plain text + HTML)."""
from __future__ import annotations

import html

from .config import settings
from .models import Match, Profile, Program
from .textutils import days_until, fmt_date, fmt_money, similarity, truncate

# Πάνω από αυτό, η περίληψη είναι ουσιαστικά ο τίτλος (συμβαίνει στη Διαύγεια,
# όπου το «θέμα» της απόφασης είναι και τα δύο) και δεν αξίζει να επαναληφθεί.
SUMMARY_REDUNDANT_THRESHOLD = 0.8

STATUS_LABELS = {
    "OPEN": "Ανοιχτή",
    "UPCOMING": "Αναμενόμενη",
    "CLOSED": "Έληξε",
    "UNKNOWN": "Άγνωστη",
}


def useful_summary(program: Program) -> str | None:
    """Η περίληψη, μόνο αν προσθέτει κάτι πέρα από τον τίτλο."""
    if not program.summary:
        return None
    if similarity(program.title, program.summary) >= SUMMARY_REDUNDANT_THRESHOLD:
        return None
    return program.summary


def _deadline_line(program: Program) -> str:
    if program.deadline is None:
        return "Προθεσμία: δεν εντοπίστηκε"
    remaining = days_until(program.deadline)
    if remaining is None:
        return f"Προθεσμία: {fmt_date(program.deadline)}"
    if remaining < 0:
        return f"Προθεσμία: {fmt_date(program.deadline)} (έχει παρέλθει)"
    return f"Προθεσμία: {fmt_date(program.deadline)} — απομένουν {remaining} ημέρες"


def _budget_line(program: Program) -> str:
    parts = []
    if program.budget_min or program.budget_max:
        lo, hi = program.budget_min, program.budget_max
        if lo and hi and lo != hi:
            parts.append(f"Προϋπολογισμός ανά έργο: {fmt_money(lo)} – {fmt_money(hi)}")
        else:
            parts.append(f"Προϋπολογισμός ανά έργο: {fmt_money(hi or lo)}")
    if program.budget_total:
        parts.append(f"Συνολικός προϋπολογισμός δράσης: {fmt_money(program.budget_total)}")
    if program.subsidy_rate:
        parts.append(f"Ένταση ενίσχυσης: έως {program.subsidy_rate:.0f}%")
    return " | ".join(parts) if parts else "Οικονομικά στοιχεία: δεν εντοπίστηκαν"


def program_text(match: Match, index: int | None = None) -> str:
    program = match.program
    prefix = f"{index}. " if index else ""
    lines = [
        f"{prefix}{program.title}",
        f"   Πηγή: {program.source_name} | Κατάσταση: {STATUS_LABELS.get(program.status, program.status)}"
        f" | Ταίριασμα: {match.score:.0f}/100",
        f"   {_deadline_line(program)}",
        f"   {_budget_line(program)}",
    ]
    if program.regions:
        lines.append(f"   Περιοχές: {', '.join(program.regions[:4])}")
    if match.reasons:
        lines.append(f"   Γιατί ταιριάζει: {'; '.join(match.reasons[:4])}")
    summary = useful_summary(program)
    if summary:
        lines.append(f"   {truncate(summary, 220)}")
    lines.append(f"   → {program.url}")
    return "\n".join(lines)


def program_html(match: Match) -> str:
    program = match.program
    esc = html.escape
    reasons = "; ".join(match.reasons[:4]) if match.reasons else ""
    summary = useful_summary(program)
    return f"""
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
      <div style="font-size:12px;color:#64748b;margin-bottom:6px">
        {esc(program.source_name)} &middot; {esc(STATUS_LABELS.get(program.status, program.status))}
        &middot; <strong style="color:#0f766e">Ταίριασμα {match.score:.0f}/100</strong>
      </div>
      <a href="{esc(program.url)}" style="font-size:16px;font-weight:600;color:#0f172a;text-decoration:none">
        {esc(program.title)}
      </a>
      <div style="font-size:13px;color:#334155;margin-top:8px">{esc(_deadline_line(program))}</div>
      <div style="font-size:13px;color:#334155">{esc(_budget_line(program))}</div>
      {f'<div style="font-size:13px;color:#0f766e;margin-top:6px">Γιατί: {esc(reasons)}</div>' if reasons else ''}
      {f'<div style="font-size:13px;color:#475569;margin-top:8px">{esc(truncate(summary, 260))}</div>' if summary else ''}
      <div style="margin-top:10px">
        <a href="{esc(program.url)}" style="font-size:13px;color:#2563eb">Άνοιγμα πρόσκλησης &rarr;</a>
      </div>
    </div>
    """


def _footer() -> str:
    if settings.public_base_url:
        return f"\n\nΠίνακας ελέγχου: {settings.public_base_url.rstrip('/')}/\n"
    return "\n\n— ESPA Radar\n"


def instant_message(profile: Profile, match: Match) -> tuple[str, str, str]:
    """(θέμα, κείμενο, html) για άμεση ειδοποίηση ενός προγράμματος."""
    program = match.program
    subject = f"🎯 Νέα ευκαιρία ({match.score:.0f}/100): {truncate(program.title, 90)}"
    text = (
        f"Προφίλ: {profile.name}\n\n"
        f"{program_text(match)}\n"
        f"{_footer()}"
    )
    body = f"""
    <div style="max-width:640px;margin:0 auto;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
      <h2 style="color:#0f172a;font-size:18px">🎯 Νέα ευκαιρία χρηματοδότησης</h2>
      <p style="color:#475569;font-size:13px">Προφίλ: <strong>{html.escape(profile.name)}</strong></p>
      {program_html(match)}
    </div>
    """
    return subject, text, body


def digest_message(profile: Profile, matches: list[Match]) -> tuple[str, str, str]:
    """(θέμα, κείμενο, html) για ημερήσια σύνοψη."""
    count = len(matches)
    subject = f"📋 {count} νέα προγράμματα για «{profile.name}»"

    lines = [f"Προφίλ: {profile.name}", f"Νέα ταιριάσματα: {count}", ""]
    for index, match in enumerate(matches, start=1):
        lines.append(program_text(match, index))
        lines.append("")
    text = "\n".join(lines) + _footer()

    cards = "".join(program_html(m) for m in matches)
    body = f"""
    <div style="max-width:680px;margin:0 auto;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
      <h2 style="color:#0f172a;font-size:18px">📋 Ημερήσια σύνοψη — {html.escape(profile.name)}</h2>
      <p style="color:#475569;font-size:13px">{count} νέα προγράμματα ταιριάζουν με τα κριτήριά σου.</p>
      {cards}
    </div>
    """
    return subject, text, body


def deadline_message(profile: Profile, match: Match, days: int) -> tuple[str, str, str]:
    program = match.program
    urgency = "σήμερα" if days == 0 else f"σε {days} ημέρ{'α' if days == 1 else 'ες'}"
    subject = f"⏰ Λήγει {urgency}: {truncate(program.title, 80)}"
    text = f"Προφίλ: {profile.name}\n\nΗ προθεσμία λήγει {urgency}.\n\n{program_text(match)}{_footer()}"
    body = f"""
    <div style="max-width:640px;margin:0 auto;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
      <h2 style="color:#b91c1c;font-size:18px">⏰ Η προθεσμία λήγει {html.escape(urgency)}</h2>
      <p style="color:#475569;font-size:13px">Προφίλ: <strong>{html.escape(profile.name)}</strong></p>
      {program_html(match)}
    </div>
    """
    return subject, text, body


def change_message(profile: Profile, match: Match, changes: list[str]) -> tuple[str, str, str]:
    program = match.program
    subject = f"🔄 Αλλαγή σε πρόγραμμα: {truncate(program.title, 80)}"
    detail = "\n".join(f"   • {c}" for c in changes)
    text = f"Προφίλ: {profile.name}\n\nΤι άλλαξε:\n{detail}\n\n{program_text(match)}{_footer()}"
    items = "".join(f"<li style='font-size:13px;color:#334155'>{html.escape(c)}</li>" for c in changes)
    body = f"""
    <div style="max-width:640px;margin:0 auto;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
      <h2 style="color:#0f172a;font-size:18px">🔄 Αλλαγή σε πρόγραμμα που παρακολουθείς</h2>
      <ul>{items}</ul>
      {program_html(match)}
    </div>
    """
    return subject, text, body
