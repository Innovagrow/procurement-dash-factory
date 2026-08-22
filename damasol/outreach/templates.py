# -*- coding: utf-8 -*-
"""
Campaign copy for Damasol Limited's outreach to Greek real estate professionals.

Every channel carries the same six points the campaign exists to make:

  1. Damasol Limited is an investment organisation.
  2. It is addressing real estate professionals across Greece.
  3. If they hold a property they personally judge to be a genuine business
     opportunity, they should get in touch.
  4. They should send the property's details.
  5. They should explain *why* they consider it an opportunity.
  6. Damasol is open to - and experienced in - both partnership proposals and
     flexible business models.

Placeholders use `{}` formatting and are filled by `render()`. Anything the
caller does not supply falls back to `DEFAULT_IDENTITY`.
"""
from __future__ import annotations

from typing import Dict, Optional

DEFAULT_IDENTITY: Dict[str, str] = {
    "company": "Damasol Limited",
    "sender_name": "",
    "sender_title": "Επενδυτικός Οργανισμός",
    "reply_email": "",
    "phone": "",
    "website": "",
    "ticket_min": "20.000 €",
    "ticket_max": "3.000.000 €",
}

# ---------------------------------------------------------------- fragments

CRITERIA_EL = """• Γεωγραφία: όλη η Ελλάδα — ηπειρωτική και νησιωτική, αστικά κέντρα και περιφέρεια.
• Είδη: κατοικίες, επαγγελματικοί χώροι, οικόπεδα και γη, τουριστικά ακίνητα, ξενοδοχειακές μονάδες.
• Μεμονωμένα ακίνητα, αλλά και χαρτοφυλάκια ή συγκροτήματα.
• Εύρος τιμήματος: ενδεικτικά από {ticket_min} έως {ticket_max} — με ευελιξία εκτός εύρους όταν το ακίνητο το δικαιολογεί.
• Ακίνητα με «προβλήματα που λύνονται»: εκκρεμότητες τίτλων ή πολεοδομικές, ημιτελείς κατασκευές, ακίνητα που χρήζουν ανακαίνισης — εφόσον αποτυπώνονται στην τιμή.
• Πλειστηριασμοί, ακίνητα τραπεζών και εταιρειών διαχείρισης απαιτήσεων."""

MODELS_EL = """• Απευθείας αγορά, τοις μετρητοίς, με ταχεία διαδικασία όταν χρειάζεται.
• Συνεπένδυση / joint venture με τον ιδιοκτήτη ή με τρίτο επενδυτή.
• Αντιπαροχή και σχήματα ανάπτυξης.
• Ανάληψη ανακαίνισης και εκμετάλλευσης με συμμετοχή του ιδιοκτήτη στα αποτελέσματα.
• Μακροχρόνια μίσθωση με δικαίωμα εξαγοράς, sale & leaseback.
• Τμηματική εξόφληση ή εξαγορά μέσω εταιρικού σχήματος.
• Ανάληψη ολόκληρου χαρτοφυλακίου."""

UNSUBSCRIBE_EL = """Λαμβάνετε αυτό το μήνυμα ως επαγγελματίας του κλάδου ακινήτων, σε δημοσίως
διαθέσιμη επαγγελματική διεύθυνση, για σκοπό αυστηρά επαγγελματικής συνεργασίας.
Αν δεν επιθυμείτε να λαμβάνετε παρόμοια μηνύματα, απαντήστε με τη λέξη ΔΙΑΓΡΑΦΗ
και η διεύθυνσή σας θα αφαιρεθεί άμεσα και οριστικά."""

# ------------------------------------------------------------------ e-mail

EMAIL_SUBJECTS = [
    "Damasol Limited — αναζητούμε ακίνητα με πραγματικό επενδυτικό ενδιαφέρον",
    "Έχετε ακίνητο που θεωρείτε πραγματική ευκαιρία; Θέλουμε να το δούμε",
    "Πρόταση συνεργασίας από επενδυτικό οργανισμό — ευέλικτα σχήματα αγοράς",
    "{broker_name}: συνεργασία με επενδυτικό οργανισμό για ακίνητα-ευκαιρίες",
]

EMAIL_EL = """{greeting}

Ονομάζομαι {sender_name} και εκπροσωπώ τη {company}, επενδυτικό οργανισμό που
δραστηριοποιείται στην αγορά ακινήτων στην Ελλάδα.

Απευθυνόμαστε σε εσάς ως επαγγελματία της αγοράς, με ένα συγκεκριμένο αίτημα:

  ➤ Αν έχετε στο χαρτοφυλάκιό σας ακίνητο που ΕΣΕΙΣ ΟΙ ΙΔΙΟΙ θεωρείτε πραγματική
    επαγγελματική ευκαιρία, θα θέλαμε να επικοινωνήσετε μαζί μας.

Δεν ζητάμε λίστες αγγελιών· αυτές τις βλέπουμε ήδη. Μας ενδιαφέρει η δική σας
κρίση: ποιο ακίνητο ξεχωρίζει και, κυρίως, ΓΙΑΤΙ.


ΤΙ ΘΑ ΘΕΛΑΜΕ ΝΑ ΜΑΣ ΓΡΑΨΕΤΕ
───────────────────────────────────────────────────────────────────────
1) ΛΕΠΤΟΜΕΡΕΙΕΣ ΤΟΥ ΑΚΙΝΗΤΟΥ
   Τύπος, ακριβής περιοχή, εμβαδόν, όροφος/επίπεδα, έτος κατασκευής,
   κατάσταση, ενεργειακή κλάση, πολεοδομική και νομική κατάσταση (τίτλοι,
   βάρη, τακτοποιήσεις, δασικά/αιγιαλός όπου ισχύει), μισθώσεις σε ισχύ.

2) ΤΙΜΗΜΑ
   Ζητούμενο τίμημα, περιθώριο διαπραγμάτευσης, χρονικό πλαίσιο του πωλητή.

3) ΓΙΑΤΙ ΤΟ ΘΕΩΡΕΙΤΕ ΕΥΚΑΙΡΙΑ  ← το πιο σημαντικό σημείο
   Τεκμηριώστε το όπως θα το κάνατε σε συνάδελφο: τιμή κάτω από τα
   συγκριτικά της περιοχής, απόδοση ενοικίου, περιθώριο ανακαίνισης,
   δυνατότητα αλλαγής χρήσης ή κατάτμησης, τουριστική εκμετάλλευση, πίεση
   χρόνου από τον πωλητή, επικείμενο έργο υποδομής — ή οτιδήποτε γνωρίζετε
   εσείς και δεν φαίνεται στα χαρτιά.

4) ΥΛΙΚΟ
   Φωτογραφίες, βίντεο, κάτοψη, τοπογραφικό — ό,τι υπάρχει διαθέσιμο.

5) ΤΟ ΠΛΑΙΣΙΟ ΣΥΝΕΡΓΑΣΙΑΣ ΠΟΥ ΠΡΟΤΕΙΝΕΤΕ
   Αμοιβή, αποκλειστικότητα, χρονοδιάγραμμα.


ΠΩΣ ΔΟΥΛΕΥΟΥΜΕ
───────────────────────────────────────────────────────────────────────
• ΕΙΜΑΣΤΕ ΑΝΟΙΧΤΟΙ ΣΕ ΠΡΟΤΑΣΕΙΣ ΣΥΝΕΡΓΑΣΙΑΣ. Αν έχετε στο μυαλό σας ένα
  σχήμα που εξυπηρετεί εσάς και τον πελάτη σας, πείτε το μας — θα το
  εξετάσουμε σοβαρά και θα σας απαντήσουμε ουσιαστικά.

• ΕΧΟΥΜΕ ΕΜΠΕΙΡΙΑ ΣΕ ΕΥΕΛΙΚΤΑ ΕΠΙΧΕΙΡΗΜΑΤΙΚΑ ΜΟΝΤΕΛΑ, όχι μόνο σε
  απευθείας αγορά:
{models}

• Δεν υπάρχει άκαμπτο πλαίσιο. Αν το ακίνητο και το σκεπτικό στέκουν,
  βρίσκουμε μαζί το κατάλληλο σχήμα.

• Απαντάμε σε κάθε σοβαρή πρόταση με σαφή θέση — θετική ή αρνητική — και
  με το σκεπτικό μας. Δεν αφήνουμε προτάσεις αναπάντητες.

• Η αμοιβή σας ως μεσίτη είναι σεβαστή και διασφαλισμένη σε κάθε σχήμα
  που θα συμφωνηθεί.

• Εχεμύθεια: υπογράφουμε NDA όπου ζητηθεί, πριν μας στείλετε στοιχεία.


ΤΙ ΨΑΧΝΟΥΜΕ — ΕΝΔΕΙΚΤΙΚΑ, ΟΧΙ ΠΕΡΙΟΡΙΣΤΙΚΑ
───────────────────────────────────────────────────────────────────────
{criteria}


Στείλτε μας ό,τι έχετε στο {reply_email}{phone_clause}. Αν προτιμάτε, απαντήστε
απλώς σε αυτό το μήνυμα με δύο γραμμές και το αναλαμβάνουμε από εκεί.

Με εκτίμηση,

{sender_name}
{sender_title}
{company}
{reply_email}{phone_sig}{website_sig}

───────────────────────────────────────────────────────────────────────
{unsubscribe}
"""

FOLLOW_UP_EL = """{greeting}

Επανέρχομαι σύντομα στο προηγούμενο μήνυμά μου εκ μέρους της {company}.

Η πρόσκληση παραμένει ανοιχτή και είναι απλή: αν έχετε ακίνητο που εσείς
το θεωρείτε πραγματική επαγγελματική ευκαιρία, στείλτε μας τις λεπτομέρειές
του και — κυρίως — γιατί το θεωρείτε ευκαιρία.

Είμαστε επενδυτικός οργανισμός, είμαστε ανοιχτοί σε προτάσεις συνεργασίας
και έχουμε εμπειρία σε ευέλικτα επιχειρηματικά μοντέλα: απευθείας αγορά,
συνεπένδυση, αντιπαροχή, ανάληψη ανακαίνισης και εκμετάλλευσης, μίσθωση με
δικαίωμα εξαγοράς, τμηματική εξόφληση. Αν το ακίνητο και το σκεπτικό
στέκουν, βρίσκουμε το σχήμα.

Δύο γραμμές αρκούν για να ξεκινήσουμε. {reply_email}{phone_clause}

Με εκτίμηση,
{sender_name} · {company}

───────────────────────────────────────────────────────────────────────
{unsubscribe}
"""

# ------------------------------------------------------------ short-form

SMS_EL = (
    "{company}, επενδυτικός οργανισμός. Έχετε ακίνητο που θεωρείτε πραγματική "
    "επαγγελματική ευκαιρία; Στείλτε μας λεπτομέρειες και γιατί το θεωρείτε "
    "ευκαιρία. Ανοιχτοί σε συνεργασίες & ευέλικτα σχήματα (αγορά, συνεπένδυση, "
    "αντιπαροχή, ανακαίνιση/εκμετάλλευση). {reply_email}. Απάντηση ΔΙΑΓΡΑΦΗ για διαγραφή."
)

VIBER_EL = """Καλησπέρα{greeting_name},

Είμαστε η {company}, επενδυτικός οργανισμός στον χώρο των ακινήτων.

Αν έχετε ακίνητο που ΕΣΕΙΣ θεωρείτε πραγματική επαγγελματική ευκαιρία,
θα θέλαμε να μας το στείλετε — με τις λεπτομέρειές του και, κυρίως, με το
γιατί το θεωρείτε ευκαιρία.

Είμαστε ανοιχτοί σε προτάσεις συνεργασίας και έχουμε εμπειρία σε ευέλικτα
επιχειρηματικά μοντέλα: απευθείας αγορά, συνεπένδυση, αντιπαροχή, ανάληψη
ανακαίνισης & εκμετάλλευσης, μίσθωση με δικαίωμα εξαγοράς, τμηματική
εξόφληση. Η αμοιβή σας διασφαλίζεται σε κάθε σχήμα.

{reply_email}{phone_clause}
— {sender_name}, {company}"""

LINKEDIN_EL = """{greeting}

Η {company} είναι επενδυτικός οργανισμός με ενεργό ενδιαφέρον για την ελληνική
αγορά ακινήτων.

Αναζητούμε ακίνητα που οι ίδιοι οι επαγγελματίες της αγοράς θεωρούν πραγματικές
ευκαιρίες. Αν έχετε κάτι τέτοιο, στείλτε μας τις λεπτομέρειες και το σκεπτικό
σας — γιατί το θεωρείτε ευκαιρία.

Είμαστε ανοιχτοί σε προτάσεις συνεργασίας και διαθέτουμε εμπειρία σε ευέλικτα
επιχειρηματικά μοντέλα (απευθείας αγορά, συνεπένδυση, αντιπαροχή, ανάληψη
ανακαίνισης και εκμετάλλευσης, μίσθωση με δικαίωμα εξαγοράς, τμηματική
εξόφληση). Η αμοιβή σας διασφαλίζεται.

{reply_email}{phone_clause}"""

# ------------------------------------------------------------------ forms

PROPERTY_BRIEF_EL = """ΦΟΡΜΑ ΥΠΟΒΟΛΗΣ ΑΚΙΝΗΤΟΥ — {company}
═══════════════════════════════════════════════════════════════════════
Συμπληρώστε όσα γνωρίζετε και στείλτε τη στο {reply_email}.
Δεν χρειάζεται να είναι πλήρης για να ξεκινήσουμε συζήτηση.

ΣΤΟΙΧΕΙΑ ΜΕΣΙΤΗ
  Ονοματεπώνυμο / Γραφείο ........:
  Τηλέφωνο / Email ...............:
  Αρ. ΓΕΜΗ / Μητρώου μεσιτών .....:

ΤΟ ΑΚΙΝΗΤΟ
  Τύπος ..........................:  (διαμέρισμα / μονοκατοικία / κατάστημα /
                                      γραφείο / οικόπεδο / αγροτεμάχιο / ξενοδοχείο)
  Περιοχή & διεύθυνση ............:
  Εμβαδόν (τ.μ.) .................:
  Οικόπεδο (τ.μ.) ................:
  Όροφος / επίπεδα ...............:
  Έτος κατασκευής ................:
  Κατάσταση ......................:  (καλή / χρήζει ανακαίνισης / ημιτελές)
  Ενεργειακή κλάση ...............:
  Δόμηση / συντελεστές ...........:  (για οικόπεδα & γη)

ΝΟΜΙΚΗ & ΠΟΛΕΟΔΟΜΙΚΗ ΕΙΚΟΝΑ
  Τίτλοι σε τάξη; ................:  ΝΑΙ / ΟΧΙ / ΜΕΡΙΚΩΣ
  Βάρη / υποθήκες / κατασχέσεις ..:
  Αυθαίρετα / τακτοποιήσεις ......:
  Δασικός χάρτης / αιγιαλός ......:
  Ποσοστό ιδιοκτησίας προς πώληση :  (πλήρης κυριότητα / ψιλή / ποσοστό)
  Μισθώσεις σε ισχύ ..............:

ΟΙΚΟΝΟΜΙΚΑ
  Ζητούμενο τίμημα ...............:
  Περιθώριο διαπραγμάτευσης ......:
  Τρέχον / εκτιμώμενο ενοίκιο ....:
  Ετήσια έξοδα (ΕΝΦΙΑ, κοινόχρηστα):
  Χρονικό πλαίσιο πωλητή .........:

► ΓΙΑΤΙ ΤΟ ΘΕΩΡΕΙΤΕ ΕΥΚΑΙΡΙΑ
  ─────────────────────────────────────────────────────────────────────
  (Το πιο σημαντικό πεδίο. Γράψτε ελεύθερα — τιμή έναντι συγκριτικών,
   απόδοση, περιθώριο ανακαίνισης, αλλαγή χρήσης, τουριστική αξιοποίηση,
   πίεση χρόνου, γνώση της περιοχής, επικείμενα έργα.)




ΠΡΟΤΕΙΝΟΜΕΝΟ ΠΛΑΙΣΙΟ ΣΥΝΕΡΓΑΣΙΑΣ
  Αμοιβή μεσιτείας ...............:
  Αποκλειστικότητα ...............:  ΝΑΙ / ΟΧΙ
  Προτεινόμενο σχήμα .............:  (απευθείας αγορά / συνεπένδυση /
                                      αντιπαροχή / ανακαίνιση & εκμετάλλευση /
                                      μίσθωση με εξαγορά / άλλο)

ΣΥΝΗΜΜΕΝΑ
  □ Φωτογραφίες   □ Βίντεο   □ Κάτοψη   □ Τοπογραφικό   □ Τίτλοι   □ ΠΕΑ
═══════════════════════════════════════════════════════════════════════
"""

# ----------------------------------------------------------------- English

EMAIL_EN = """{greeting}

My name is {sender_name} and I represent {company}, an investment organisation
active in the Greek real estate market.

We are writing to you as a market professional with one specific request:

  ➤ If you hold a property that YOU YOURSELF consider a genuine business
    opportunity, we would like to hear from you.

We are not asking for listing feeds - we already see those. What interests us is
your judgement: which property stands out, and above all WHY.

WHAT TO SEND US
  1) Property details: type, exact location, size, floor/levels, year built,
     condition, energy class, planning and legal status (titles, encumbrances,
     unauthorised works, forestry/coastline where relevant), leases in place.
  2) Price: asking price, negotiating room, the seller's timeline.
  3) WHY YOU CONSIDER IT AN OPPORTUNITY - the most important part. Make the case
     as you would to a colleague: price against local comparables, rental yield,
     renovation headroom, change-of-use or subdivision potential, tourism
     exploitation, seller time pressure, upcoming infrastructure - or anything
     you know that the paperwork does not show.
  4) Material: photos, video, floor plans, topographic survey.
  5) The terms of cooperation you propose: fee, exclusivity, timeline.

HOW WE WORK
  • We are open to partnership proposals. If you have a structure in mind that
    works for you and your client, tell us - we will consider it seriously.
  • We are experienced in flexible business models, not only outright purchase:
    joint ventures, land-for-flats (antiparochi), taking on renovation and
    operation, sale & leaseback, long lease with a purchase option, staged
    payment, corporate-vehicle acquisitions, whole-portfolio takeovers.
  • There is no rigid box. If the property and the reasoning hold up, we will
    find the right structure together.
  • We reply to every serious proposal with a clear yes or no, and our reasoning.
  • Your brokerage fee is respected and secured under any agreed structure.
  • Confidentiality: we sign an NDA on request, before you send us anything.

Write to {reply_email}{phone_clause}, or simply reply to this message in two
lines and we will take it from there.

Kind regards,

{sender_name}
{sender_title}
{company}
{reply_email}{phone_sig}{website_sig}
"""

CHANNELS: Dict[str, str] = {
    "email": EMAIL_EL,
    "email_en": EMAIL_EN,
    "follow_up": FOLLOW_UP_EL,
    "sms": SMS_EL,
    "viber": VIBER_EL,
    "linkedin": LINKEDIN_EL,
    "brief_form": PROPERTY_BRIEF_EL,
}


def available_templates():
    return sorted(CHANNELS)


def _greeting(broker_name: str, formal: bool = True) -> str:
    name = (broker_name or "").strip()
    if not name:
        return "Αξιότιμοι συνεργάτες," if formal else "Καλησπέρα σας,"
    return f"Προς το μεσιτικό γραφείο {name},"


def render(
    channel: str,
    broker_name: str = "",
    identity: Optional[Dict[str, str]] = None,
    subject_variant: int = 0,
) -> Dict[str, str]:
    """Fill a channel template for one recipient.

    Returns `{"subject": ..., "body": ...}`; `subject` is empty for channels
    that have none.
    """
    if channel not in CHANNELS:
        raise KeyError(f"unknown channel {channel!r}; have {available_templates()}")

    values = dict(DEFAULT_IDENTITY)
    values.update(identity or {})

    phone = (values.get("phone") or "").strip()
    website = (values.get("website") or "").strip()
    reply_email = (values.get("reply_email") or "").strip()

    context = dict(values)
    context.update(
        {
            "broker_name": broker_name or "",
            "greeting": _greeting(broker_name),
            "greeting_name": f" {broker_name}" if broker_name else "",
            "phone_clause": f" ή καλέστε στο {phone}" if phone else "",
            "phone_sig": f"\nΤηλ.: {phone}" if phone else "",
            "website_sig": f"\n{website}" if website else "",
            "reply_email": reply_email or "[συμπληρώστε email επικοινωνίας]",
            "criteria": CRITERIA_EL.format(**values),
            "models": MODELS_EL,
            "unsubscribe": UNSUBSCRIBE_EL,
        }
    )

    subject = ""
    if channel in ("email", "email_en", "follow_up"):
        template = EMAIL_SUBJECTS[subject_variant % len(EMAIL_SUBJECTS)]
        subject = template.format(**context)
        if channel == "follow_up":
            subject = "Re: " + subject

    return {"subject": subject, "body": CHANNELS[channel].format(**context)}
