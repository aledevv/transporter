import json
import os
import re

import pandas as pd
from dotenv import load_dotenv

load_dotenv()  # Load .env locally; on Cloud Run env vars come from the service config and are already set.

try:
    from gemini_agent import call_agent_with_key
    _AGENT_AVAILABLE = True
    print("[AddressCorrector] gemini_agent imported successfully.")
except Exception as _err:
    call_agent_with_key = None
    _AGENT_AVAILABLE = False
    print(f"[AddressCorrector] gemini_agent import FAILED — correction disabled. Reason: {_err}")

# Names of env vars tried in order when rate-limit errors occur.
_API_KEY_NAMES = ["GOOGLE_API_KEY", "GOOGLE_API_KEY2", "GOOGLE_API_KEY3", "GOOGLE_API_KEY4", "GOOGLE_API_KEY5"]

# Column written to the corrected Excel to mark it as already processed.
# If this column is present and True for all rows, the agent is skipped.
FLAG_COL = "AI_Corrected"


class AddressCorrector:
    """
    Normalizes Italian school addresses for OSM Nominatim using the Gemini agent.

    Flow:
      1. Read the uploaded Excel.
      2. If FLAG_COL is already set for all rows → skip (avoids unnecessary API costs).
      3. Apply cache hits: for schools whose name is already in school_address_cache.json
         the normalized address is used directly — these schools are excluded from the AI call.
      4. Send remaining schools to the Gemini agent as a JSON string.
      5. Parse the response (expected: list of {id, normalized_address}).
      6. Apply corrections to the school list and save <name>_corretto.xlsx with FLAG_COL=True.
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
        Returns (corrected_schools, status, unresolved_names) where:
          - status is one of the STATUS_* constants
          - unresolved_names is a list of school names the agent could not geocode
        Never raises — falls back to the original list on any failure.
        """
        if not self._enabled:
            return schools, self.STATUS_SKIPPED_DISABLED, []

        # If no original Excel path (e.g. resume from Firestore), skip FLAG_COL check
        df = None
        has_excel = original_excel_path and os.path.exists(original_excel_path)
        if has_excel:
            df = pd.read_excel(original_excel_path)
            df = df.reset_index(drop=True)
            df.columns = [c.strip() for c in df.columns]

            if FLAG_COL in df.columns and df[FLAG_COL].astype(bool).all():
                print("[AddressCorrector] Already AI-corrected — skipping.")
                return schools, self.STATUS_SKIPPED_FLAGGED, []

        address_data = [
            {"id": s["id"], "name": s["name"], "address": s["address"]}
            for s in schools
        ]

        try:
            ai_corrections: dict = {}
            unresolved_ids = set()
            if address_data:
                raw = self._call_with_fallback(json.dumps(address_data, ensure_ascii=False))
                ai_corrections, unresolved_ids = self._parse_response(raw)
            corrections = ai_corrections
            corrected_schools = self._apply_corrections(schools, corrections)
            # Schools the agent could not geocode get an empty address so that
            # the geocoding step fails cleanly (geocoding_failed=True) and the
            # frontend orange banner can ask the user for a manual replacement.
            corrected_schools = [
                {**s, "address": ""} if s["id"] in unresolved_ids else s
                for s in corrected_schools
            ]
            if df is not None and output_path:
                self._save_corrected_excel(df, corrections, output_path)

            changed = sum(
                1 for s in schools
                if s["id"] in corrections and corrections[s["id"]] != s["address"]
            )
            unresolved_names = [s["name"] for s in schools if s["id"] in unresolved_ids]
            if unresolved_names:
                print(f"[AddressCorrector] {len(unresolved_names)} addresses unresolved by agent: {unresolved_names}")
            print(f"[AddressCorrector] Corrected {changed}/{len(schools)} addresses → {output_path}")
            return corrected_schools, self.STATUS_OK, unresolved_names

        except Exception as exc:
            status = self._classify_error(exc)
            print(f"[AddressCorrector] {status} — using original addresses. Reason: {exc}")
            return schools, status, []

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Fallback / key rotation
    # ------------------------------------------------------------------

    def _call_with_fallback(self, user_input):
        """
        Tries GOOGLE_API_KEY → GOOGLE_API_KEY2 → … → GOOGLE_API_KEY5 in order.
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
        Parses the agent response into ({id: normalized_address}, unresolved_ids_set).
        Items where normalized_address is empty (agent could not geocode) are excluded from
        the corrections dict and collected in unresolved_ids.
        Strips markdown code fences and cleans up empty comma-separated fields.
        """
        clean = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
        data = json.loads(clean)
        corrections = {}
        unresolved_ids = set()
        for item in data:
            sid = item.get("id")
            if sid is None:
                print(f"[AddressCorrector] _parse_response: item missing 'id', skipping: {item}")
                continue
            addr = item.get("normalized_address", "")
            if addr:
                corrections[sid] = self._clean_address(addr)
            else:
                unresolved_ids.add(sid)
        return corrections, unresolved_ids

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
            if s["id"] in corrections:
                s["address"] = corrections[s["id"]]
            result.append(s)
        return result

    def _save_corrected_excel(self, df, corrections, output_path):
        """Writes the corrected Excel with FLAG_COL=True on every row."""
        for school_id, normalized in corrections.items():
            df.at[school_id, "Indirizzo"] = normalized
        df[FLAG_COL] = True
        df.to_excel(output_path, index=False)
