#!/usr/bin/env bash
# Low-memory install: runs ONLY the UpBid Node process on this box.
# Postgres and Redis live in managed services, because a 512 MB droplet cannot
# host them alongside anything else.
#
# Requires DATABASE_URL and REDIS_URL in the environment or in .env already.
#
#   cd /opt/upbid/upwork-autobid && bash deploy/setup-droplet-lite.sh
#
# Idempotent. Touches nothing that is already running on the box.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=upbid
NODE_MAJOR=20

echo "==> Preflight"
MEM_TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
MEM_AVAIL_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
echo "    RAM ${MEM_AVAIL_MB}/${MEM_TOTAL_MB} MB available, swap ${SWAP_MB} MB"

# Swap is what keeps a small box from OOM-killing the services already on it.
if [ "$SWAP_MB" -lt 512 ]; then
  echo "==> Adding 1 GB swap (protects the services already running here)"
  if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile 2>/dev/null || true
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
else
  echo "==> Swap already present, leaving it alone"
fi

echo "==> Node.js ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
fi
echo "    $(node -v)"

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "ERROR: no .env in $APP_DIR"
  echo "  Copy .env.example to .env and set at least DATABASE_URL, REDIS_URL and API_KEY."
  exit 1
fi

for REQUIRED in DATABASE_URL REDIS_URL API_KEY; do
  if ! grep -q "^${REQUIRED}=..*" .env; then
    echo "ERROR: ${REQUIRED} is not set in .env"
    exit 1
  fi
done

echo "==> Installing dependencies (production only, this is the slow part)"
npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund

echo "==> Building"
# The build needs TypeScript, which is a dev dependency; install, build, prune.
npm install --no-audit --no-fund --silent
npx prisma generate >/dev/null
npx tsc -p tsconfig.json
npx prisma db push --accept-data-loss
npm prune --omit=dev >/dev/null

echo "==> Installing systemd service"
cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=UpBid - Upwork detection and proposal drafting
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
# Keep the heap small: this box has very little headroom.
Environment=NODE_OPTIONS=--max-old-space-size=192
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/bootstrap/all-in-one.js
Restart=always
RestartSec=10
# Never let UpBid take the box down with it.
MemoryMax=280M
MemoryHigh=240M
OOMPolicy=continue
StandardOutput=append:/var/log/upbid.log
StandardError=append:/var/log/upbid.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "${SERVICE}"
sleep 5

echo ""
if systemctl is-active --quiet "${SERVICE}"; then
  PORT_IN_USE=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '"' || echo 3000)
  echo "==> Running."
  echo "    Dashboard: http://$(curl -fsS4 ifconfig.me 2>/dev/null || echo YOUR_IP):${PORT_IN_USE:-3000}"
  echo "    API key:   $(grep -E '^API_KEY=' .env | cut -d= -f2- | tr -d '\"')"
  echo "    Logs:      journalctl -u ${SERVICE} -f   (or tail -f /var/log/upbid.log)"
  echo "    Memory:    systemctl show ${SERVICE} -p MemoryCurrent"
else
  echo "==> FAILED to start. Last 40 lines:"
  journalctl -u "${SERVICE}" -n 40 --no-pager
  exit 1
fi
