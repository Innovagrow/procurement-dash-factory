#!/usr/bin/env bash
# ============================================================
# ESPA Radar — εγκατάσταση σε Ubuntu/Debian droplet
#
#   sudo bash install.sh
#
# Γραμμένο για μηχάνημα που ΗΔΗ τρέχει άλλα πράγματα και έχει λίγη RAM.
# Κάθε βήμα που τρώει μνήμη τρέχει μέσα σε δικό του cgroup με ταβάνι, ώστε
# σε στενότητα ο kernel να σκοτώσει ΑΥΤΟ και ποτέ ό,τι άλλο τρέχει.
# ============================================================
set -euo pipefail

APP_USER="${APP_USER:-espa}"
APP_DIR="${APP_DIR:-/opt/espa-radar}"
APP_PORT="${APP_PORT:-8077}"
BRANCH="${BRANCH:-claude/espa-program-detection-system-f5ad00}"
REPO="${REPO:-https://github.com/Innovagrow/procurement-dash-factory}"
SERVICE="espa-radar"

MEM_MAX="${MEM_MAX:-110M}"          # ταβάνι υπηρεσίας (μετρημένη κορυφή: 84 MB)
INSTALL_MEM_MAX="${INSTALL_MEM_MAX:-120M}"
SETUP_CADDY="${SETUP_CADDY:-no}"    # ρητή συγκατάθεση — δημοσιεύει τη σελίδα
PROTECT_PATHS="${PROTECT_PATHS:-/opt/listing-classifier /root /home}"

say()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m  ! %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ✓ %s\033[0m\n" "$*"; }
die()  { printf "\033[1;31m  ✗ %s\033[0m\n" "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Τρέξε το με sudo."

# Τρέχει μια εντολή σε cgroup με ταβάνι μνήμης και μέγιστη προτεραιότητα
# θανάτου: αν λείψει μνήμη, θυσιάζεται αυτή, όχι οι υπάρχουσες υπηρεσίες.
#
# Το OOMScoreAdjust ΔΕΝ δίνεται στο systemd-run --scope: είναι ιδιότητα του
# exec context ενός service, και τα scope units δεν έχουν τέτοιο. Το γράφουμε
# απευθείας στο /proc/self/oom_score_adj — κληρονομείται σε fork και exec.
SACRIFICE=(bash -c 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null || true; exec "$@"' _)

USE_SCOPE=0
if command -v systemd-run >/dev/null 2>&1 \
   && systemd-run --scope --quiet --collect \
        -p MemoryMax=64M -p MemorySwapMax=0 -p CPUWeight=20 -p IOWeight=20 \
        -- true >/dev/null 2>&1; then
  USE_SCOPE=1
fi

bounded() {
  if [ "$USE_SCOPE" = "1" ]; then
    systemd-run --scope --quiet --collect \
      -p MemoryMax="$INSTALL_MEM_MAX" -p MemorySwapMax=0 \
      -p CPUWeight=20 -p IOWeight=20 \
      -- "${SACRIFICE[@]}" "$@"
  else
    "${SACRIFICE[@]}" "$@"
  fi
}

# ============================================================
say "Πόροι"
[ "$USE_SCOPE" = "1" ] || warn "χωρίς όριο cgroup στην εγκατάσταση (θυσιάζεται πάντως πρώτη σε OOM)"
MEM_AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
DISK_FREE=$(df -Pm / | awk 'NR==2{print $4}')
echo "  RAM διαθέσιμη: ${MEM_AVAIL} MB   δίσκος ελεύθερος: ${DISK_FREE} MB"
[ "${DISK_FREE:-0}" -lt 400 ] && die "Χρειάζονται ~400 MB ελεύθερα στον δίσκο."
[ "${MEM_AVAIL:-0}" -lt 100 ] && warn "λιγότερα από 100 MB ελεύθερα — η εγκατάσταση ίσως ακυρωθεί μόνη της"
ok "επαρκείς"

say "Υπηρεσίες που ήδη τρέχουν (δεν τις αγγίζουμε)"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null \
  | awk '{print "    " $1}' | grep -v "^    ${SERVICE}" | head -12 || true

# --- Θύρα: idempotent, δεν σκοντάφτει στον εαυτό του -------
# Ο έλεγχος γίνεται με δοκιμαστικό bind μέσω python3, όχι με `ss`: αν το `ss`
# λείπει, το `|| true` θα έκανε τον έλεγχο σιωπηλά άκυρο και θα πέφταμε πάνω
# σε υπάρχουσα υπηρεσία.
say "Θύρα $APP_PORT"
port_is_free() {
  python3 - "$1" <<'PYCHK'
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
PYCHK
}
if port_is_free "$APP_PORT"; then
  ok "ελεύθερη"
elif systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  ok "την κρατά ήδη το $SERVICE — επανεγκατάσταση"
else
  command -v ss >/dev/null 2>&1 && ss -ltnp "( sport = :$APP_PORT )" 2>/dev/null | tail -n +2 | sed 's/^/    /'
  die "Η θύρα $APP_PORT χρησιμοποιείται από άλλη υπηρεσία. Ξανατρέξε με APP_PORT=8078."
fi

# --- Πακέτα: ΧΩΡΙΣ compiler ---------------------------------
# Όλες οι εξαρτήσεις (lxml, psycopg2, pydantic) έχουν έτοιμα manylinux wheels.
# Το build-essential/-dev θα έσερνε αναβαθμίσεις libc/libxml2, και το
# needrestart θα επανεκκινούσε τις υπάρχουσες υπηρεσίες — απαγορευτικό εδώ.
say "Πακέτα συστήματος"
MISSING=""
for pkg in python3 python3-venv git curl; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"
done
if [ -n "$MISSING" ]; then
  echo "  λείπουν:$MISSING"
  export DEBIAN_FRONTEND=noninteractive
  export NEEDRESTART_MODE=l       # κατάγραψε, ΜΗΝ επανεκκινείς τίποτα
  export NEEDRESTART_SUSPEND=1
  bounded apt-get update -qq
  # shellcheck disable=SC2086
  bounded apt-get install -y -qq --no-install-recommends $MISSING
  ok "εγκαταστάθηκαν"
else
  ok "υπάρχουν όλα — κανένα apt"
fi

say "Χρήστης $APP_USER"
id -u "$APP_USER" >/dev/null 2>&1 \
  || useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
ok "έτοιμος"

# --- Κώδικας: το git τρέχει ΠΑΝΤΑ ως ο ίδιος χρήστης --------
say "Κώδικας σε $APP_DIR"
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout -B espa-radar "origin/$BRANCH"
else
  sudo -u "$APP_USER" git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data"
ok "$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)"

say "Python (μόνο έτοιμα wheels, χωρίς μεταγλώττιση)"
[ -x "$APP_DIR/.venv/bin/python" ] || bounded sudo -u "$APP_USER" python3 -m venv "$APP_DIR/.venv"
bounded sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip
if ! bounded sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install \
       --quiet --no-cache-dir --only-binary=:all: -r "$APP_DIR/requirements-espa.txt"; then
  die "Η εγκατάσταση βιβλιοθηκών απέτυχε (πιθανώς έλλειψη μνήμης). Τίποτα δεν άλλαξε στις άλλες υπηρεσίες."
fi
ok "έτοιμο"

# --- Ρυθμίσεις ----------------------------------------------
say "Ρυθμίσεις"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/espa_radar/.env.example" "$APP_DIR/.env"
  {
    echo ""
    echo "# --- προσαρμογή για μικρό droplet ---"
    echo "ESPA_HTTP_CONCURRENCY=1"
    echo "ESPA_SCAN_INTERVAL_MINUTES=240"
    echo "# Χωρίς σάρωση στην εκκίνηση: αλλιώς μια επανεκκίνηση σε βρόχο"
    echo "# θα ξεκινούσε σάρωση κάθε φορά."
    echo "ESPA_SCAN_ON_STARTUP=false"
  } >> "$APP_DIR/.env"
  ok "δημιουργήθηκε"
else
  ok "υπάρχον .env διατηρήθηκε"
fi
# Κλειδί: εξασφαλίζεται ΚΑΙ στο υπάρχον .env, αλλιώς μια επανεγκατάσταση
# θα άφηνε τα endpoints εγγραφής ανοιχτά χωρίς να το πει κανείς.
if ! grep -q '^ESPA_API_KEY=.\+' "$APP_DIR/.env" 2>/dev/null; then
  sed -i '/^ESPA_API_KEY=/d' "$APP_DIR/.env"
  echo "ESPA_API_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)" >> "$APP_DIR/.env"
  ok "δημιουργήθηκε API key"
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# --- systemd -------------------------------------------------
say "Υπηρεσία systemd"
INACCESSIBLE=""
for path in $PROTECT_PATHS; do
  [ -e "$path" ] && INACCESSIBLE="$INACCESSIBLE $path"
done
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=ESPA Radar — ραντάρ προγραμμάτων επιδότησης
After=network-online.target
Wants=network-online.target
# Σταμάτα αν κολλήσει σε βρόχο επανεκκίνησης αντί να τρώει τη CPU για πάντα.
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=ESPA_DATA_DIR=$APP_DIR/data
ExecStart=$APP_DIR/.venv/bin/uvicorn espa_radar.api:app --host 127.0.0.1 --port $APP_PORT
Restart=on-failure
RestartSec=30

# Μνήμη. Το OOMScoreAdjust=1000 είναι αυτό που κάνει τη δουλειά: λέει στον
# kernel να διαλέξει ΑΥΤΗ την υπηρεσία πρώτη σε στενότητα. Το MemoryMax μόνο
# του περιορίζει την κατανάλωση, δεν ορίζει ποιος πεθαίνει.
MemoryMax=$MEM_MAX
MemorySwapMax=0
OOMScoreAdjust=1000
OOMPolicy=stop
CPUWeight=20
IOWeight=20

# Απομόνωση. Το ProtectSystem εμποδίζει ΕΓΓΡΑΦΗ· για να μη ΔΙΑΒΑΣΕΙ η υπηρεσία
# ξένα μυστικά (π.χ. κλειδιά χρηματιστηρίου) χρειάζεται InaccessiblePaths.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/data
InaccessiblePaths=$INACCESSIBLE
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"     # restart, όχι start: μια επανεγκατάσταση πρέπει να φορτώσει τον νέο κώδικα
sleep 5
if systemctl is-active --quiet "$SERVICE"; then
  ok "τρέχει (RSS $(( $(systemctl show "$SERVICE" -p MemoryCurrent --value 2>/dev/null || echo 0) / 1048576 )) MB)"
else
  warn "δεν ξεκίνησε:"
  journalctl -u "$SERVICE" -n 20 --no-pager | sed 's/^/    /'
  die "Δες τα παραπάνω. Καμία άλλη υπηρεσία δεν επηρεάστηκε."
fi

# --- Caddy: μόνο με ρητή συγκατάθεση -------------------------
CADDY_HOST=""
if [ "$SETUP_CADDY" = "yes" ] && command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  IP=$(hostname -I | awk '{print $1}')
  CADDY_HOST="espa.${IP}.sslip.io"
  say "Caddy → $CADDY_HOST"
  if grep -q "$CADDY_HOST" /etc/caddy/Caddyfile; then
    ok "υπάρχει ήδη"
  else
    cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.espa
    cat >> /etc/caddy/Caddyfile <<CADDYCFG

# ESPA Radar — ξεχωριστό site, δεν αγγίζει τα υπόλοιπα.
$CADDY_HOST {
    reverse_proxy 127.0.0.1:$APP_PORT
}
CADDYCFG
    # Το «caddy validate --config» χωρίς --adapter διαβάζει το αρχείο ως JSON
    # και αποτυγχάνει πάντα σε Caddyfile. Επιπλέον το reload της Caddy είναι
    # ατομικό: αν η νέα ρύθμιση είναι άκυρη, κρατά την παλιά και επιστρέφει
    # σφάλμα — οπότε το reload είναι από μόνο του ασφαλής έλεγχος.
    CADDY_ERR=""
    if ! caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      CADDY_ERR="$(caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile 2>&1 | tail -5)"
    elif ! systemctl reload caddy >/dev/null 2>&1; then
      CADDY_ERR="$(journalctl -u caddy -n 10 --no-pager 2>/dev/null | tail -5)"
    fi
    if [ -z "$CADDY_ERR" ]; then
      rm -f /etc/caddy/Caddyfile.bak.espa
      ok "ενεργό — το πιστοποιητικό βγαίνει σε 10-60 δευτερόλεπτα"
    else
      warn "η Caddy δεν δέχτηκε τη ρύθμιση — επαναφορά. Αιτία:"
      echo "$CADDY_ERR" | sed 's/^/      /'
      mv /etc/caddy/Caddyfile.bak.espa /etc/caddy/Caddyfile
      systemctl reload caddy >/dev/null 2>&1 || true
      CADDY_HOST=""
    fi
  fi
elif [ "$SETUP_CADDY" = "yes" ]; then
  warn "δεν βρέθηκε Caddy — παράλειψη"
fi

say "Έλεγχος"
if curl -fsS --max-time 15 "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1; then
  ok "το /health απαντά"
else
  warn "το /health δεν απαντά ακόμη — journalctl -u $SERVICE -n 40"
fi

API_KEY_VALUE="$(grep -m1 '^ESPA_API_KEY=' "$APP_DIR/.env" | cut -d= -f2-)"
cat <<DONE

────────────────────────────────────────────────────────────
 ESPA Radar εγκαταστάθηκε

   τοπικά     http://127.0.0.1:$APP_PORT
$( [ -n "$CADDY_HOST" ] && echo "   δημόσια    https://$CADDY_HOST" || echo "   δημόσια    (κλειστό — δες «Άνοιγμα προς τα έξω» πιο κάτω)" )

   API key    $API_KEY_VALUE
              για POST/PUT/DELETE· η ανάγνωση είναι ανοιχτή αλλά τα
              email/Telegram/webhook εμφανίζονται κρυμμένα χωρίς αυτό

   μνήμη      ταβάνι $MEM_MAX, OOMScoreAdjust=1000
              → σε στενότητα πεθαίνει αυτή, ποτέ οι άλλες υπηρεσίες
   έλεγχος    systemctl status $SERVICE
              journalctl -u $SERVICE -f

 Τι άλλαξε στο μηχάνημα
   + $APP_DIR
   + /etc/systemd/system/$SERVICE.service
   + χρήστης $APP_USER
$( [ -n "$CADDY_HOST" ] && echo "   + ένα site στο /etc/caddy/Caddyfile" )
   Τίποτα άλλο. Καμία υπάρχουσα υπηρεσία δεν επανεκκινήθηκε.

 Επόμενα βήματα
   1. Ειδοποιήσεις:  nano $APP_DIR/.env   → ESPA_SMTP_* ή ESPA_TELEGRAM_*
                     και ESPA_NOTIFY_CHANNELS=console,email
                     systemctl restart $SERVICE
   2. Προφίλ κριτηρίων:
      sudo -u $APP_USER $APP_DIR/.venv/bin/python -m espa_radar.cli \\
        add-profile "Η εταιρεία μου" --sector "Ψηφιακός μετασχηματισμός" \\
        --email you@example.com --channel email
   3. Πρώτη σάρωση (3-5 λεπτά):
      sudo -u $APP_USER $APP_DIR/.venv/bin/python -m espa_radar.cli scan

 Άνοιγμα προς τα έξω
   με Caddy+HTTPS:  sudo SETUP_CADDY=yes bash \$0
   ή SSH τούνελ:    ssh -N -L 8077:127.0.0.1:$APP_PORT root@<ip>
                    και άνοιξε http://localhost:8077

 Απεγκατάσταση
   systemctl disable --now $SERVICE && rm -rf $APP_DIR \\
     /etc/systemd/system/$SERVICE.service && systemctl daemon-reload
────────────────────────────────────────────────────────────
DONE
