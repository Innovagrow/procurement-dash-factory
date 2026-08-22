# -*- coding: utf-8 -*-
"""
Greek transaction, holding and works cost model.

Every number here is a *starting assumption*, not a fact of nature. They are
collected in one file precisely so they can be argued with and recalibrated
against your own closed deals - which is the only calibration that matters.
Rates that Greek policy keeps suspending and reinstating (capital gains tax,
VAT on new builds) are flagged so nobody mistakes a default for a certainty.

Sources to re-check each year: the transfer tax rate and the municipal
surcharge on it, the notary scale, the Land Registry fee, ENFIA zone rates,
the rental income brackets, and the short-stay climate resilience levy.
"""
from __future__ import annotations

import dataclasses
from typing import Dict, Optional


@dataclasses.dataclass
class CostModel:
    """All cost assumptions in one place, so a run can be re-priced at once."""

    # ---- acquisition ----------------------------------------------------
    transfer_tax_pct: float = 3.09        # 3% + 3% municipal surcharge on the tax
    vat_on_new_build_pct: float = 0.0     # 24% by law, suspended repeatedly - set it if it applies
    notary_pct: float = 1.10              # incl. VAT, on the higher of price / objective value
    lawyer_pct: float = 0.70              # no longer compulsory below thresholds, still advisable
    land_registry_pct: float = 0.575      # transcription + Land Registry
    buyer_agent_pct: float = 1.24         # 1% + VAT, when a broker is on the buy side
    technical_survey_eur: float = 500.0   # engineer's inspection, flat
    legal_dd_eur: float = 700.0           # title search, encumbrances, planning file

    # ---- disposal -------------------------------------------------------
    seller_agent_pct: float = 2.48        # 2% + VAT
    capital_gains_tax_pct: float = 0.0    # 15% by law, suspended - set it if reinstated
    disposal_certificates_eur: float = 600.0   # energy certificate, engineer's statements

    # ---- holding, per year ----------------------------------------------
    enfia_per_sqm_eur: float = 4.5        # zone-dependent: ~2 EUR rural, ~13 EUR prime Athens
    maintenance_pct_of_value: float = 1.0
    insurance_pct_of_value: float = 0.15
    common_charges_per_sqm_month: float = 0.9   # only where a building has shared costs

    # ---- works, EUR per sqm ---------------------------------------------
    works_cosmetic_per_sqm: float = 200.0   # paint, minor repairs, floors
    works_full_per_sqm: float = 700.0       # wiring, plumbing, bathroom, kitchen, frames
    works_structural_per_sqm: float = 1150.0  # plus structural work, layout changes
    works_contingency_pct: float = 15.0     # nothing in Greek renovation finishes on budget
    furnishing_per_sqm: float = 180.0       # needed for short-stay, optional for long lets

    # ---- income taxation -------------------------------------------------
    rent_tax_brackets: tuple = ((12000, 15.0), (35000, 35.0), (float("inf"), 45.0))
    short_stay_levy_per_night_eur: float = 1.5   # climate resilience levy, seasonal average

    # ---- operating, short stay ------------------------------------------
    platform_fee_pct: float = 15.0
    management_fee_pct: float = 20.0      # drop to 0 if self-managed, but see `ease`
    cleaning_per_stay_eur: float = 35.0
    average_stay_nights: float = 3.5

    def acquisition_costs(self, price: float, new_build: bool = False,
                          with_buyer_agent: bool = True) -> Dict[str, float]:
        """Everything payable on top of the price to actually own the thing."""
        tax = price * (self.vat_on_new_build_pct if new_build else self.transfer_tax_pct) / 100.0
        costs = {
            "φόρος μεταβίβασης" if not new_build else "ΦΠΑ νεόδμητου": tax,
            "συμβολαιογράφος": price * self.notary_pct / 100.0,
            "δικηγόρος": price * self.lawyer_pct / 100.0,
            "κτηματολόγιο": price * self.land_registry_pct / 100.0,
            "τεχνικός έλεγχος": self.technical_survey_eur,
            "νομικός έλεγχος": self.legal_dd_eur,
        }
        if with_buyer_agent:
            costs["μεσιτική αγοραστή"] = price * self.buyer_agent_pct / 100.0
        return costs

    def disposal_costs(self, sale_price: float, purchase_price: float = 0.0) -> Dict[str, float]:
        gain = max(0.0, sale_price - purchase_price)
        return {
            "μεσιτική πωλητή": sale_price * self.seller_agent_pct / 100.0,
            "πιστοποιητικά": self.disposal_certificates_eur,
            "φόρος υπεραξίας": gain * self.capital_gains_tax_pct / 100.0,
        }

    def annual_holding_costs(self, value: float, size_sqm: float,
                             has_common_charges: bool = True) -> Dict[str, float]:
        costs = {
            "ΕΝΦΙΑ": size_sqm * self.enfia_per_sqm_eur,
            "συντήρηση": value * self.maintenance_pct_of_value / 100.0,
            "ασφάλιση": value * self.insurance_pct_of_value / 100.0,
        }
        if has_common_charges:
            costs["κοινόχρηστα"] = size_sqm * self.common_charges_per_sqm_month * 12.0
        return costs

    def works_cost(self, size_sqm: float, level: str, furnish: bool = False) -> float:
        """`level` is one of cosmetic / full / structural / none."""
        rates = {
            "none": 0.0,
            "cosmetic": self.works_cosmetic_per_sqm,
            "full": self.works_full_per_sqm,
            "structural": self.works_structural_per_sqm,
        }
        if level not in rates:
            raise ValueError(f"unknown works level {level!r}")
        base = size_sqm * rates[level]
        total = base * (1 + self.works_contingency_pct / 100.0)
        if furnish:
            total += size_sqm * self.furnishing_per_sqm
        return total

    def tax_on_rent(self, annual_rent: float) -> float:
        """Progressive tax on rental income, applied bracket by bracket."""
        tax, lower = 0.0, 0.0
        for upper, rate in self.rent_tax_brackets:
            if annual_rent <= lower:
                break
            taxable = min(annual_rent, upper) - lower
            tax += taxable * rate / 100.0
            lower = upper
        return tax


DEFAULT_COSTS = CostModel()
