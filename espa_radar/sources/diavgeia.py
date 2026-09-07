"""Διαύγεια (opendata API) — προσκλήσεις & αποφάσεις χρηματοδότησης.

Προσοχή στην παράμετρο αναζήτησης: το endpoint αγνοεί σιωπηλά το `q` και
δέχεται `subject` (αναζήτηση στο θέμα της απόφασης). Με `q` θα έπαιρνες
απλώς τις πιο πρόσφατες αποφάσεις όλης της χώρας.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from ..textutils import strip_html
from .base import RawProgram, Source, SourceError
from .http import get_json

logger = logging.getLogger(__name__)

SEARCH_URL = "https://diavgeia.gov.gr/opendata/search.json"
DOC_URL = "https://diavgeia.gov.gr/doc/{ada}"


def _epoch_ms(value) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


class DiavgeiaSource(Source):
    """options:
    subject       – φράση ή λίστα φράσεων αναζήτησης στο θέμα (υποχρεωτικό)
    size          – αποτελέσματα ανά φράση (default 50)
    decision_types – προαιρετικό φίλτρο τύπου απόφασης
    """

    def fetch(self) -> list[RawProgram]:
        subjects = self.options.get("subject") or self.options.get("subjects")
        if isinstance(subjects, str):
            subjects = [subjects]
        if not subjects:
            raise SourceError(f"[{self.source_id}] λείπει το 'subject'")

        size = int(self.options.get("size", 50))
        decision_types = self.options.get("decision_types")

        seen: set[str] = set()
        results: list[RawProgram] = []
        errors: list[str] = []

        for subject in subjects:
            params: dict[str, object] = {"subject": subject, "size": size, "order": "recent"}
            if decision_types:
                params["decisionType"] = decision_types

            try:
                payload = get_json(SEARCH_URL, params=params)
            except Exception as exc:  # noqa: BLE001 - μία φράση που αποτυγχάνει δεν ρίχνει τις άλλες
                errors.append(f"'{subject}': {exc}")
                continue

            decisions = payload.get("decisions", []) if isinstance(payload, dict) else []
            for decision in decisions:
                ada = decision.get("ada")
                raw_subject = strip_html(" ".join((decision.get("subject") or "").split()))
                if not ada or not raw_subject or ada in seen:
                    continue
                seen.add(ada)

                organization = decision.get("organizationId") or ""
                results.append(
                    RawProgram(
                        source_id=self.source_id,
                        source_name=self.name,
                        external_id=ada,
                        title=raw_subject[:590],
                        url=decision.get("documentUrl") or DOC_URL.format(ada=ada),
                        summary=raw_subject,
                        body=" ".join(filter(None, [raw_subject, decision.get("decisionTypeId"), organization])),
                        published_at=_epoch_ms(
                            decision.get("issueDate") or decision.get("submissionTimestamp")
                        ),
                        extra={
                            "ada": ada,
                            "organization": organization,
                            "protocol": decision.get("protocolNumber"),
                            "query": subject,
                        },
                    )
                )

        if not results and errors:
            raise SourceError(f"[{self.source_id}] " + "; ".join(errors))

        logger.info("[%s] %s αποφάσεις από Διαύγεια", self.source_id, len(results))
        return results
