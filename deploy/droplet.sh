#!/usr/bin/env bash
#
# Στήνει τις σελίδες αποτελεσμάτων σε ένα droplet (Ubuntu/Debian) και τις
# σερβίρει πίσω από κωδικό. Τρέχει ΠΑΝΩ στο droplet, ως root.
#
# ΔΕΝ πειράζει ό,τι ήδη τρέχει εκεί. Πολλά droplet σερβίρουν ήδη κάτι στις
# θύρες 80 και 443· αυτό το script δεν τις διεκδικεί ποτέ. Πιάνει μια ελεύθερη
# θύρα από το 8080 και πάνω, και τυπώνει ποια βρήκε.
#
#     curl -fsSL https://raw.githubusercontent.com/Innovagrow/procurement-dash-factory/claude/greek-brokers-investment-outreach-gr5j9p/deploy/droplet.sh -o /tmp/d.sh && bash /tmp/d.sh
#
# Με συγκεκριμένη θύρα:  PORT=9000 bash /tmp/d.sh
# Είναι idempotent: ξανατρέξτε το όποτε θέλετε.
set -euo pipefail

REPO="https://github.com/Innovagrow/procurement-dash-factory.git"
BRANCH="claude/greek-brokers-investment-outreach-gr5j9p"
APP="/opt/akinita"
WEB="/var/www/akinita"
WEB_USER="${WEB_USER:-admin}"
WEB_PASS="${WEB_PASS:-}"
PORT="${PORT:-}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Τρέξτε το ως root:  sudo bash d.sh"; exit 1; }

say "[1/8] Τι τρέχει ήδη εδώ"
busy() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q . ; }
for p in 80 443; do
  if busy "$p"; then
    echo "  θύρα $p: πιασμένη — δεν την πειράζουμε"
  else
    echo "  θύρα $p: ελεύθερη — και πάλι δεν την πειράζουμε"
  fi
done
# Σε επανεκτέλεση, η θύρα της προηγούμενης εγκατάστασης φαίνεται πιασμένη —
# από εμάς τους ίδιους. Χωρίς αυτό, κάθε τρέξιμο θα μετακόμιζε μια θύρα πιο
# πέρα και το λινκ σας θα άλλαζε από κάτω σας.
SITE="/etc/nginx/sites-available/akinita"
if [ -z "$PORT" ] && [ -f "$SITE" ]; then
  PORT="$(awk '/^[[:space:]]*listen[[:space:]]+[0-9]+/ {gsub(/[^0-9]/, "", $2); print $2; exit}' "$SITE")"
  [ -n "$PORT" ] && echo "  κρατάμε τη θύρα $PORT της προηγούμενης εγκατάστασης"
fi
if [ -z "$PORT" ]; then
  for candidate in 8080 8081 8082 8083 8084 8090; do
    if ! busy "$candidate"; then PORT="$candidate"; break; fi
  done
fi
[ -n "$PORT" ] || { echo "Καμία ελεύθερη θύρα 8080-8090. Δώστε δική σας: PORT=9000 bash d.sh"; exit 1; }
echo "  οι σελίδες θα βγουν στη θύρα $PORT"

say "[2/8] Πακέτα"
export DEBIAN_FRONTEND=noninteractive
NEED=""
command -v git      >/dev/null || NEED="$NEED git"
command -v python3  >/dev/null || NEED="$NEED python3"
command -v nginx    >/dev/null || NEED="$NEED nginx"
command -v htpasswd >/dev/null || NEED="$NEED apache2-utils"
command -v openssl  >/dev/null || NEED="$NEED openssl"
if [ -n "$NEED" ]; then
  echo " εγκατάσταση:$NEED"
  apt-get update -qq
  # Ο nginx προσπαθεί να ξεκινήσει μόλις εγκατασταθεί και η stock σελίδα του
  # ζητά τη θύρα 80. Αν την κρατά ήδη άλλος διακομιστής, αυτό αποτυγχάνει —
  # και σωστά. Δεν είναι λόγος να σταματήσουμε, ούτε να του πάρουμε τη θύρα.
  apt-get install -y -qq $NEED >/dev/null 2>&1 || true
else
  echo "  όλα υπάρχουν ήδη"
fi
command -v nginx >/dev/null || { echo "Ο nginx δεν εγκαταστάθηκε. Δείτε: apt-get install nginx"; exit 1; }

say "[3/8] Κώδικας"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --quiet origin "$BRANCH"
  git -C "$APP" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$APP"
fi

say "[4/8] Παραγωγή σελίδων"
mkdir -p "$WEB"
# Μία σελίδα, με καρτέλες. Η καρτέλα «Ευκαιρίες» γεμίζει από το scan.json που
# ανεβάζετε από τον υπολογιστή σας· χωρίς αυτό βγαίνει άδεια και το λέει.
( cd "$APP" && python3 -m akinita.ethniki --out "$WEB/index.html" \
    --scan "$WEB/scan.json" --json-out "$WEB/simata.json" )
chown -R www-data:www-data "$WEB" 2>/dev/null || true

say "[5/8] Κωδικός πρόσβασης"
if [ -f /etc/nginx/.akinita_htpasswd ] && [ -z "$WEB_PASS" ]; then
  echo "  Υπάρχει ήδη. Αλλαγή:  htpasswd /etc/nginx/.akinita_htpasswd $WEB_USER"
else
  # Δικός σας κωδικός αν δόθηκε, αλλιώς τυχαίος. Ο δικός σας έχει ένα πρακτικό
  # πλεονέκτημα: τον πληκτρολογείτε μία φορά σε κάθε συσκευή χωρίς να τον
  # αντιγράφετε από εδώ.
  PASS="${WEB_PASS:-$(openssl rand -base64 12)}"
  printf '%s' "$PASS" | htpasswd -ic /etc/nginx/.akinita_htpasswd "$WEB_USER" >/dev/null 2>&1
  printf 'χρήστης: %s\nκωδικός: %s\n' "$WEB_USER" "$PASS" > /root/akinita-kwdikos.txt
  chmod 600 /root/akinita-kwdikos.txt
  echo "  Χρήστης: $WEB_USER"
  echo "  Κωδικός: $PASS"
  echo "  Φυλάσσεται και στο /root/akinita-kwdikos.txt"
fi

say "[6/8] nginx στη θύρα $PORT"
# Το listen [::] σε μηχάνημα χωρίς IPv6 δεν αγνοείται: ο nginx αρνείται να
# ξεκινήσει και το `nginx -t` κόβει ολόκληρη την εγκατάσταση. Τα droplet δεν
# έχουν όλα IPv6 — μπαίνει μόνο όταν υπάρχει.
LISTEN6=""
if [ -f /proc/net/if_inet6 ]; then
  LISTEN6="    listen [::]:$PORT;"
  echo "  IPv6 διαθέσιμο — ακούει και εκεί"
else
  echo "  χωρίς IPv6 σε αυτό το μηχάνημα — μόνο IPv4"
fi

cat > "$SITE" <<NGINX
# Μόνο η θύρα $PORT. Ό,τι κι αν σερβίρει αυτό το μηχάνημα στις 80 και 443
# συνεχίζει ανέπαφο.
server {
    listen $PORT;
$LISTEN6
    server_name _;
    root $WEB;
    index index.html;
    charset utf-8;

    auth_basic "Ακίνητα";
    auth_basic_user_file /etc/nginx/.akinita_htpasswd;
    # Όλα τα add_header μαζί, σε ένα επίπεδο: ένα add_header μέσα σε location
    # ακυρώνει ΟΛΑ όσα κληρονομούνται από το server, αντί να προστεθεί σε αυτά.
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Cache-Control "no-cache" always;

    location / { try_files \$uri \$uri/ =404; }
}
NGINX
ln -sf "$SITE" /etc/nginx/sites-enabled/akinita
# Η stock σελίδα του nginx δεσμεύει τη θύρα 80. Αποσύρεται ΜΟΝΟ αν ο nginx δεν
# τρέχει ήδη — αν τρέχει, σερβίρει τα δικά σας και δεν τον πειράζουμε.
if ! systemctl is-active --quiet nginx && [ -e /etc/nginx/sites-enabled/default ]; then
  echo "  απόσυρση της stock σελίδας του nginx (δεν είχε ξεκινήσει)"
  rm -f /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl reload nginx 2>/dev/null || systemctl restart nginx
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  echo "  άνοιξε η θύρα $PORT στο ufw"
fi

say "[7/8] Καθημερινή ανανέωση"
cat > /etc/systemd/system/akinita.service <<UNIT
[Unit]
Description=Ανανέωση χάρτη ευκαιριών από Eurostat και Διαύγεια
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$APP
ExecStart=/usr/bin/python3 -m akinita.ethniki --out $WEB/index.html --scan $WEB/scan.json --json-out $WEB/simata.json
UNIT
cat > /etc/systemd/system/akinita.timer <<'UNIT'
[Unit]
Description=Ανανέωση χάρτη ευκαιριών, καθημερινά

[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now akinita.timer >/dev/null 2>&1

say "[8/8] Αυτοέλεγχος"
FAILED=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }

if head -c 200 "$WEB/index.html" | grep -qi 'charset="utf-8"'; then
  ok "η σελίδα δηλώνει UTF-8"
else
  bad "η σελίδα ΔΕΝ δηλώνει UTF-8"
fi

if nginx -T 2>/dev/null | grep -q "charset utf-8"; then
  ok "ο nginx στέλνει UTF-8"
else
  bad "ο nginx δεν στέλνει UTF-8"
fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/" || echo 000)"
if [ "$CODE" = "401" ]; then
  ok "η σελίδα ζητάει κωδικό"
else
  bad "η σελίδα ΔΕΝ ζητάει κωδικό — απάντησε $CODE"
fi

CREDS=""
if [ -n "${PASS:-}" ]; then
  CREDS="$WEB_USER:$PASS"
elif [ -f /root/akinita-kwdikos.txt ]; then
  SAVED="$(awk -F": " '/κωδικός/ {print $2}' /root/akinita-kwdikos.txt)"
  [ -n "$SAVED" ] && CREDS="$WEB_USER:$SAVED"
fi
if [ -n "$CREDS" ]; then
  CTYPE="$(curl -s -u "$CREDS" -o /tmp/akinita_check.html -w '%{content_type}' --max-time 10 "http://127.0.0.1:$PORT/" || echo "")"
  case "$CTYPE" in
    *charset=utf-8*) ok "η κεφαλίδα HTTP λέει charset=utf-8" ;;
    *) bad "η κεφαλίδα HTTP δεν λέει charset — έστειλε: $CTYPE" ;;
  esac
  if grep -q "Χάρτης ευκαιριών" /tmp/akinita_check.html 2>/dev/null; then
    ok "τα ελληνικά φτάνουν σωστά στον browser"
  else
    bad "τα ελληνικά ΔΕΝ φτάνουν σωστά"
  fi
  rm -f /tmp/akinita_check.html
else
  echo "  · ο έλεγχος με κωδικό παραλείφθηκε: δεν υπάρχει αποθηκευμένος κωδικός"
fi

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "Κάτι από τα παραπάνω απέτυχε. Μην κλείσετε το παράθυρο — στείλτε το."
  exit 1
fi

IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
say "Έτοιμο."
echo "  http://$IP:$PORT/"
echo
echo "  Ανοίξτε το μία φορά σε κάθε συσκευή, δώστε χρήστη και κωδικό, και"
echo "  αποθηκεύστε τα όταν σας το προτείνει ο browser. Δεν θα ξαναρωτήσει."
echo
echo "  Ο χάρτης ανανεώνεται μόνος του κάθε μέρα."
echo "  Ό,τι έτρεχε ήδη στις θύρες 80 και 443 δεν πειράχτηκε."
echo
echo "  Αν δεν ανοίγει, ελέγξτε το cloud firewall του DigitalOcean:"
echo "  Networking - Firewalls - Inbound Rules - επιτρέψτε TCP $PORT"
