"""Tests for geocodingTool (OSM Nominatim)."""
import sys
import os
from unittest.mock import MagicMock, patch

# conftest.py stubs gemini_agent as a MagicMock (needed by address_corrector tests).
# We need the real module here, so pop the stub and re-import.
# All heavy deps (datapizza, pydantic, dotenv) must be stubbed first.
for _mod in [
    "dotenv",
    "datapizza",
    "datapizza.clients",
    "datapizza.clients.google",
    "datapizza.agents",
    "datapizza.tools",
    "datapizza.tools.duckduckgo",
    "pydantic",
    "gemini_SYSTEM_PROMPT",
]:
    sys.modules[_mod] = MagicMock()

# datapizza.tools.tool must be a no-op decorator
sys.modules["datapizza.tools"].tool = lambda fn: fn

# Remove the conftest-registered MagicMock so the real module is imported below
sys.modules.pop("gemini_agent", None)

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from gemini_agent import geocodingTool  # noqa: E402

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

SAMPLE_RESULTS = [
    {"display_name": "Via Roma, 1, Trento, Trentino-Alto Adige, Italia"},
    {"display_name": "Via Roma, 10, Rovereto, Trentino-Alto Adige, Italia"},
    {"display_name": "Via Roma, 5, Riva del Garda, Trentino-Alto Adige, Italia"},
]


def _make_response(json_data, status_code=200):
    mock = MagicMock()
    mock.status_code = status_code
    mock.json.return_value = json_data
    return mock


class TestGeocodingTool:
    def test_returns_numbered_list_on_success(self):
        with patch("gemini_agent.req.get", return_value=_make_response(SAMPLE_RESULTS)):
            result = geocodingTool("Via Roma Trento")

        lines = result.strip().splitlines()
        assert len(lines) == 3
        assert lines[0].startswith("1.")
        assert lines[1].startswith("2.")
        assert lines[2].startswith("3.")
        assert "Trento" in lines[0]

    def test_display_names_in_output(self):
        with patch("gemini_agent.req.get", return_value=_make_response(SAMPLE_RESULTS)):
            result = geocodingTool("Via Roma Trento")

        assert "Via Roma, 1, Trento" in result
        assert "Via Roma, 10, Rovereto" in result

    def test_no_results_returns_message(self):
        with patch("gemini_agent.req.get", return_value=_make_response([])):
            result = geocodingTool("indirizzo inesistente xyz")

        assert "No results found for:" in result
        assert "indirizzo inesistente xyz" in result

    def test_network_error_returns_tool_error(self):
        with patch("gemini_agent.req.get", side_effect=ConnectionError("timeout")):
            result = geocodingTool("Via Roma Trento")

        assert result.startswith("Tool error:")
        assert "timeout" in result

    def test_calls_nominatim_url(self):
        with patch("gemini_agent.req.get", return_value=_make_response(SAMPLE_RESULTS)) as mock_get:
            geocodingTool("Piazza Dante Trento")

        called_url = mock_get.call_args[0][0]
        assert called_url == NOMINATIM_URL

    def test_uses_correct_params(self):
        with patch("gemini_agent.req.get", return_value=_make_response(SAMPLE_RESULTS)) as mock_get:
            geocodingTool("liceo trento")

        params = mock_get.call_args[1]["params"]
        assert params["countrycodes"] == "it"
        assert params["format"] == "json"
        assert params["limit"] == 5
        assert params["q"] == "liceo trento"

    def test_sets_user_agent_header(self):
        with patch("gemini_agent.req.get", return_value=_make_response(SAMPLE_RESULTS)) as mock_get:
            geocodingTool("scuola Rovereto")

        headers = mock_get.call_args[1]["headers"]
        assert "User-Agent" in headers
        assert headers["User-Agent"] != ""

    def test_limits_to_five_results(self):
        many_results = [{"display_name": f"Result {i}"} for i in range(10)]
        with patch("gemini_agent.req.get", return_value=_make_response(many_results)):
            result = geocodingTool("scuola")

        lines = [ln for ln in result.strip().splitlines() if ln]
        assert len(lines) == 5
        assert lines[4].startswith("5.")
