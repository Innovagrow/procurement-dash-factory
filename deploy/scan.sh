#!/usr/bin/env bash
#
# Η σάρωση, όταν τρέχει πάνω στο droplet. Την καλεί ο timer· κανείς δεν
# χρειάζεται να συνδεθεί.
#
# Τρέχει μόνο αν η εγκατάσταση διαπίστωσε ότι η πύλη απαντά από αυτό το
# μηχάνημα. Οι περισσότερες διευθύνσεις data center απορρίπτονται στο CDN, και
# τότε η σάρωση ανήκει στον υπολογιστή σας — όχι εδώ.
set -euo pipefail

APP="${APP:-/opt/akinita}"
WEB="${WEB:-/var/www/akinita}"
MAX_PRICE="${MAX_PRICE:-50000}"
TOP="${TOP:-400}"
WORK="/var/tmp/akinita-scan"

[ -f "$WEB/.scan-enabled" ] || { echo "η σάρωση δεν είναι ενεργή σε αυτό το μηχάνημα"; exit 0; }

mkdir -p "$WORK"
cd "$APP"
# Αργή επίτηδες: 2,5 δευτερόλεπτα ανά αίτημα. Μια σάρωση που τελειώνει γρήγορα
# είναι μια σάρωση που βαραίνει τον διακομιστή κάποιου άλλου.
python3 -m akinita.screener --source spitogatos --all-types --personal-use \
    --max-price "$MAX_PRICE" --min-price 5000 --enrich-top 150 --top "$TOP" \
    --delay 2.5 --out "$WORK/scan" --html-out "$WORK/scan.html"

if [ -s "$WORK/scan_analysis.json" ]; then
  cp "$WORK/scan_analysis.json" "$WEB/scan.json"
  chown www-data:www-data "$WEB/scan.json" 2>/dev/null || true
  echo "η σάρωση ενημερώθηκε"
  bash "$APP/deploy/refresh.sh"
else
  echo "η σάρωση δεν παρήγαγε δεδομένα — η σελίδα μένει όπως ήταν" >&2
  exit 1
fi
