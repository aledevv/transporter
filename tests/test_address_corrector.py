"""Tests for AddressCorrector."""
import json
import os
from unittest.mock import MagicMock, call, patch

import pandas as pd
import pytest

from address_corrector import FLAG_COL, AddressCorrector
from conftest import MOCK_AGENT_RESPONSE

RATE_LIMIT_EXC = Exception("429 RESOURCE_EXHAUSTED: quota exceeded")
GENERIC_EXC = RuntimeError("Connection refused")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def corrector():
    c = AddressCorrector()
    c._enabled = True
    return c


@pytest.fixture
def flagged_excel(tmp_path, sample_schools):
    path = tmp_path / "already_done.xlsx"
    df = pd.DataFrame([
        {"Nome": s["name"], "Indirizzo": s["address"], "Partecipanti": s["demand"], FLAG_COL: True}
        for s in sample_schools
    ])
    df.to_excel(path, index=False)
    return path


@pytest.fixture(autouse=True)
def primary_api_key(monkeypatch):
    """Ensure at least one API key is set so _call_with_fallback can proceed."""
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key-1")
    monkeypatch.delenv("GOOGLE_API_KEY2", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY3", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY4", raising=False)


# ---------------------------------------------------------------------------
# correct_addresses — happy path & skipping
# ---------------------------------------------------------------------------

class TestCorrectAddresses:
    def test_corrections_applied_to_returned_schools(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        output = tmp_path / "out.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE):
            result, _, _u = corrector.correct_addresses(sample_schools, str(sample_excel), str(output))

        assert result[0]["address"] == "Via Roma, 1, 38100 Trento, Trentino, Italia"
        assert result[1]["address"] == "Piazza Dante, 3, Rovereto, Trentino, Italia"

    def test_returns_ok_status_on_success(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        output = tmp_path / "out.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE):
            _, status, _ = corrector.correct_addresses(sample_schools, str(sample_excel), str(output))
        assert status == AddressCorrector.STATUS_OK

    def test_returns_empty_unresolved_when_all_found(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        output = tmp_path / "out.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE):
            _, _, unresolved = corrector.correct_addresses(sample_schools, str(sample_excel), str(output))
        assert unresolved == []

    def test_unresolved_returned_when_agent_returns_empty_address(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        """When agent returns empty normalized_address, school name goes in unresolved list
        and its address is set to '' so geocoding fails cleanly."""
        partial_response = json.dumps([
            {"id": 0, "name": "Scuola Primaria Roma", "normalized_address": "Via Roma, 1, 38100 Trento, Trentino, Italia"},
            {"id": 1, "name": "Scuola Media Dante",   "normalized_address": ""},
        ])
        output = tmp_path / "out.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=partial_response):
            result, status, unresolved = corrector.correct_addresses(sample_schools, str(sample_excel), str(output))

        assert status == AddressCorrector.STATUS_OK
        assert unresolved == ["Scuola Media Dante"]
        # Unresolved school gets empty address (forces geocoding_failed=True later)
        assert result[1]["address"] == ""
        # Resolved school gets the new address
        assert result[0]["address"] == "Via Roma, 1, 38100 Trento, Trentino, Italia"

    def test_corrected_excel_saved_with_flag(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        output = tmp_path / "out_corretto.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE):
            corrector.correct_addresses(sample_schools, str(sample_excel), str(output))

        df = pd.read_excel(output)
        assert FLAG_COL in df.columns
        assert df[FLAG_COL].all()
        assert df.loc[0, "Indirizzo"] == "Via Roma, 1, 38100 Trento, Trentino, Italia"
        assert df.loc[1, "Indirizzo"] == "Piazza Dante, 3, Rovereto, Trentino, Italia"

    def test_original_columns_preserved_in_corrected_excel(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        output = tmp_path / "out_corretto.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE):
            corrector.correct_addresses(sample_schools, str(sample_excel), str(output))

        df = pd.read_excel(output)
        for col in ("Nome", "Indirizzo", "Partecipanti", "Istituto"):
            assert col in df.columns

    def test_skip_when_already_flagged(
        self, corrector, sample_schools, flagged_excel, tmp_path
    ):
        output = tmp_path / "out.xlsx"
        mock_fn = MagicMock()
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result, status, unresolved = corrector.correct_addresses(sample_schools, str(flagged_excel), str(output))

        mock_fn.assert_not_called()
        assert result == sample_schools
        assert status == AddressCorrector.STATUS_SKIPPED_FLAGGED
        assert unresolved == []

    def test_partial_flag_does_not_skip(self, corrector, sample_schools, tmp_path):
        partial_excel = tmp_path / "partial.xlsx"
        df = pd.DataFrame([
            {"Nome": s["name"], "Indirizzo": s["address"], "Partecipanti": s["demand"], FLAG_COL: (i == 0)}
            for i, s in enumerate(sample_schools)
        ])
        df.to_excel(partial_excel, index=False)

        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE) as mock_fn:
            _, status, _ = corrector.correct_addresses(sample_schools, str(partial_excel), str(tmp_path / "out.xlsx"))

        mock_fn.assert_called_once()
        assert status == AddressCorrector.STATUS_OK

    def test_disabled_corrector_is_noop(self, sample_schools, sample_excel, tmp_path):
        corrector = AddressCorrector()
        corrector._enabled = False
        mock_fn = MagicMock()
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result, status, unresolved = corrector.correct_addresses(sample_schools, str(sample_excel), str(tmp_path / "out.xlsx"))

        mock_fn.assert_not_called()
        assert result == sample_schools
        assert status == AddressCorrector.STATUS_SKIPPED_DISABLED
        assert unresolved == []

    def test_fallback_on_generic_error(self, corrector, sample_schools, sample_excel, tmp_path):
        with patch("address_corrector.call_agent_with_key", side_effect=GENERIC_EXC):
            result, status, unresolved = corrector.correct_addresses(sample_schools, str(sample_excel), str(tmp_path / "out.xlsx"))

        assert result == sample_schools
        assert status == AddressCorrector.STATUS_ERROR
        assert unresolved == []

    def test_fallback_on_invalid_json(self, corrector, sample_schools, sample_excel, tmp_path):
        with patch("address_corrector.call_agent_with_key", return_value="not valid json {{"):
            result, status, unresolved = corrector.correct_addresses(sample_schools, str(sample_excel), str(tmp_path / "out.xlsx"))

        assert result == sample_schools
        assert status == AddressCorrector.STATUS_ERROR
        assert unresolved == []


# ---------------------------------------------------------------------------
# _call_with_fallback — key rotation logic
# ---------------------------------------------------------------------------

class TestCallWithFallback:
    @pytest.fixture(autouse=True)
    def three_keys(self, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY",  "key-1")
        monkeypatch.setenv("GOOGLE_API_KEY2", "key-2")
        monkeypatch.setenv("GOOGLE_API_KEY3", "key-3")
        monkeypatch.delenv("GOOGLE_API_KEY4", raising=False)

    def test_uses_primary_key_on_success(self, corrector):
        with patch("address_corrector.call_agent_with_key", return_value="ok") as mock_fn:
            result = corrector._call_with_fallback("input")

        assert result == "ok"
        mock_fn.assert_called_once_with("input", "key-1")

    def test_falls_back_to_second_key_on_rate_limit(self, corrector):
        mock_fn = MagicMock(side_effect=[RATE_LIMIT_EXC, "ok-from-key2"])
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result = corrector._call_with_fallback("input")

        assert result == "ok-from-key2"
        assert mock_fn.call_count == 2
        assert mock_fn.call_args_list[0] == call("input", "key-1")
        assert mock_fn.call_args_list[1] == call("input", "key-2")

    def test_falls_back_to_third_key_when_first_two_exhausted(self, corrector):
        mock_fn = MagicMock(side_effect=[RATE_LIMIT_EXC, RATE_LIMIT_EXC, "ok-from-key3"])
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result = corrector._call_with_fallback("input")

        assert result == "ok-from-key3"
        assert mock_fn.call_count == 3

    def test_raises_rate_limit_when_all_keys_exhausted(self, corrector):
        with patch("address_corrector.call_agent_with_key", side_effect=RATE_LIMIT_EXC):
            with pytest.raises(Exception, match="429"):
                corrector._call_with_fallback("input")

    def test_generic_error_does_not_try_next_key(self, corrector):
        mock_fn = MagicMock(side_effect=[GENERIC_EXC, "should-not-reach"])
        with patch("address_corrector.call_agent_with_key", mock_fn):
            with pytest.raises(RuntimeError, match="Connection refused"):
                corrector._call_with_fallback("input")

        mock_fn.assert_called_once()  # Stopped at first key

    def test_only_configured_keys_are_tried(self, corrector, monkeypatch):
        monkeypatch.delenv("GOOGLE_API_KEY3")  # Only 2 keys available
        mock_fn = MagicMock(side_effect=[RATE_LIMIT_EXC, "ok-from-key2"])
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result = corrector._call_with_fallback("input")

        assert result == "ok-from-key2"
        assert mock_fn.call_count == 2

    def test_raises_when_no_keys_configured(self, corrector, monkeypatch):
        monkeypatch.delenv("GOOGLE_API_KEY")
        monkeypatch.delenv("GOOGLE_API_KEY2")
        monkeypatch.delenv("GOOGLE_API_KEY3")
        monkeypatch.delenv("GOOGLE_API_KEY4", raising=False)
        with patch("address_corrector.call_agent_with_key"):
            with pytest.raises(RuntimeError, match="No API keys"):
                corrector._call_with_fallback("input")

    def test_falls_back_to_fourth_key_when_first_three_exhausted(self, monkeypatch, corrector):
        monkeypatch.setenv("GOOGLE_API_KEY4", "key-4")
        mock_fn = MagicMock(side_effect=[RATE_LIMIT_EXC, RATE_LIMIT_EXC, RATE_LIMIT_EXC, "ok-from-key4"])
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result = corrector._call_with_fallback("input")

        assert result == "ok-from-key4"
        assert mock_fn.call_count == 4
        assert mock_fn.call_args_list[3] == call("input", "key-4")

    def test_rate_limit_status_when_all_keys_exhausted_end_to_end(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        """correct_addresses returns STATUS_RATE_LIMIT when all 3 keys are exhausted."""
        with patch("address_corrector.call_agent_with_key", side_effect=RATE_LIMIT_EXC):
            result, status, unresolved = corrector.correct_addresses(
                sample_schools, str(sample_excel), str(tmp_path / "out.xlsx")
            )

        assert result == sample_schools
        assert status == AddressCorrector.STATUS_RATE_LIMIT
        assert unresolved == []


# ---------------------------------------------------------------------------
# _parse_response
# ---------------------------------------------------------------------------

class TestParseResponse:
    @pytest.fixture(autouse=True)
    def make_corrector(self):
        self.corrector = AddressCorrector()

    def test_parses_plain_json(self):
        raw = '[{"id": 0, "name": "Scuola A", "normalized_address": "Via Roma, 1, Trento"}]'
        corrections, unresolved = self.corrector._parse_response(raw)
        assert corrections == {0: "Via Roma, 1, Trento"}
        assert unresolved == set()

    def test_strips_json_markdown_fence(self):
        raw = '```json\n[{"id": 0, "name": "Scuola A", "normalized_address": "Via Roma, 1, Trento"}]\n```'
        corrections, unresolved = self.corrector._parse_response(raw)
        assert corrections == {0: "Via Roma, 1, Trento"}
        assert unresolved == set()

    def test_strips_plain_markdown_fence(self):
        raw = '```\n[{"id": 1, "name": "Scuola B", "normalized_address": "Piazza Dante, Rovereto"}]\n```'
        corrections, unresolved = self.corrector._parse_response(raw)
        assert corrections == {1: "Piazza Dante, Rovereto"}
        assert unresolved == set()

    def test_multiple_items(self):
        raw = json.dumps([
            {"id": 0, "name": "Scuola A", "normalized_address": "Addr A"},
            {"id": 1, "name": "Scuola B", "normalized_address": "Addr B"},
        ])
        corrections, unresolved = self.corrector._parse_response(raw)
        assert corrections == {0: "Addr A", 1: "Addr B"}
        assert unresolved == set()

    def test_item_missing_id_is_skipped(self):
        raw = '[{"name": "Scuola A", "normalized_address": "Via Roma, 1, Trento"}]'
        corrections, unresolved = self.corrector._parse_response(raw)
        assert corrections == {}
        assert unresolved == set()

    def test_empty_fields_cleaned_during_parse(self):
        raw = json.dumps([{"id": 0, "name": "Scuola A", "normalized_address": "Piazza, , , Campitello di Fassa, Trento, Italy"}])
        corrections, unresolved = self.corrector._parse_response(raw)
        assert corrections == {0: "Piazza, Campitello di Fassa, Trento, Italy"}
        assert unresolved == set()

    def test_empty_normalized_address_goes_to_unresolved(self):
        raw = json.dumps([
            {"id": 0, "name": "Scuola A", "normalized_address": "Via Roma, 1, Trento"},
            {"id": 1, "name": "Scuola B", "normalized_address": ""},
        ])
        corrections, unresolved = self.corrector._parse_response(raw)
        assert corrections == {0: "Via Roma, 1, Trento"}
        assert unresolved == {1}

    def test_all_empty_normalized_addresses(self):
        raw = json.dumps([
            {"id": 0, "name": "Scuola A", "normalized_address": ""},
            {"id": 1, "name": "Scuola B", "normalized_address": ""},
        ])
        corrections, unresolved = self.corrector._parse_response(raw)
        assert corrections == {}
        assert unresolved == {0, 1}

    def test_large_dataset_with_mixed_results(self):
        """29-school dataset: verifies parsing handles real-world scale input correctly."""
        schools_29 = [
            {"id": 0,  "name": "IC Levico Terme",         "normalized_address": "Via delle Albere 2, 38050 Tenna, Trentino-Alto Adige, Italia"},
            {"id": 1,  "name": "IC Cles",                 "normalized_address": "Piazza Fiera 1, 38023 Cles, Trentino-Alto Adige, Italia"},
            {"id": 2,  "name": "Liceo Galilei Trento",    "normalized_address": "Via Prepositura 3, 38122 Trento, Trentino-Alto Adige, Italia"},
            {"id": 3,  "name": "Scuola media Pergine",    "normalized_address": "Via Regina Elena 20, 38057 Pergine Valsugana, Trentino-Alto Adige, Italia"},
            {"id": 4,  "name": "Scuola media Rovereto",   "normalized_address": "Via Benacense 14, 38068 Rovereto, Trentino-Alto Adige, Italia"},
            {"id": 5,  "name": "ITC Fontana Rovereto",    "normalized_address": "Via Balteri 4, 38068 Rovereto, Trentino-Alto Adige, Italia"},
            {"id": 6,  "name": "Scuola primaria Levico",  "normalized_address": "Via Roma 30, 38056 Levico Terme, Trentino-Alto Adige, Italia"},
            {"id": 7,  "name": "Scuola media Riva del Garda", "normalized_address": "Viale Giuseppe Prati 4, 38066 Riva del Garda, Trentino-Alto Adige, Italia"},
            {"id": 8,  "name": "Scuola media Arco",       "normalized_address": "Via dei Capitelli 15, 38062 Arco, Trentino-Alto Adige, Italia"},
            {"id": 9,  "name": "Scuola superiore Tione",  "normalized_address": "Via Durighello 8, 38079 Tione di Trento, Trentino-Alto Adige, Italia"},
            {"id": 10, "name": "Scuola media Cavalese",   "normalized_address": "Via Francesco Bronzetti 5, 38033 Cavalese, Trentino-Alto Adige, Italia"},
            {"id": 11, "name": "Scuola media Bressanone", "normalized_address": "Via Bruno Buozzi 10, 39042 Bressanone, Trentino-Alto Adige, Italia"},
            {"id": 12, "name": "Scuola media Brunico",    "normalized_address": "Via Gilm 5, 39031 Brunico, Trentino-Alto Adige, Italia"},
            {"id": 13, "name": "Scuola media Egna",       "normalized_address": "Via Guglielmo Marconi 7, 39044 Egna, Trentino-Alto Adige, Italia"},
            {"id": 14, "name": "Scuola media Lavis",      "normalized_address": "Via Riccardo Zandonai 1, 38015 Lavis, Trentino-Alto Adige, Italia"},
            {"id": 15, "name": "Scuola media Mezzolombardo", "normalized_address": "Via Damiano Chiesa 2, 38017 Mezzolombardo, Trentino-Alto Adige, Italia"},
            {"id": 16, "name": "Scuola elementare Roncegno", "normalized_address": "Via Roma 10, 38050 Roncegno Terme, Trentino-Alto Adige, Italia"},
            {"id": 17, "name": "Scuola primaria Pinzolo", "normalized_address": "Via al Sole 3, 38086 Pinzolo, Trentino-Alto Adige, Italia"},
            {"id": 18, "name": "Scuola media Predazzo",   "normalized_address": "Via Fiamme Gialle 12, 38037 Predazzo, Trentino-Alto Adige, Italia"},
            {"id": 19, "name": "Scuola media Borgo Valsugana", "normalized_address": "Via per Tesino 5, 38051 Borgo Valsugana, Trentino-Alto Adige, Italia"},
            {"id": 20, "name": "Scuola primaria Andalo",  "normalized_address": "Via Priori 2, 38010 Andalo, Trentino-Alto Adige, Italia"},
            {"id": 21, "name": "Istituto agrario San Michele", "normalized_address": "Via Edmund Mach 1, 38010 San Michele all'Adige, Trentino-Alto Adige, Italia"},
            {"id": 22, "name": "Scuola media Ala",        "normalized_address": "Via Papa Giovanni XXIII 4, 38061 Ala, Trentino-Alto Adige, Italia"},
            {"id": 23, "name": "Scuola media Mori",       "normalized_address": "Via Teatro 12, 38065 Mori, Trentino-Alto Adige, Italia"},
            {"id": 24, "name": "Scuola media Madonna di Campiglio", "normalized_address": ""},  # simulated unresolved
            {"id": 25, "name": "Liceo Walther Bolzano",   "normalized_address": "Piazza Walther 1, 39100 Bolzano, Trentino-Alto Adige, Italia"},
            {"id": 26, "name": "Scuola media via Claudia Augusta", "normalized_address": "Via Claudia Augusta 2, 39100 Bolzano, Trentino-Alto Adige, Italia"},
            {"id": 27, "name": "Scuola elementare via Roma Merano", "normalized_address": "Via Roma 160, 39012 Merano, Trentino-Alto Adige, Italia"},
            {"id": 28, "name": "Scuola superiore Merano", "normalized_address": ""},  # simulated unresolved
        ]
        raw = json.dumps(schools_29)
        corrections, unresolved = self.corrector._parse_response(raw)

        assert len(corrections) == 27  # 29 total - 2 unresolved
        assert len(unresolved) == 2
        assert 24 in unresolved  # Scuola media Madonna di Campiglio
        assert 28 in unresolved  # Scuola superiore Merano
        assert 0 in corrections  # IC Levico Terme
        assert corrections[2] == "Via Prepositura 3, 38122 Trento, Trentino-Alto Adige, Italia"  # Liceo Galilei Trento


# ---------------------------------------------------------------------------
# _clean_address
# ---------------------------------------------------------------------------

class TestCleanAddress:
    @pytest.mark.parametrize("raw, expected", [
        ("Piazza, , , Campitello di Fassa, Trento, Italy",
         "Piazza, Campitello di Fassa, Trento, Italy"),
        ("Via Roma, 1, , 38100 Trento, , Italy",
         "Via Roma, 1, 38100 Trento, Italy"),
        ("Via Roma, 1, Trento, Italy",          # already clean
         "Via Roma, 1, Trento, Italy"),
        (",, ,",                                 # all empty
         ""),
        ("Trento",                               # single token, no commas
         "Trento"),
    ])
    def test_removes_empty_segments(self, raw, expected):
        assert AddressCorrector._clean_address(raw) == expected

    def test_strips_whitespace_around_segments(self):
        assert AddressCorrector._clean_address("Via Roma ,  1  ,  , Trento") == "Via Roma, 1, Trento"


# ---------------------------------------------------------------------------
# _classify_error
# ---------------------------------------------------------------------------

class TestClassifyError:
    @pytest.mark.parametrize("message", [
        "429 Too Many Requests",
        "RESOURCE_EXHAUSTED: quota exceeded",
        "ResourceExhausted",
        "rate limit reached",
        "daily quota exceeded",
    ])
    def test_rate_limit_signals(self, message):
        assert AddressCorrector._classify_error(Exception(message)) == AddressCorrector.STATUS_RATE_LIMIT

    @pytest.mark.parametrize("message", [
        "Connection refused",
        "Invalid JSON response",
        "Timeout",
        "Internal Server Error",
    ])
    def test_generic_errors(self, message):
        assert AddressCorrector._classify_error(Exception(message)) == AddressCorrector.STATUS_ERROR
