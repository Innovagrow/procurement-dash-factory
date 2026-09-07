#!/usr/bin/env bash
# ============================================================
# Διάγνωση και άνοιγμα του ESPA Radar προς τα έξω.
#
#   bash expose.sh              # μόνο διάγνωση
#   MODE=port bash expose.sh    # άμεσο: http://<ip>:8077
#   MODE=caddy bash expose.sh   # ξαναδοκιμή HTTPS μέσω Caddy
# ============================================================
set -uo pipefail

SERVICE="espa-radar"
APP_DIR="${APP_DIR:-/opt/espa-radar}"
APP_PORT="${APP_PORT:-8077}"
MODE="${MODE:-diagnose}"
IP="$(hostname -I | awk '{print $1}')"
HOST="espa.${IP}.sslip.io"

say()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m  ✓ %s\033[0m\n" "$*"; }
bad()  { printf "\033[1;31m  ✗ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m  ! %s\033[0m\n" "$*"; }

say "Η εφαρμογή"
if systemctl is-active --quiet "$SERVICE"; then
  ok "τρέχει ($(( $(systemctl show "$SERVICE" -p MemoryCurrent --value 2>/dev/null || echo 0) / 1048576 )) MB)"
else
  bad "δεν τρέχει"; journalctl -u "$SERVICE" -n 15 --no-pager | sed 's/^/    /'
fi
curl -fsS --max-time 10 "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1 \
  && ok "απαντά τοπικά στο $APP_PORT" || bad "δεν απαντά τοπικά στο $APP_PORT"
echo "  ακούει σε: $(ss -ltnp 2>/dev/null | grep ":$APP_PORT" | awk '{print $4}' | head -1 || echo '—')"

say "Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  bad "δεν είναι εγκατεστημένη"
else
  systemctl is-active --quiet caddy && ok "τρέχει" || bad "δεν τρέχει"
  grep -q "$HOST" /etc/caddy/Caddyfile 2>/dev/null \
    && ok "το site $HOST υπάρχει στο Caddyfile" \
    || bad "το site $HOST ΔΕΝ υπάρχει στο Caddyfile"
  echo "  --- Caddyfile ---"
  sed 's/^/    /' /etc/caddy/Caddyfile 2>/dev/null | head -40
  echo "  --- τελευταία σφάλματα TLS ---"
  journalctl -u caddy -n 200 --no-pager 2>/dev/null \
    | grep -iE "error|obtain|challenge|rate.?limit|tls|certificate" | tail -12 | sed 's/^/    /' \
    || echo "    (κανένα)"
fi

say "Θύρες προς το internet"
for port in 80 443 "$APP_PORT"; do
  listener="$(ss -ltn 2>/dev/null | awk -v p=":$port\$" '$4 ~ p {print $4}' | head -1)"
  printf "  %-5s %s\n" "$port" "${listener:-δεν ακούει κανείς}"
done
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "  --- ufw ---"; ufw status 2>/dev/null | sed 's/^/    /' | head -12
else
  echo "  ufw: ανενεργό (καμία φραγή από αυτό)"
fi

# ============================================================
case "$MODE" in
  port)
    say "Άνοιγμα απευθείας στη θύρα $APP_PORT"
    # Το unit είναι δικό μας· αλλάζουμε μόνο τη διεύθυνση ακρόασης με override,
    # ώστε το βασικό αρχείο να μένει ανέπαφο και να αναιρείται εύκολα.
    mkdir -p "/etc/systemd/system/$SERVICE.service.d"
    cat > "/etc/systemd/system/$SERVICE.service.d/listen.conf" <<CONF
[Service]
ExecStart=
ExecStart=$APP_DIR/.venv/bin/uvicorn espa_radar.api:app --host 0.0.0.0 --port $APP_PORT
CONF
    systemctl daemon-reload && systemctl restart "$SERVICE"
    sleep 4
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
      ufw allow "$APP_PORT/tcp" >/dev/null 2>&1 && ok "άνοιξε η θύρα στο ufw"
    fi
    if systemctl is-active --quiet "$SERVICE"; then
      ok "έτοιμο"
      printf "\n\033[1;32m    http://%s:%s\033[0m\n\n" "$IP" "$APP_PORT"
      echo "    Τα endpoints που γράφουν θέλουν το API key:"
      grep -m1 '^ESPA_API_KEY=' "$APP_DIR/.env" 2>/dev/null | sed 's/^/      /'
      echo "    Αναίρεση: rm -rf /etc/systemd/system/$SERVICE.service.d && systemctl daemon-reload && systemctl restart $SERVICE"
    else
      bad "δεν ξεκίνησε"; journalctl -u "$SERVICE" -n 20 --no-pager | sed 's/^/    /'
    fi
    ;;
  caddy)
    say "Ξαναδοκιμή Caddy για $HOST"
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$$"
    grep -q "$HOST" /etc/caddy/Caddyfile || cat >> /etc/caddy/Caddyfile <<CADDYCFG

$HOST {
    reverse_proxy 127.0.0.1:$APP_PORT
}
CADDYCFG
    if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      systemctl reload caddy
      ok "φορτώθηκε — το πιστοποιητικό θέλει 10-60 δευτερόλεπτα"
      sleep 25
      journalctl -u caddy --since "-2min" --no-pager 2>/dev/null \
        | grep -iE "obtain|certificate|error|challenge" | tail -10 | sed 's/^/    /'
      curl -sS -o /dev/null -w "  https -> %{http_code}\n" --max-time 20 "https://$HOST/" 2>&1 | tail -1
    else
      bad "άκυρη ρύθμιση — επαναφορά"
      mv "/etc/caddy/Caddyfile.bak.$$" /etc/caddy/Caddyfile
      caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -5 | sed 's/^/    /'
    fi
    ;;
esac
