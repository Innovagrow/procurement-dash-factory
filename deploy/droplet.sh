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

say "[1/7] Τι τρέχει ήδη εδώ"
busy() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q . ; }
for p in 80 443; do
  if busy "$p"; then
    echo "  θύρα $p: πιασμένη — δεν την πειράζουμε"
  else
    echo "  θύρα $p: ελεύθερη — και πάλι δεν την πειράζουμε"
  fi
done
if [ -z "$PORT" ]; then
  for candidate in 8080 8081 8082 8083 8084 8090; do
    if ! busy "$candidate"; then PORT="$candidate"; break; fi
  done
fi
[ -n "$PORT" ] || { echo "Καμία ελεύθερη θύρα 8080-8090. Δώστε δική σας: PORT=9000 bash d.sh"; exit 1; }
echo "  οι σελίδες θα βγουν στη θύρα $PORT"

say "[2/7] Πακέτα"
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

say "[3/7] Κώδικας"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --quiet origin "$BRANCH"
  git -C "$APP" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$APP"
fi

say "[4/7] Παραγωγή σελίδων"
mkdir -p "$WEB"
( cd "$APP" && python3 -m akinita.ethniki --out "$WEB/index.html" --json-out "$WEB/simata.json" )
[ -f "$WEB/apotelesmata.html" ] || cat > "$WEB/apotelesmata.html" <<'PLACEHOLDER'
<!doctype html><html lang="el"><head><meta charset="utf-8">
<title>Αναφορά — δεν έχει ανέβει ακόμη</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:54ch;margin:12vh auto;padding:0 20px;
color:#171A1F;background:#ECEEF1}code{background:#E1E5EB;border-radius:4px;font-size:13.5px;
display:block;margin-top:14px;padding:12px;overflow-x:auto}
@media(prefers-color-scheme:dark){body{background:#101317;color:#E7EBF0}code{background:#0B0E12}}
</style></head><body>
<h1>Η αναφορά δεν έχει ανέβει ακόμη</h1>
<p>Τρέξτε τη σάρωση στον υπολογιστή σας και ανεβάστε τη σελίδα εδώ:</p>
<code>scp out\apotelesmata.html root@ΤΟ-IP:/var/www/akinita/apotelesmata.html</code>
<p><a href="/">Ο χάρτης ευκαιριών</a> είναι ήδη εδώ.</p>
</body></html>
PLACEHOLDER
chown -R www-data:www-data "$WEB" 2>/dev/null || true

say "[5/7] Κωδικός πρόσβασης"
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

say "[6/7] nginx στη θύρα $PORT"
cat > /etc/nginx/sites-available/akinita <<NGINX
# Μόνο η θύρα $PORT. Ό,τι κι αν σερβίρει αυτό το μηχάνημα στις 80 και 443
# συνεχίζει ανέπαφο.
server {
    listen $PORT;
    listen [::]:$PORT;
    server_name _;
    root $WEB;
    index index.html;

    auth_basic "Ακίνητα";
    auth_basic_user_file /etc/nginx/.akinita_htpasswd;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Referrer-Policy "no-referrer" always;

    location / { try_files \$uri \$uri/ =404; }
}
NGINX
ln -sf /etc/nginx/sites-available/akinita /etc/nginx/sites-enabled/akinita
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

say "[7/7] Καθημερινή ανανέωση"
cat > /etc/systemd/system/akinita.service <<UNIT
[Unit]
Description=Ανανέωση χάρτη ευκαιριών από Eurostat και Διαύγεια
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$APP
ExecStart=/usr/bin/python3 -m akinita.ethniki --out $WEB/index.html --json-out $WEB/simata.json
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
