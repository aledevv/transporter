import json
import os
import re

import pandas as pd

try:
    from gemini_agent import call_agent_with_key
    _AGENT_AVAILABLE = True
    print("[AddressCorrector] gemini_agent imported successfully.")
except Exception as _err:
    call_agent_with_key = None
    _AGENT_AVAILABLE = False
    print(f"[AddressCorrector] gemini_agent import FAILED — correction disabled. Reason: {_err}")

# Names of env vars tried in order when rate-limit errors occur.
_API_KEY_NAMES = ["GOOGLE_API_KEY", "GOOGLE_API_KEY2", "GOOGLE_API_KEY3"]

# Column written to the corrected Excel to mark it as already processed.
# If this column is present and True for all rows, the agent is skipped.
FLAG_COL = "AI_Corrected"


class AddressCorrector:
    """
    Normalizes Italian school addresses for OSM Nominatim using the Gemini agent.

    Flow:
      1. Read the uploaded Excel.
      2. If FLAG_COL is already set for all rows → skip (avoids unnecessary API costs).
      3. Send all addresses to call_agent() as a JSON string.
      4. Parse the response (expected: list of {id, normalized_address}).
      5. Apply corrections to the school list and save <name>_corretto.xlsx with FLAG_COL=True.
    """

    def __init__(self):
        self._enabled = _AGENT_AVAILABLE and call_agent_with_key is not None
        if not self._enabled:
            print("[AddressCorrector] Agent unavailable — address correction disabled.")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    # Possible status values returned by correct_addresses
    STATUS_OK = "ok"
    STATUS_SKIPPED_FLAGGED = "skipped_flagged"
    STATUS_SKIPPED_DISABLED = "skipped_disabled"
    STATUS_RATE_LIMIT = "rate_limit"
    STATUS_ERROR = "error"

    def correct_addresses(self, schools, original_excel_path, output_path):
        """
        Returns (corrected_schools, status) where status is one of the STATUS_* constants.
        Never raises — falls back to the original list on any failure.
        """
        if not self._enabled:
            return schools, self.STATUS_SKIPPED_DISABLED

        df = pd.read_excel(original_excel_path)
        df.columns = [c.strip() for c in df.columns]

        if FLAG_COL in df.columns and df[FLAG_COL].astype(bool).all():
            print("[AddressCorrector] Already AI-corrected — skipping.")
            return schools, self.STATUS_SKIPPED_FLAGGED

        address_data = [{"id": s["name"], "address": s["address"]} for s in schools]

        try:
            raw = self._call_with_fallback(json.dumps(address_data, ensure_ascii=False))
            corrections = self._parse_response(raw)
            corrected_schools = self._apply_corrections(schools, corrections)
            self._save_corrected_excel(df, corrections, output_path)

            changed = sum(
                1 for s in schools
                if s["name"] in corrections and corrections[s["name"]] != s["address"]
            )
            print(f"[AddressCorrector] Corrected {changed}/{len(schools)} addresses → {output_path}")
            return corrected_schools, self.STATUS_OK

        except Exception as exc:
            status = self._classify_error(exc)
            print(f"[AddressCorrector] {status} — using original addresses. Reason: {exc}")
            return schools, status

    def _call_with_fallback(self, user_input):
        """
        Tries GOOGLE_API_KEY → GOOGLE_API_KEY2 → GOOGLE_API_KEY3 in order.
        Moves to the next key only on rate-limit errors; any other error raises immediately.
        Raises the last rate-limit exception if all keys are exhausted.
        """
        keys = [(name, os.environ.get(name)) for name in _API_KEY_NAMES]
        keys = [(name, key) for name, key in keys if key]

        if not keys:
            raise RuntimeError("No API keys configured (GOOGLE_API_KEY not set)")

        last_exc = None
        for name, key in keys:
            try:
                return call_agent_with_key(user_input, key)
            except Exception as exc:
                if self._classify_error(exc) == self.STATUS_RATE_LIMIT:
                    print(f"[AddressCorrector] Rate limit on {name} — trying next key...")
                    last_exc = exc
                    continue
                raise  # Non-rate-limit error: surface immediately

        raise last_exc  # All keys exhausted

    @staticmethod
    def _classify_error(exc):
        """Returns STATUS_RATE_LIMIT for quota/rate errors, STATUS_ERROR otherwise."""
        msg = str(exc).lower()
        rate_limit_signals = ("429", "quota", "resource_exhausted", "resourceexhausted", "rate limit", "rate_limit")
        if any(s in msg for s in rate_limit_signals):
            return AddressCorrector.STATUS_RATE_LIMIT
        return AddressCorrector.STATUS_ERROR

    # ------------------------------------------------------------------
    # Internals (kept public for unit testing)
    # ------------------------------------------------------------------

    def _parse_response(self, raw):
        """
        Parses the agent response into {id: normalized_address}.
        Strips markdown code fences and cleans up empty comma-separated fields.
        """
        clean = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
        data = json.loads(clean)
        return {item["id"]: self._clean_address(item["normalized_address"]) for item in data}

    @staticmethod
    def _clean_address(address):
        """Removes empty segments from a comma-separated address string.

        'Piazza, , , Campitello di Fassa, Trento, Italy'
        → 'Piazza, Campitello di Fassa, Trento, Italy'
        """
        parts = [p.strip() for p in address.split(",")]
        parts = [p for p in parts if p]
        return ", ".join(parts)

    def _apply_corrections(self, schools, corrections):
        result = []
        for school in schools:
            s = school.copy()
            if s["name"] in corrections:
                s["address"] = corrections[s["name"]]
            result.append(s)
        return result

    def _save_corrected_excel(self, df, corrections, output_path):
        """Writes the corrected Excel with FLAG_COL=True on every row."""
        for name, normalized in corrections.items():
            df.loc[df["Nome"] == name, "Indirizzo"] = normalized
        df[FLAG_COL] = True
        df.to_excel(output_path, index=False)
