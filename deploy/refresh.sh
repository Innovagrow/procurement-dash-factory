#!/usr/bin/env bash
#
# Ό,τι τρέχει το systemd timer κάθε λίγες ώρες, πάνω στο droplet.
#
# Τραβάει τον νέο κώδικα ΚΑΙ ξαναφτιάχνει τη σελίδα. Το «τραβάει» είναι το
# σημείο: χωρίς αυτό, το droplet θα ξανασχεδίαζε για πάντα την ίδια σελίδα με
# τον κώδικα της ημέρας που εγκαταστάθηκε, και κάθε διόρθωση θα απαιτούσε να
# συνδεθεί κάποιος με το χέρι.
#
# Το ίδιο το αρχείο έρχεται από το repository, οπότε ενημερώνεται κι αυτό.
set -euo pipefail

APP="${APP:-/opt/akinita}"
WEB="${WEB:-/var/www/akinita}"
BRANCH="${BRANCH:-claude/greek-brokers-investment-outreach-gr5j9p}"

cd "$APP"
git fetch --quiet origin "$BRANCH"
BEFORE="$(git rev-parse HEAD)"
git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
AFTER="$(git rev-parse HEAD)"
[ "$BEFORE" = "$AFTER" ] || echo "νέος κώδικας: ${BEFORE:0:7} -> ${AFTER:0:7}"

python3 -m akinita.ethniki --out "$WEB/index.html" \
    --scan "$WEB/scan.json" --json-out "$WEB/simata.json"
chown -R www-data:www-data "$WEB" 2>/dev/null || true

# Μια σελίδα που δεν δηλώνει κωδικοποίηση διαβάζεται ως Latin-1 και τα ελληνικά
# γίνονται σκουπίδια. Αν συμβεί ποτέ ξανά, να φανεί εδώ και όχι στην οθόνη.
if ! head -c 200 "$WEB/index.html" | grep -qi 'charset="utf-8"'; then
  echo "ΠΡΟΣΟΧΗ: η σελίδα δεν δηλώνει UTF-8" >&2
  exit 1
fi
echo "η σελίδα ανανεώθηκε"
