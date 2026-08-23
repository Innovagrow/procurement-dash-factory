# -*- coding: utf-8 -*-
"""
Διακόπτης φωτεινού/σκοτεινού, κοινός για κάθε σελίδα που παράγει το εργαλείο.

Οι καταστάσεις είναι τρεις, όχι δύο. Η προεπιλογή είναι «σύστημα»: καμία
σήμανση στο <html>, οπότε αποφασίζει το prefers-color-scheme του θεατή. Μια
ρητή επιλογή γράφει data-theme="light" ή "dark" και υπερισχύει προς τις δύο
κατευθύνσεις. Επιστροφή στο «σύστημα» σβήνει τη σήμανση — δεν την αντικαθιστά
με μάντεμα της τρέχουσας προτίμησης.

Η επιλογή θυμάται μόνο σε αυτόν τον browser. Κάθε ανάγνωση και γραφή είναι σε
try/catch: σε ιδιωτικό παράθυρο ή με μπλοκαρισμένη αποθήκευση, ο accessor
πετάει, και μια σελίδα που δεν φορτώνει επειδή δεν μπόρεσε να θυμηθεί ένα
χρώμα είναι χειρότερη από μια σελίδα που δεν θυμάται.
"""
from __future__ import annotations

STORAGE_KEY = "akinita-theme"

CSS = """
  .theme{display:inline-flex;align-items:center;gap:0;background:var(--surface);
    border:1px solid var(--line);border-radius:999px;padding:2px}
  .theme button{font-family:var(--ui);font-size:11.5px;font-weight:500;line-height:1;
    color:var(--muted);background:none;border:0;border-radius:999px;padding:6px 11px;
    cursor:pointer;letter-spacing:.01em}
  .theme button:hover{color:var(--ink)}
  .theme button[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent);
    font-weight:600}
  .theme button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
"""

CONTROL = """<div class="theme" role="group" aria-label="Θέμα σελίδας">
  <button type="button" data-set="system" aria-pressed="true">Σύστημα</button>
  <button type="button" data-set="light" aria-pressed="false">Φωτεινό</button>
  <button type="button" data-set="dark" aria-pressed="false">Σκοτεινό</button>
</div>"""

SCRIPT = """<script>
(function () {
  var KEY = "%s";
  var root = document.documentElement;
  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function apply(choice) {
    if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
    else root.removeAttribute("data-theme");
    var buttons = document.querySelectorAll(".theme button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed",
        String(buttons[i].getAttribute("data-set") === (choice || "system")));
    }
  }
  apply(stored() || "system");
  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest(".theme button") : null;
    if (!button) return;
    var choice = button.getAttribute("data-set");
    apply(choice);
    try {
      if (choice === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch (e) { /* η σελίδα δουλεύει· απλώς δεν θα το θυμάται */ }
  });
})();
</script>""" % STORAGE_KEY
