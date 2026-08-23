#!/usr/bin/env bash
#
# Στήνει τις σελίδες αποτελεσμάτων σε ένα droplet (Ubuntu/Debian) και τις
# σερβίρει πίσω από κωδικό. Τρέχει ΠΑΝΩ στο droplet, ως root:
#
#     curl -fsSL https://raw.githubusercontent.com/Innovagrow/procurement-dash-factory/claude/greek-brokers-investment-outreach-gr5j9p/deploy/droplet.sh | bash
#
# Με δικό σας domain, για κανονικό https:
#
#     DOMAIN=akinita.example.com bash droplet.sh
#
# Είναι idempotent: ξανατρέξτε το όποτε θέλετε: κάνει pull, ξαναφτιάχνει τις
# σελίδες και δεν πειράζει τον κωδικό που έχει ήδη οριστεί.
set -euo pipefail

REPO="https://github.com/Innovagrow/procurement-dash-factory.git"
BRANCH="claude/greek-brokers-investment-outreach-gr5j9p"
APP="/opt/akinita"
WEB="/var/www/akinita"
DOMAIN="${DOMAIN:-}"
WEB_USER="${WEB_USER:-admin}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Τρέξτε το ως root:  sudo bash droplet.sh"; exit 1; }

say "[1/6] Πακέτα"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git python3 nginx apache2-utils curl openssl >/dev/null

say "[2/6] Κώδικας"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --quiet origin "$BRANCH"
  git -C "$APP" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$APP"
fi

say "[3/6] Παραγωγή σελίδων"
mkdir -p "$WEB"
# Ο χάρτης χρειάζεται μόνο την stdlib: διαβάζει Eurostat και Διαύγεια.
( cd "$APP" && python3 -m akinita.ethniki --out "$WEB/index.html" \
    --json-out "$WEB/simata.json" )
# Η αναφορά σάρωσης παράγεται στον υπολογιστή σας και ανεβαίνει χωριστά:
#   scp out\apotelesmata.html root@<IP>:/var/www/akinita/apotelesmata.html
[ -f "$WEB/apotelesmata.html" ] || cat > "$WEB/apotelesmata.html" <<'PLACEHOLDER'
<!doctype html><html lang="el"><head><meta charset="utf-8">
<title>Αναφορά — δεν έχει ανέβει ακόμη</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:52ch;margin:12vh auto;padding:0 20px;
color:#171A1F;background:#ECEEF1}code{background:#E1E5EB;padding:2px 6px;border-radius:4px;
font-size:14px;display:block;margin-top:14px;padding:12px;overflow-x:auto}
@media(prefers-color-scheme:dark){body{background:#101317;color:#E7EBF0}code{background:#0B0E12}}
</style></head><body>
<h1>Η αναφορά δεν έχει ανέβει ακόμη</h1>
<p>Τρέξτε τη σάρωση στον υπολογιστή σας και ανεβάστε τη σελίδα εδώ:</p>
<code>scp out\apotelesmata.html root@ΤΟ_IP_ΣΑΣ:/var/www/akinita/apotelesmata.html</code>
<p><a href="/">Ο χάρτης ευκαιριών</a> είναι ήδη εδώ.</p>
</body></html>
PLACEHOLDER
chown -R www-data:www-data "$WEB"

say "[4/6] Κωδικός πρόσβασης"
if [ -f /etc/nginx/.akinita_htpasswd ]; then
  echo "  Υπάρχει ήδη. Για αλλαγή:  htpasswd /etc/nginx/.akinita_htpasswd $WEB_USER"
else
  PASS="$(openssl rand -base64 12)"
  printf '%s' "$PASS" | htpasswd -ic /etc/nginx/.akinita_htpasswd "$WEB_USER" >/dev/null 2>&1
  printf 'χρήστης: %s\nκωδικός: %s\n' "$WEB_USER" "$PASS" > /root/akinita-kwdikos.txt
  chmod 600 /root/akinita-kwdikos.txt
  echo "  Χρήστης: $WEB_USER"
  echo "  Κωδικός: $PASS"
  echo "  Φυλάσσεται και στο /root/akinita-kwdikos.txt"
fi

say "[5/6] nginx"
cat > /etc/nginx/sites-available/akinita <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN:-_};
    root $WEB;
    index index.html;

    # Οι σελίδες είναι προσωπικές. Χωρίς κωδικό δεν βγαίνει τίποτα, και οι
    # μηχανές αναζήτησης δεν τις δεικτοδοτούν ούτε κατά λάθος.
    auth_basic "Ακίνητα";
    auth_basic_user_file /etc/nginx/.akinita_htpasswd;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Referrer-Policy "no-referrer" always;

    location / { try_files \$uri \$uri/ =404; }
}
NGINX
ln -sf /etc/nginx/sites-available/akinita /etc/nginx/sites-enabled/akinita
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

say "[6/6] Καθημερινή ανανέωση"
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
if [ -n "$DOMAIN" ]; then
  echo "  http://$DOMAIN/"
  echo
  echo "  Για https:  apt-get install -y certbot python3-certbot-nginx"
  echo "              certbot --nginx -d $DOMAIN"
else
  echo "  http://$IP/"
  echo
  echo "  Χωρίς domain η σύνδεση είναι http: ο κωδικός ταξιδεύει καθαρός."
  echo "  Με domain, ξανατρέξτε ως:  DOMAIN=to-domain-sas.gr bash droplet.sh"
fi
echo "  Ο χάρτης ανανεώνεται μόνος του κάθε μέρα."
