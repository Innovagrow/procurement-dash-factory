#!/usr/bin/env bash
# ============================================================
# ESPA Radar — εγκατάσταση σε Ubuntu/Debian droplet
#
#   sudo bash install.sh
#
# Σχεδιασμένο για droplet που ΗΔΗ τρέχει άλλες εφαρμογές:
#  · δεν αγγίζει το default site της nginx
#  · δεν τρέχει apt upgrade
#  · δικός του χρήστης, δικός του φάκελος, δική του θύρα
#  · ξανατρέχει με ασφάλεια (idempotent)
# ============================================================
set -euo pipefail

APP_USER="${APP_USER:-espa}"
APP_DIR="${APP_DIR:-/opt/espa-radar}"
APP_PORT="${APP_PORT:-8077}"      # το 8787 το κρατά ο rally-monitor
BRANCH="${BRANCH:-claude/espa-program-detection-system-f5ad00}"
REPO="${REPO:-https://github.com/Innovagrow/procurement-dash-factory}"
SERVER_NAME="${SERVER_NAME:-}"          # π.χ. espa.example.com — κενό = μόνο τοπικά
SETUP_NGINX="${SETUP_NGINX:-auto}"      # auto | yes | no
SETUP_CADDY="${SETUP_CADDY:-auto}"      # auto | yes | no — αν υπάρχει Caddy
MEM_MAX="${MEM_MAX:-140M}"              # σκληρό ταβάνι RAM για την υπηρεσία
MEM_HIGH="${MEM_HIGH:-110M}"            # πάνω από αυτό ο kernel την πιέζει

say()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m  ! %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ✓ %s\033[0m\n" "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Τρέξε το με sudo."; exit 1; }

# --- Προέλεγχοι --------------------------------------------
say "Πόροι μηχανήματος"
MEM_AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
DISK_FREE=$(df -Pm / | awk 'NR==2{print $4}')
echo "  διαθέσιμη RAM: ${MEM_AVAIL} MB | ελεύθερος δίσκος: ${DISK_FREE} MB"
if [ "$MEM_AVAIL" -lt 120 ]; then
  warn "λιγότερα από 120 MB ελεύθερα — η υπηρεσία θα μπει σε όριο ${MEM_MAX}"
  warn "και δεν μπορεί να επηρεάσει ό,τι άλλο τρέχει, αλλά ίσως σκοτώνεται μόνη της"
fi
[ "$DISK_FREE" -lt 400 ] && { echo "  Χρειάζονται ~400 MB ελεύθερα, υπάρχουν ${DISK_FREE} MB."; exit 1; }
ok "επαρκείς"

say "Τι τρέχει ήδη (δεν το αγγίζουμε)"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null \
  | awk '{print "    " $1}' | grep -vE "espa-radar" | head -12 || true

say "Έλεγχος θύρας $APP_PORT"
if ss -ltn "( sport = :$APP_PORT )" 2>/dev/null | grep -q ":$APP_PORT"; then
  echo "  Η θύρα $APP_PORT χρησιμοποιείται ήδη από:"
  ss -ltnp "( sport = :$APP_PORT )" 2>/dev/null | tail -n +2 | sed 's/^/    /'
  echo "  Ξανατρέξε με άλλη θύρα:  sudo APP_PORT=8078 bash install.sh"
  exit 1
fi
ok "ελεύθερη"

say "Εξαρτήσεις συστήματος"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Μόνο ό,τι λείπει — καμία αναβάθμιση υπαρχόντων πακέτων.
apt-get install -y -qq --no-upgrade \
  python3 python3-venv python3-dev git build-essential libxml2-dev libxslt1-dev curl >/dev/null
ok "εγκαταστάθηκαν"

say "Χρήστης $APP_USER"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
ok "έτοιμος"

say "Κώδικας σε $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -B espa-radar "origin/$BRANCH"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
ok "$(git -C "$APP_DIR" rev-parse --short HEAD)"

say "Python περιβάλλον"
sudo -u "$APP_USER" python3 -m venv "$APP_DIR/.venv" 2>/dev/null || true
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/requirements-espa.txt"
ok "εγκαταστάθηκαν οι βιβλιοθήκες"

say "Ρυθμίσεις"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/espa_radar/.env.example" "$APP_DIR/.env"
  # Προσαρμογή για μικρό μηχάνημα: μία πηγή τη φορά αντί για τέσσερις.
  {
    echo ""
    echo "# --- προσαρμογή για droplet 512 MB ---"
    echo "ESPA_HTTP_CONCURRENCY=1"
    echo "ESPA_SCAN_INTERVAL_MINUTES=240"
  } >> "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  ok "δημιουργήθηκε .env (συμπλήρωσε email/Telegram αργότερα)"
else
  ok "υπάρχον .env διατηρήθηκε"
fi

say "Υπηρεσία systemd"
cat > /etc/systemd/system/espa-radar.service <<UNIT
[Unit]
Description=ESPA Radar — ραντάρ προγραμμάτων επιδότησης
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=ESPA_DATA_DIR=$APP_DIR/data
ExecStart=$APP_DIR/.venv/bin/uvicorn espa_radar.api:app --host 127.0.0.1 --port $APP_PORT
Restart=always
RestartSec=10

# Ταβάνι μνήμης: ό,τι κι αν κάνει η υπηρεσία, ο kernel σταματά ΑΥΤΗΝ και ποτέ
# ό,τι άλλο τρέχει στο μηχάνημα. Μετρημένη κορυφή σάρωσης: ~84 MB.
MemoryHigh=$MEM_HIGH
MemoryMax=$MEM_MAX
MemorySwapMax=0
CPUWeight=20
IOWeight=20
OOMPolicy=continue

# Απομόνωση: η υπηρεσία δεν βλέπει τίποτα άλλο στο droplet.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR/data
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now espa-radar >/dev/null 2>&1
sleep 4
if systemctl is-active --quiet espa-radar; then ok "τρέχει"; else
  warn "δεν ξεκίνησε — δες: journalctl -u espa-radar -n 40"; fi

# --- nginx (μόνο αν υπάρχει ήδη και ζητήθηκε domain) ---------
if [ "$SETUP_NGINX" = "no" ] || { [ "$SETUP_NGINX" = "auto" ] && [ -z "$SERVER_NAME" ]; }; then
  warn "παράλειψη nginx (δεν δόθηκε SERVER_NAME)"
elif ! command -v nginx >/dev/null 2>&1; then
  warn "η nginx δεν είναι εγκατεστημένη — παράλειψη"
else
  say "nginx για $SERVER_NAME"
  cat > /etc/nginx/sites-available/espa-radar <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    access_log /var/log/nginx/espa-radar.access.log;
    error_log  /var/log/nginx/espa-radar.error.log;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;   # μια χειροκίνητη σάρωση θέλει λεπτά
    }
}
NGX
  ln -sf /etc/nginx/sites-available/espa-radar /etc/nginx/sites-enabled/espa-radar
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    ok "ενεργό — δεν πειράχτηκαν τα υπόλοιπα sites"
  else
    warn "σφάλμα ρυθμίσεων nginx — αφαιρώ το site για να μη σπάσει ό,τι ήδη τρέχει"
    rm -f /etc/nginx/sites-enabled/espa-radar
    nginx -t
  fi
fi

# --- Caddy (αν υπάρχει): δημόσιο HTTPS χωρίς domain --------
CADDY_HOST=""
if [ "$SETUP_CADDY" != "no" ] && command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  IP=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  CADDY_HOST="espa.${IP}.sslip.io"
  say "Caddy → $CADDY_HOST"
  if grep -q "$CADDY_HOST" /etc/caddy/Caddyfile; then
    ok "υπάρχει ήδη"
  else
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.espa"
    cat >> /etc/caddy/Caddyfile <<CADDYCFG

# ESPA Radar — προστέθηκε από το install.sh. Ξεχωριστό site· δεν αγγίζει τα υπόλοιπα.
$CADDY_HOST {
    reverse_proxy 127.0.0.1:$APP_PORT
}
CADDYCFG
    if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      systemctl reload caddy && ok "ενεργό (HTTPS αυτόματα από Let's Encrypt)"
    else
      warn "άκυρη ρύθμιση Caddy — επαναφορά, τίποτα δεν έσπασε"
      mv "/etc/caddy/Caddyfile.bak.espa" /etc/caddy/Caddyfile
      systemctl reload caddy || true
      CADDY_HOST=""
    fi
  fi
fi

say "Έλεγχος"
if curl -fsS --max-time 15 "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1; then
  ok "το /health απαντά"
else
  warn "το /health δεν απαντά ακόμη — journalctl -u espa-radar -n 40"
fi

cat <<DONE

────────────────────────────────────────────────────────────
 ESPA Radar εγκαταστάθηκε

   τοπικά     http://127.0.0.1:$APP_PORT
   από έξω    http://$(hostname -I | awk '{print $1}'):$APP_PORT   (αν το firewall το επιτρέπει)
$( [ -n "$CADDY_HOST" ] && echo "   HTTPS      https://$CADDY_HOST" )
$( [ -n "$SERVER_NAME" ] && echo "   domain     http://$SERVER_NAME" )

   μνήμη      όριο $MEM_MAX — δεν μπορεί να επηρεάσει τις άλλες υπηρεσίες
              systemctl show espa-radar -p MemoryCurrent

   κατάσταση  systemctl status espa-radar
   logs       journalctl -u espa-radar -f
   ρυθμίσεις  $APP_DIR/.env   (μετά: systemctl restart espa-radar)

 Επόμενα βήματα
   1. Βάλε email/Telegram στο $APP_DIR/.env
   2. Φτιάξε προφίλ κριτηρίων από τη σελίδα ή:
      sudo -u $APP_USER $APP_DIR/.venv/bin/python -m espa_radar.cli \\
        add-profile "Η εταιρεία μου" --sector "Ψηφιακός μετασχηματισμός" \\
        --email you@example.com --channel email
$( [ -n "$SERVER_NAME" ] && echo "   3. HTTPS:  sudo certbot --nginx -d $SERVER_NAME" )
────────────────────────────────────────────────────────────
DONE
