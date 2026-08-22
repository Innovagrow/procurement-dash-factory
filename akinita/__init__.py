"""
Real Estate Opportunity Engine
================================================

Two capabilities, one package:

1. `screener`  - crawl Greek property portals with hard filters (e.g. the whole
                 of Greece, for sale, up to EUR 50.000), score every listing on
                 how good a *business* opportunity it is, and export a ranked
                 shortlist (CSV / JSON / HTML report).

2. `brokers` + `outreach` - build a directory of Greek real estate
                 professionals and render the  outreach campaign
                 (email / SMS / Viber / LinkedIn) personalised per recipient.

Everything here is stdlib-only so it runs on a bare Python 3.9+ install.
"""

__version__ = "1.0.0"
__all__ = ["http", "geo", "models", "scoring", "sources", "outreach"]
