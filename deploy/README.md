# Εγκατάσταση σε droplet

Μία εντολή, από τα Windows σου:

```cmd
ssh root@138.197.184.114 "curl -fsSL https://raw.githubusercontent.com/Innovagrow/procurement-dash-factory/claude/espa-program-detection-system-f5ad00/deploy/install.sh -o /tmp/espa-install.sh && bash /tmp/espa-install.sh"
```

Παίρνει 3–5 λεπτά. Στο τέλος τυπώνει το URL και το API key.

## Τι κάνει και τι δεν αγγίζει

| Δημιουργεί | Δεν αγγίζει |
|---|---|
| χρήστη `espa` | τους 5 υπάρχοντες services |
| `/opt/espa-radar` + venv | το `/opt/listing-classifier` |
| `espa-radar.service` (θύρα 8077) | τη θύρα 8787 του `rally-monitor` |
| ένα site στο `Caddyfile` | το υπάρχον site της Caddy |

Δεν τρέχει `apt-get upgrade`. Αν κάτι πάει στραβά στη ρύθμιση της Caddy,
επαναφέρει το αρχείο και συνεχίζει.

## Όρια πόρων

Το droplet έχει 458 MB RAM με ~163 MB ελεύθερα. Η μετρημένη κορυφή μιας πλήρους
σάρωσης είναι **84 MB** με `ESPA_HTTP_CONCURRENCY=1`, που το script βάζει αυτόματα.

Το systemd unit ορίζει `MemoryMax=140M`. Αυτό είναι σκληρό ταβάνι: ό,τι κι αν
συμβεί, ο kernel σταματά **αυτή** την υπηρεσία και ποτέ κάτι άλλο στο μηχάνημα.

```bash
systemctl show espa-radar -p MemoryCurrent   # τρέχουσα χρήση
```

Παραμετροποίηση αν χρειαστεί:

```bash
sudo APP_PORT=8078 MEM_MAX=200M bash /tmp/espa-install.sh
```

## Μετά την εγκατάσταση

```bash
# 1. Ειδοποιήσεις
nano /opt/espa-radar/.env         # ESPA_SMTP_* ή ESPA_TELEGRAM_*
#    και πρόσθεσε το κανάλι:      ESPA_NOTIFY_CHANNELS=console,email
systemctl restart espa-radar

# 2. Προφίλ κριτηρίων
sudo -u espa /opt/espa-radar/.venv/bin/python -m espa_radar.cli \
  add-profile "Η εταιρεία μου" \
  --sector "Ψηφιακός μετασχηματισμός" --region "Αττική" \
  --beneficiary "ΜμΕ" --budget-min 20000 --budget-max 400000 \
  --email you@example.com --channel email

# 3. Πρώτη σάρωση τώρα (αλλιώς περιμένει τον scheduler)
sudo -u espa /opt/espa-radar/.venv/bin/python -m espa_radar.cli scan
```

**Προσοχή στα σχόλια στο `.env`.** Το systemd δεν κόβει σχόλια στο τέλος γραμμής.
Ο κώδικας πλέον τα αγνοεί για αριθμούς και λίστες, αλλά **όχι για συνθηματικά** —
εκεί το `#` θεωρείται μέρος του κωδικού, γιατί συχνά είναι.

## Διάγνωση

```bash
systemctl status espa-radar
journalctl -u espa-radar -f
curl -s localhost:8077/health | python3 -m json.tool
curl -s localhost:8077/api/sources | python3 -m json.tool   # ποιες πηγές απαντούν
```

## Απεγκατάσταση

```bash
systemctl disable --now espa-radar
rm -rf /opt/espa-radar /etc/systemd/system/espa-radar.service
systemctl daemon-reload
userdel -r espa
# και σβήσε το μπλοκ "espa.*.sslip.io" από το /etc/caddy/Caddyfile
```
