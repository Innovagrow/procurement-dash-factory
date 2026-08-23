# Οι σελίδες σε δικό σας droplet

Ένα droplet δίνει αυτό που δεν δίνει κανένα τοπικό αρχείο: μια διεύθυνση που
ανοίγει από παντού, χωρίς να μοιράζεστε τίποτα με κανέναν. Οι σελίδες μπαίνουν
πίσω από κωδικό και δηλώνονται `noindex`, οπότε δεν τις βρίσκει ούτε μηχανή
αναζήτησης.

## Από Windows, χωρίς να μπείτε στο droplet

Τα Windows 10 και 11 έχουν ήδη `ssh`. Από **cmd**, μία γραμμή:

```
ssh root@ΤΟ_IP_ΣΟΥ "curl -fsSL https://raw.githubusercontent.com/Innovagrow/procurement-dash-factory/claude/greek-brokers-investment-outreach-gr5j9p/deploy/droplet.sh -o /tmp/d.sh && bash /tmp/d.sh"
```

Την πρώτη φορά το `ssh` ρωτάει αν εμπιστεύεστε το κλειδί του διακομιστή:
γράψτε `yes`. Μετά ζητάει τον κωδικό του droplet, αν δεν χρησιμοποιείτε κλειδί.

Ή **διπλό κλικ στο `deploy\DROPLET.bat`**: ρωτάει διεύθυνση, χρήστη και
προαιρετικό domain, στήνει το droplet και προσφέρεται να ανεβάσει και την
τελευταία αναφορά σάρωσης.

Αν το `ssh` δεν αναγνωρίζεται: Ρυθμίσεις → Σύστημα → Προαιρετικές δυνατότητες →
Προσθήκη → **OpenSSH Client**.

## Μία εντολή, πάνω στο droplet

Συνδεθείτε στο droplet — από την κονσόλα του DigitalOcean ή με
`ssh root@ΤΟ_IP_ΣΑΣ` — και επικολλήστε:

```
curl -fsSL https://raw.githubusercontent.com/Innovagrow/procurement-dash-factory/claude/greek-brokers-investment-outreach-gr5j9p/deploy/droplet.sh | bash
```

Στο τέλος τυπώνει τη διεύθυνση, τον χρήστη και τον κωδικό. Ο κωδικός φυλάσσεται
και στο `/root/akinita-kwdikos.txt`.

Αν προτιμάτε να δείτε πρώτα τι θα τρέξει — καλή συνήθεια για ό,τι κατεβάζετε:

```
curl -fsSLO https://raw.githubusercontent.com/Innovagrow/procurement-dash-factory/claude/greek-brokers-investment-outreach-gr5j9p/deploy/droplet.sh
less droplet.sh
bash droplet.sh
```

Με δικό σας domain, για κανονικό `https` αντί για σκέτο `http`:

```
DOMAIN=akinita.to-domain-sas.gr bash droplet.sh
apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d akinita.to-domain-sas.gr
```

Ξανατρέξτε το όποτε θέλετε. Κάνει `pull`, ξαναφτιάχνει τις σελίδες και αφήνει
τον κωδικό όπως είναι.

## Τι στήνεται

| | |
|---|---|
| `/` | Ο χάρτης ευκαιριών — Eurostat και Διαύγεια, ανανεώνεται **μόνος του κάθε μέρα** |
| `/apotelesmata.html` | Η αναφορά της δικής σας σάρωσης — ανεβαίνει από εσάς |
| `/simata.json` | Τα ωμά δεδομένα του χάρτη |

Η καθημερινή ανανέωση είναι systemd timer. Έλεγχος:

```
systemctl list-timers akinita.timer
journalctl -u akinita.service -n 30
```

## Η σάρωση αγγελιών ΔΕΝ τρέχει στο droplet

Αυτό είναι το σημείο που κοστίζει χρόνο αν δεν το ξέρετε από πριν.

Οι πύλες αγγελιών μπλοκάρουν τις διευθύνσεις των data center στο επίπεδο του
CDN: το αίτημα παίρνει `403` πριν φτάσει καν στον ιστότοπο. Ένα droplet **είναι**
data center. Δοκιμασμένο, δεν είναι εικασία.

Άρα ο καταμερισμός είναι:

* **Σάρωση** στον υπολογιστή σας, από οικιακή σύνδεση.
* **Δημοσίευση** στο droplet, για να τη βλέπετε από παντού.

Ανεβάστε την αναφορά μετά τη σάρωση, από γραμμή εντολών των Windows:

```
scp out\apotelesmata.html root@ΤΟ_IP_ΣΑΣ:/var/www/akinita/apotelesmata.html
```

Το `scp` υπάρχει ήδη σε Windows 10 και 11.

## Ό,τι ανεβαίνει, μένει δικό σας

Οι Όροι των πυλών επιτρέπουν την προσωπική χρήση των δεδομένων και απαγορεύουν
την αναδημοσίευση. Ένας ιστότοπος με κωδικό, που τον βλέπετε μόνο εσείς, δεν
είναι δημοσίευση — ένας ανοιχτός ιστότοπος είναι. Γι' αυτό το `auth_basic` δεν
είναι προαιρετικό εδώ, και γι' αυτό ο χάρτης, που στηρίζεται αποκλειστικά σε
ανοιχτά δεδομένα, είναι το μόνο κομμάτι που θα μπορούσε να είναι δημόσιο.
