"""
Mail-merge CLI: turn a broker list into personalised, ready-to-send messages.

    # 1. render everything (safe, writes files only)
    python -m damasol.outreach.merge --brokers out/brokers.csv \\
        --channel email --sender-name "..." --reply-email deals@example.com

    # 2. inspect out/campaign/merged.csv and a few .eml drafts

    # 3. only then, and only if you have decided the campaign is compliant:
    python -m damasol.outreach.merge --brokers out/brokers.csv --channel email \\
        --send --confirm-send --max-send 50 ...

Sending is off by default and needs two separate flags plus SMTP credentials in
the environment. Every send is appended to a log, and that log doubles as a
suppression list on the next run, so re-running never mails anyone twice.
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import smtplib
import sys
import time
from email.message import EmailMessage
from typing import Dict, List, Optional, Sequence, Set

from .templates import DEFAULT_IDENTITY, available_templates, render

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")


def _log(message: str) -> None:
    print(message, flush=True)


def read_brokers(path: str) -> List[Dict[str, str]]:
    with open(path, encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_suppression(paths: Sequence[str]) -> Set[str]:
    """Addresses that must never be mailed: opt-outs, bounces, prior sends."""
    suppressed: Set[str] = set()
    for path in paths:
        if not path or not os.path.exists(path):
            continue
        with open(path, encoding="utf-8-sig", newline="") as handle:
            for row in csv.reader(handle):
                for cell in row:
                    cell = cell.strip().lower()
                    if EMAIL_RE.match(cell):
                        suppressed.add(cell)
    return suppressed


def write_eml(path: str, to_address: str, subject: str, body: str, identity: Dict[str, str]) -> None:
    message = EmailMessage()
    from_name = identity.get("sender_name") or identity.get("company", "")
    from_email = identity.get("reply_email", "")
    message["From"] = f"{from_name} <{from_email}>" if from_email else from_name
    message["To"] = to_address
    message["Subject"] = subject
    if from_email:
        message["Reply-To"] = from_email
        # One-click opt-out, as expected of any bulk commercial mail.
        # Keep the value pure ASCII: a Greek subject would be RFC-2047 encoded
        # and mail clients would no longer parse the header.
        message["List-Unsubscribe"] = f"<mailto:{from_email}?subject=UNSUBSCRIBE>"
    message.set_content(body)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(bytes(message))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="damasol.outreach.merge",
        description="Προσωποποιημένα μηνύματα καμπάνιας Damasol ανά μεσίτη.",
    )
    parser.add_argument("--brokers", required=True, help="CSV από το damasol.brokers")
    parser.add_argument("--channel", default="email", choices=available_templates())
    parser.add_argument("--out", default="out/campaign")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--subject-variant", type=int, default=0)
    parser.add_argument("--no-eml", action="store_true", help="Μόνο CSV, χωρίς αρχεία .eml")

    identity = parser.add_argument_group("ταυτότητα αποστολέα")
    identity.add_argument("--company", default=DEFAULT_IDENTITY["company"])
    identity.add_argument("--sender-name", default="")
    identity.add_argument("--sender-title", default=DEFAULT_IDENTITY["sender_title"])
    identity.add_argument("--reply-email", default="")
    identity.add_argument("--phone", default="")
    identity.add_argument("--website", default="")
    identity.add_argument("--ticket-min", default=DEFAULT_IDENTITY["ticket_min"])
    identity.add_argument("--ticket-max", default=DEFAULT_IDENTITY["ticket_max"])

    sending = parser.add_argument_group("αποστολή (απενεργοποιημένη εξ ορισμού)")
    sending.add_argument("--send", action="store_true", help="Ενεργοποίηση αποστολής μέσω SMTP")
    sending.add_argument("--confirm-send", action="store_true",
                         help="Δεύτερη, ρητή επιβεβαίωση. Απαιτείται μαζί με --send.")
    sending.add_argument("--max-send", type=int, default=25, help="Ανώτατο πλήθος ανά εκτέλεση")
    sending.add_argument("--send-delay", type=float, default=6.0, help="Δευτερόλεπτα μεταξύ αποστολών")
    sending.add_argument("--smtp-host", default=os.environ.get("SMTP_HOST", ""))
    sending.add_argument("--smtp-port", type=int, default=int(os.environ.get("SMTP_PORT", "587")))
    sending.add_argument("--smtp-user", default=os.environ.get("SMTP_USER", ""))
    sending.add_argument("--suppress", action="append", default=[],
                         help="Αρχείο(α) CSV με διευθύνσεις προς εξαίρεση. Επαναλαμβανόμενο.")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    identity = {
        "company": args.company,
        "sender_name": args.sender_name,
        "sender_title": args.sender_title,
        "reply_email": args.reply_email,
        "phone": args.phone,
        "website": args.website,
        "ticket_min": args.ticket_min,
        "ticket_max": args.ticket_max,
    }

    brokers = read_brokers(args.brokers)
    _log(f"Διαβάστηκαν {len(brokers)} εγγραφές από {args.brokers}")

    sent_log = args.out + ".sent.csv"
    suppressed = read_suppression(list(args.suppress) + [sent_log])
    if suppressed:
        _log(f"Λίστα εξαίρεσης: {len(suppressed)} διευθύνσεις (opt-out + ήδη σταλμένα)")

    needs_email = args.channel in ("email", "email_en", "follow_up")
    recipients, skipped = [], 0
    for broker in brokers:
        address = (broker.get("email") or "").strip().lower()
        if needs_email:
            if not EMAIL_RE.match(address) or address in suppressed:
                skipped += 1
                continue
        recipients.append(broker)
        if args.limit and len(recipients) >= args.limit:
            break
    _log(f"Παραλήπτες: {len(recipients)} (παραλείφθηκαν {skipped})")

    os.makedirs(args.out, exist_ok=True)
    merged_path = args.out + "/merged.csv"
    rows = []
    for index, broker in enumerate(recipients):
        message = render(
            args.channel,
            broker_name=(broker.get("name") or "").strip(),
            identity=identity,
            subject_variant=args.subject_variant,
        )
        address = (broker.get("email") or "").strip()
        rows.append(
            {
                "name": broker.get("name", ""),
                "email": address,
                "phone": broker.get("phone", ""),
                "address": broker.get("address", ""),
                "profile_url": broker.get("profile_url", ""),
                "subject": message["subject"],
                "body": message["body"],
            }
        )
        if not args.no_eml and needs_email and address:
            write_eml(
                f"{args.out}/eml/{index:05d}_{re.sub(r'[^A-Za-z0-9._-]', '_', address)}.eml",
                address, message["subject"], message["body"], identity,
            )

    with open(merged_path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["name", "email", "phone", "address", "profile_url", "subject", "body"],
        )
        writer.writeheader()
        writer.writerows(rows)
    _log(f"  ✓ {merged_path}")
    if not args.no_eml and needs_email:
        _log(f"  ✓ {args.out}/eml/ ({len(rows)} προσχέδια .eml)")

    # A sample, so the copy is reviewed before anything leaves the building.
    if rows:
        sample_path = args.out + "/preview.txt"
        with open(sample_path, "w", encoding="utf-8") as handle:
            handle.write(f"ΘΕΜΑ: {rows[0]['subject']}\nΠΡΟΣ: {rows[0]['email']}\n\n{rows[0]['body']}")
        _log(f"  ✓ {sample_path}")

    if not args.send:
        _log("\nΗ αποστολή είναι απενεργοποιημένη. Ελέγξτε το preview.txt και το merged.csv.")
        _log("Για αποστολή: --send --confirm-send (και SMTP_PASSWORD στο περιβάλλον).")
        return 0

    if not args.confirm_send:
        _log("\n!! --send χωρίς --confirm-send. Δεν στάλθηκε τίποτα.")
        return 2
    password = os.environ.get("SMTP_PASSWORD", "")
    if not (args.smtp_host and args.smtp_user and password and args.reply_email):
        _log("\n!! Λείπουν SMTP_HOST/SMTP_USER/SMTP_PASSWORD ή --reply-email. Δεν στάλθηκε τίποτα.")
        return 2

    batch = rows[: args.max_send]
    _log(f"\nΑποστολή {len(batch)} μηνυμάτων μέσω {args.smtp_host}:{args.smtp_port}")
    new_log = not os.path.exists(sent_log)
    with smtplib.SMTP(args.smtp_host, args.smtp_port, timeout=30) as server:
        server.starttls()
        server.login(args.smtp_user, password)
        with open(sent_log, "a", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            if new_log:
                writer.writerow(["email", "subject", "sent_at"])
            for position, row in enumerate(batch, 1):
                message = EmailMessage()
                message["From"] = f"{args.sender_name} <{args.reply_email}>"
                message["To"] = row["email"]
                message["Subject"] = row["subject"]
                message["Reply-To"] = args.reply_email
                message["List-Unsubscribe"] = f"<mailto:{args.reply_email}?subject=UNSUBSCRIBE>"
                message.set_content(row["body"])
                try:
                    server.send_message(message)
                    writer.writerow([row["email"], row["subject"],
                                     time.strftime("%Y-%m-%d %H:%M:%S")])
                    handle.flush()
                    _log(f"  [{position}/{len(batch)}] ✓ {row['email']}")
                except smtplib.SMTPException as exc:
                    _log(f"  [{position}/{len(batch)}] ✗ {row['email']}: {exc}")
                time.sleep(args.send_delay)
    _log(f"\nΑρχείο απεσταλμένων: {sent_log} (χρησιμεύει ως λίστα εξαίρεσης στην επόμενη εκτέλεση)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
