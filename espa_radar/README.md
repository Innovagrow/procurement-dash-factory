# 📡 ESPA Radar

Σύστημα που τρέχει **συνεχώς online**, εντοπίζει αυτόματα προγράμματα ΕΣΠΑ και
κάθε άλλη μορφή επιδότησης/χρηματοδότησης, τα ταιριάζει με **τα δικά σου
κριτήρια** και σου στέλνει **ειδοποιήσεις**.

---

## Τι κάνει

```
Πηγές  →  Εμπλουτισμός  →  Αποθήκευση  →  Αντιστοίχιση  →  Ειδοποίηση
```

1. **Συλλογή** — σαρώνει ανά τακτά διαστήματα πύλες χρηματοδότησης (ΕΣΠΑ,
   Ελλάδα 2.0, Διαύγεια, ΕΛΙΔΕΚ, Αγροτική Ανάπτυξη, ΕΠΑνΕΚ, ΔΥΠΑ, EU Portal).
2. **Εμπλουτισμός** — βγάζει από το ελληνικό κείμενο: καταληκτική ημερομηνία,
   προϋπολογισμό ανά έργο, συνολικό προϋπολογισμό δράσης, ένταση ενίσχυσης,
   περιφέρειες, κλάδους, τύπους δικαιούχων, είδος ενίσχυσης, κατάσταση.
3. **Αποθήκευση** — deduplication ανά κανονικοποιημένο URL **και** ανά ομοιότητα
   τίτλου, ώστε το ίδιο πρόγραμμα να μη μετρηθεί δύο φορές όταν το βρίσκουν
   πολλές πηγές. Κρατά ιστορικό μεταβολών (π.χ. παράταση προθεσμίας).
4. **Αντιστοίχιση** — σκορ 0–100 ανά προφίλ κριτηρίων, με **αιτιολόγηση**
   («γιατί σου το δείχνω»).
5. **Ειδοποίηση** — άμεση για υψηλό σκορ, ημερήσια σύνοψη, υπενθυμίσεις
   προθεσμίας, ειδοποίηση όταν αλλάζει κάτι σε πρόγραμμα που παρακολουθείς.

---

## Γρήγορη εκκίνηση

```bash
pip install -r requirements-espa.txt

# 1. Βάση
python -m espa_radar.cli init

# 2. Τα κριτήριά σου
python -m espa_radar.cli add-profile "Η εταιρεία μου" \
  --sector "Ψηφιακός μετασχηματισμός" \
  --sector "Πράσινη μετάβαση / Ενέργεια" \
  --region "Κρήτη" \
  --beneficiary "ΜμΕ" \
  --keyword "ψηφιακός μετασχηματισμός" \
  --keyword "εξοικονόμηση ενέργειας" \
  --budget-min 20000 --budget-max 400000 \
  --min-rate 40 \
  --email "you@example.com" \
  --channel email

# 3. Πρώτη σάρωση
python -m espa_radar.cli scan

# 4. Συνεχής λειτουργία (dashboard + API + scheduler)
python -m espa_radar.cli serve      # http://localhost:8000
```

Με Docker:

```bash
docker compose -f docker-compose.espa.yml up -d
```

---

## Ρύθμιση

Όλα μέσω environment variables — δες το `espa_radar/.env.example`.
Τα βασικά:

| Μεταβλητή | Default | Τι κάνει |
|---|---|---|
| `ESPA_DATABASE_URL` | SQLite στο `./data/` | Postgres για production |
| `ESPA_SCAN_INTERVAL_MINUTES` | `180` | κάθε πόσο σαρώνονται οι πηγές |
| `ESPA_DIGEST_HOUR` / `_MINUTE` | `8` / `30` | ώρα ημερήσιας σύνοψης |
| `ESPA_DEADLINE_REMINDER_DAYS` | `14,7,3,1` | υπενθυμίσεις πριν τη λήξη |
| `ESPA_MIN_SCORE` | `45` | κάτω από αυτό δεν δημιουργείται ταίριασμα |
| `ESPA_INSTANT_MIN_SCORE` | `70` | πάνω από αυτό στέλνεται άμεση ειδοποίηση |
| `ESPA_NOTIFY_CHANNELS` | `console` | `console,email,telegram,webhook` |
| `ESPA_API_KEY` | — | κλειδώνει τα endpoints εγγραφής |

### Κανάλια ειδοποίησης

- **Email** — `ESPA_SMTP_HOST/PORT/USER/PASSWORD/FROM` (Gmail: app password).
- **Telegram** — bot από `@BotFather`, chat id από `@userinfobot`.
- **Webhook** — Slack / Make / n8n / δικό σου endpoint. Αν ορίσεις
  `ESPA_WEBHOOK_SECRET`, το payload υπογράφεται με HMAC-SHA256 στο header
  `X-Espa-Signature`.

Κάθε προφίλ μπορεί να έχει **δικά του** κανάλια και παραλήπτες.

---

## Κριτήρια αναζήτησης

Κάθε διάσταση που **αφήνεις κενή αγνοείται** — δεν χαμηλώνει το σκορ.

| Πεδίο | Παράδειγμα | Ρόλος |
|---|---|---|
| `sectors` | Ψηφιακός μετασχηματισμός | σκορ |
| `regions` | Κρήτη, Αττική | σκορ (κενό = πανελλαδικά) |
| `beneficiaries` | ΜμΕ, Startups | σκορ |
| `keywords` | e-shop, λογισμικό | σκορ (βαρύτερο) |
| `exclude_keywords` | αλιεία | **σκληρό φίλτρο** |
| `budget_min/max` | 20.000–400.000 € | **σκληρό φίλτρο** όταν είναι εκτός εύρους |
| `min_subsidy_rate` | 50 | **σκληρό φίλτρο** όταν το ποσοστό είναι γνωστό |
| `min_days_left` | 10 | **σκληρό φίλτρο** |
| `sources` | greece20_calls | **σκληρό φίλτρο** |

Τις έγκυρες τιμές τις δίνει το `GET /api/taxonomy`.

---

## API

| Endpoint | Τι κάνει |
|---|---|
| `GET /` | dashboard |
| `GET /health` | κατάσταση συστήματος & scheduler |
| `GET/POST /api/profiles` | προφίλ κριτηρίων |
| `PUT/DELETE /api/profiles/{id}` | ενημέρωση / διαγραφή |
| `GET /api/programs` | προγράμματα (`?status=OPEN&source=…&q=…`) |
| `GET /api/matches` | ταιριάσματα (`?profile_id=&min_score=`) |
| `POST /api/matches/{id}/save\|dismiss` | αποθήκευση / απόρριψη |
| `GET /api/sources` | κατάσταση κάθε πηγής |
| `POST /api/scan` | χειροκίνητη σάρωση |
| `POST /api/digest`, `/api/reminders` | χειροκίνητες ειδοποιήσεις |
| `GET /api/taxonomy` | έγκυρες τιμές κριτηρίων |
| `GET /api/notifications` | ιστορικό ειδοποιήσεων |

---

## Προσθήκη νέας πηγής

Χωρίς κώδικα — μια εγγραφή στο `espa_radar/sources.yml`:

```yaml
  - id: nea_pigi
    name: Η Νέα Μου Πηγή
    type: rss              # rss | json | html | diavgeia
    url: https://example.gr/feed/
    limit: 50
```

Έλεγχος: `python -m espa_radar.cli test-source nea_pigi`

**Τύποι πηγών**

- `rss` — RSS/Atom feed. Ο πιο σταθερός.
- `json` — REST API. Υποστηρίζει dotted paths (`title.rendered`), epoch-ms
  ημερομηνίες, `url_template`, και `max_details` για άντληση πλήρους κειμένου
  από τη σελίδα όταν το API δίνει άδειο content.
- `html` — scraping με CSS selectors. Το πιο εύθραυστο.
- `diavgeia` — αναζήτηση στη Διαύγεια. **Χρησιμοποίησε `subject`, όχι `q`**:
  το API αγνοεί σιωπηλά το `q` και θα σου γυρίσει τυχαίες πρόσφατες αποφάσεις.

Σε κάθε πηγή μπορείς να βάλεις `must_match` / `must_not_match` για φιλτράρισμα
συνάφειας — απαραίτητο σε πηγές γενικής αναζήτησης.

---

## Ανθεκτικότητα

- Μια πηγή που πέφτει **δεν ρίχνει τη σάρωση** — καταγράφεται στο
  `GET /api/sources` και στον πίνακα του dashboard.
- Retries με exponential backoff, rate limiting ανά host.
- Αυτόματη αναγνώριση κωδικοποίησης (windows-1253 / ISO-8859-7), γιατί πολλά
  ελληνικά δημόσια sites δεν δηλώνουν σωστό charset.
- Οι ειδοποιήσεις είναι **idempotent**: κάθε ειδοποίηση έχει `dedupe_key` και
  δεν ξαναστέλνεται.

### Πηγές που ίσως δεις «σφάλμα»

Τα `espa.gr`, `antagonistikotita.gr` και `dypa.gov.gr` μπλοκάρουν αιτήματα από
ορισμένα datacenter IP ranges. Από VPS ή από το γραφείο σου δουλεύουν κανονικά.
Αν το site ανοίγει από browser αλλά η πηγή είναι κόκκινη, είναι φραγή IP — όχι
bug. Τα `html` sources μπορεί επίσης να χρειαστούν διόρθωση selector αν αλλάξει
η δομή της σελίδας.

---

## Έλεγχοι

```bash
pip install -r requirements-espa-dev.txt

python tests/test_espa_radar.py     #  53 έλεγχοι — parsing, εξαγωγή, matching
python tests/test_integration.py    # 171 έλεγχοι — πηγές, κανάλια, API, scheduler
```

224 έλεγχοι συνολικά, χωρίς εξωτερικό δίκτυο: σηκώνονται τοπικοί mock servers
(HTTP για τις πηγές και τα webhooks, SMTP για τα email).

Τι καλύπτουν:

- **Parsers** και των τεσσάρων τύπων πηγής, με έλεγχο εξαγωγής προθεσμίας,
  προϋπολογισμού, έντασης ενίσχυσης, περιφερειών, κλάδων, δικαιούχων.
- **Κωδικοποίηση** windows-1253 χωρίς σωστό charset στα headers.
- **Dedupe**: ίδιο URL, σχεδόν ίδιος τίτλος, τροποποιήσεις της ίδιας πρόσκλησης,
  και ταυτόχρονη εγγραφή του ίδιου προγράμματος από δύο σαρώσεις.
- **Κανάλια**: webhook με επαλήθευση HMAC, Telegram με τεμαχισμό μεγάλων
  μηνυμάτων, email μέσω πραγματικού SMTP server, idempotency και αποτυχίες.
- **API**: κάθε endpoint, validation, 404, API key.
- **Scheduler**: ότι τα jobs προγραμματίζονται σε ώρα Ελλάδας και ότι ένα
  σφάλμα σε job δεν ρίχνει τον scheduler.
- **Ακραίες περιπτώσεις**: κενά/None παντού, υπερμεγέθη πεδία, άκυρες
  ημερομηνίες, κακοσχηματισμένα ποσά.

### Σε PostgreSQL

Οι έλεγχοι τρέχουν και στις δύο βάσεις. Για Postgres:

```bash
ESPA_DATABASE_URL="postgresql+psycopg2://user:pass@localhost/espa_test" \
  python tests/test_integration.py
```
