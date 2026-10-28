"""Tests for Flask API routes."""
import io
import os
import json
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# /api/upload
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# /api/status
# ---------------------------------------------------------------------------

class TestStatus:
    def test_unknown_task_returns_404(self, app_client):
        resp = app_client.get("/api/status/nonexistent-task-id")
        assert resp.status_code == 404

    def test_known_task_returns_status(self, app_client):
        from app import tasks
        tasks["test-task-123"] = {"status": "processing", "progress": 50, "message": "Working..."}
        resp = app_client.get("/api/status/test-task-123")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "processing"
        assert body["progress"] == 50


# ---------------------------------------------------------------------------
# /api/optimize
# ---------------------------------------------------------------------------

class TestOptimize:
    def test_missing_schools_returns_400(self, app_client):
        resp = app_client.post(
            "/api/optimize",
            json={"destination": "Trento, Italia"},
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_missing_destination_returns_400(self, app_client):
        resp = app_client.post(
            "/api/optimize",
            json={"schools": [{"id": 0, "name": "A", "address": "Via Roma 1", "demand": 5}]},
            content_type="application/json",
        )
        assert resp.status_code == 400

    def test_empty_schools_list_returns_400(self, app_client):
        resp = app_client.post(
            "/api/optimize",
            json={"schools": [], "destination": "Trento, Italia"},
            content_type="application/json",
        )
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# /api/download
# ---------------------------------------------------------------------------

class TestDownload:
    def test_missing_file_returns_404(self, app_client):
        resp = app_client.get("/api/download/nonexistent_corretto.xlsx")
        assert resp.status_code == 404

    def test_existing_file_is_served(self, app_client, tmp_path):
        import os
        from app import UPLOAD_FOLDER

        # Write a dummy file into the uploads folder
        dummy = os.path.join(UPLOAD_FOLDER, "dummy_corretto.xlsx")
        try:
            with open(dummy, "wb") as f:
                f.write(b"PK\x03\x04")  # Minimal XLSX magic bytes
            resp = app_client.get("/api/download/dummy_corretto.xlsx")
            assert resp.status_code == 200
        finally:
            if os.path.exists(dummy):
                os.remove(dummy)


# ---------------------------------------------------------------------------
# continue_file_task: DB resolutions saved without coordinates
# ---------------------------------------------------------------------------

class TestContinueWithoutCoords:
    def test_resolution_without_coords_is_geocoded_instead_of_failing(self):
        import app as app_module
        schools = [
            {"id": 0, "name": "IS ENAIP TIONE", "address": "Via Durone 57, Tione di Trento"},
            {"id": 1, "name": "ITET Fontana", "address": "Via Teatro 4, Rovereto"},
        ]
        resolutions = {
            "0": {"lat": None, "lon": None, "address": "stazione dei trenti - Tione", "name": "IS ENAIP TIONE"},
            "1": {"lat": 45.8937076, "lon": 11.0420967, "address": "Via del Teatro 4, Rovereto", "name": "ITET Fontana"},
        }
        app_module.tasks["null-coords"] = {"status": "awaiting_db_match"}
        with patch("app.smart_geocode", return_value=(46.0364673, 10.7311417, True)) as geocode:
            app_module.continue_file_task("null-coords", schools, None, resolutions)

        task = app_module.tasks.pop("null-coords")
        assert task["status"] == "completed"
        by_name = {s["name"]: s for s in task["result"]}
        assert by_name["IS ENAIP TIONE"]["lat"] == pytest.approx(46.0364673, abs=1e-3)
        assert by_name["ITET Fontana"]["lat"] == pytest.approx(45.8937076)
        # Only the entry without coordinates goes through geocoding
        assert geocode.call_count == 1


# ---------------------------------------------------------------------------
# /api/places/autocomplete
# ---------------------------------------------------------------------------

class TestAutocompleteUnavailable:
    def test_nominatim_error_returns_unavailable_status(self, app_client):
        import requests
        with patch("nominatim_cache.get", return_value=None), \
             patch("requests.get", side_effect=requests.exceptions.ReadTimeout("timed out")):
            resp = app_client.get("/api/places/autocomplete?q=Via Durone Tione")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "UNAVAILABLE"
        assert body["predictions"] == []

    def test_nominatim_http_error_returns_unavailable_status(self, app_client):
        from unittest.mock import MagicMock
        fake = MagicMock(status_code=429)
        with patch("nominatim_cache.get", return_value=None), patch("requests.get", return_value=fake):
            resp = app_client.get("/api/places/autocomplete?q=Via Biasi")
        assert resp.get_json()["status"] == "UNAVAILABLE"


# ---------------------------------------------------------------------------
# /api/sheet/read
# ---------------------------------------------------------------------------

def _xlsx(df):
    import pandas as pd  # noqa: F401
    buf = io.BytesIO()
    df.to_excel(buf, index=False)
    buf.seek(0)
    return buf


class TestReadSheet:
    def test_returns_first_sheet_as_is(self, app_client):
        import pandas as pd
        df = pd.DataFrame({
            "Nome": ["IC Ala", "IC Cembra", None],
            "Indirizzo": ["Via Betta 10", "", None],
            "Partecipanti": [18, None, None],
        })
        data = {"file": (_xlsx(df), "viaggio.xlsx")}
        resp = app_client.post("/api/sheet/read", data=data, content_type="multipart/form-data")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["columns"] == ["Nome", "Indirizzo", "Partecipanti"]
        # Trailing empty rows are dropped, empty cells become "", whole numbers stay ints
        assert body["rows"] == [
            {"Nome": "IC Ala", "Indirizzo": "Via Betta 10", "Partecipanti": 18},
            {"Nome": "IC Cembra", "Indirizzo": "", "Partecipanti": ""},
        ]

    def test_keeps_empty_rows_inside_the_table(self, app_client):
        import pandas as pd
        df = pd.DataFrame({"Nome": ["IC Ala", None, "Totale"], "Partecipanti": [18, None, 18]})
        data = {"file": (_xlsx(df), "viaggio.xlsx")}
        body = app_client.post("/api/sheet/read", data=data, content_type="multipart/form-data").get_json()
        assert [r["Nome"] for r in body["rows"]] == ["IC Ala", "", "Totale"]

    def test_rejects_non_xlsx(self, app_client):
        data = {"file": (io.BytesIO(b"a,b"), "dati.csv")}
        resp = app_client.post("/api/sheet/read", data=data, content_type="multipart/form-data")
        assert resp.status_code == 400

    def test_missing_file_returns_400(self, app_client):
        assert app_client.post("/api/sheet/read").status_code == 400


class TestResolvedStops:
    def test_dataset_street_and_corrected_demand_are_used(self):
        """A stop resolved against the dataset shows the dataset street and the participants fixed in review."""
        import app as app_module
        task_id = "t-resolved"
        app_module.tasks[task_id] = {"status": "processing"}
        school = {"id": 0, "name": "IC Ala", "address": "Ala (TN) - Via Betta, 10", "display_address": "Ala (TN) - Via Betta, 10", "demand": 0}
        resolutions = {"0": {"lat": 45.7562, "lon": 11.0015, "address": "Via Betta, Ala", "name": "IC ALA",
                             "display_address": "Via Betta, Scuola primaria", "demand": 18}}
        app_module.continue_file_task(task_id, [school], None, resolutions)
        result = app_module.tasks[task_id]["result"][0]
        assert app_module.tasks[task_id]["status"] == "completed"
        assert result["display_address"] == "Via Betta, Scuola primaria"
        assert result["demand"] == 18
        assert (result["lat"], result["lon"]) == (45.7562, 11.0015)

    def test_start_processing_runs_without_uploaded_file(self, app_client):
        with patch("app.threading.Thread") as mock_thread:
            resp = app_client.post("/api/start-processing", json={
                "raw_schools": [{"id": 0, "name": "IC Ala", "address": "x", "demand": 3}],
                "resolutions": {"0": {"lat": 45.7, "lon": 11.0, "address": "x", "name": "IC ALA"}},
            })
        assert resp.status_code == 202
        # Same arguments continue_file_task accepts (it used to get one too many)
        args = mock_thread.call_args.kwargs["args"]
        assert len(args) == 4


class TestPlacesGoogle:
    @pytest.fixture(autouse=True)
    def _counter_allows(self, monkeypatch):
        import app as app_module
        app_module._PLACES_CACHE.clear()
        monkeypatch.setattr("places_usage.allow", lambda kind: True)

    def test_uses_google_when_key_is_set(self, app_client, monkeypatch):
        monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "test-key")
        payload = {"suggestions": [{"placePrediction": {
            "placeId": "abc", "text": {"text": "Villa Lagarina, TN, Italia"},
            "structuredFormat": {"mainText": {"text": "Villa Lagarina"}, "secondaryText": {"text": "TN, Italia"}},
            "types": ["locality"]}}]}
        with patch("requests.post") as post:
            post.return_value.status_code = 200
            post.return_value.json.return_value = payload
            body = app_client.get("/api/places/autocomplete?q=villa lag&session=s1").get_json()
        assert body["source"] == "google"
        assert body["predictions"][0]["place_id"] == "g_abc"
        sent = post.call_args.kwargs["json"]
        assert sent["sessionToken"] == "s1" and sent["includedRegionCodes"] == ["it"]
        # The key stays on the server
        assert post.call_args.kwargs["headers"]["X-Goog-Api-Key"] == "test-key"

    def test_falls_back_to_nominatim_when_google_fails(self, app_client, monkeypatch):
        monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "test-key")
        with patch("requests.post") as post, patch("requests.get") as get, patch("nominatim_cache.get", return_value=None), patch("nominatim_cache.store"):
            post.return_value.status_code = 429
            post.return_value.text = "quota"
            get.return_value.status_code = 200
            get.return_value.json.return_value = [{"display_name": "Villa Lagarina, Trento, Italia", "lat": "45.9", "lon": "11.0", "osm_id": 1}]
            body = app_client.get("/api/places/autocomplete?q=villa lag").get_json()
        assert body.get("source") != "google"
        assert body["predictions"][0]["lat"] == 45.9

    def test_details_returns_coordinates(self, app_client, monkeypatch):
        monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "test-key")
        with patch("requests.get") as get:
            get.return_value.status_code = 200
            get.return_value.json.return_value = {"location": {"latitude": 45.94, "longitude": 11.02}, "formattedAddress": "38060 Villa Lagarina TN", "displayName": {"text": "Villa Lagarina"}}
            body = app_client.get("/api/places/details?place_id=g_abc&session=s1").get_json()
        assert (body["lat"], body["lon"]) == (45.94, 11.02)
        assert get.call_args.kwargs["params"]["sessionToken"] == "s1"


class TestPlacesSafety:
    def test_monthly_cap_reached_uses_nominatim(self, app_client, monkeypatch):
        import app as app_module
        app_module._PLACES_CACHE.clear()
        monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "test-key")
        monkeypatch.setattr("places_usage.allow", lambda kind: False)
        with patch("requests.post") as post, patch("requests.get") as get, patch("nominatim_cache.get", return_value=None), patch("nominatim_cache.store"):
            get.return_value.status_code = 200
            get.return_value.json.return_value = []
            body = app_client.get("/api/places/autocomplete?q=villa lag").get_json()
        assert post.call_count == 0
        assert body.get("source") != "google"

    def test_repeated_query_is_served_from_cache(self, app_client, monkeypatch):
        import app as app_module
        app_module._PLACES_CACHE.clear()
        monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "test-key")
        monkeypatch.setattr("places_usage.allow", lambda kind: True)
        with patch("requests.post") as post:
            post.return_value.status_code = 200
            post.return_value.json.return_value = {"suggestions": []}
            app_client.get("/api/places/autocomplete?q=palazzetto")
            app_client.get("/api/places/autocomplete?q=Palazzetto")
        assert post.call_count == 1

    def test_counter_unreachable_means_no_google(self, monkeypatch):
        import places_usage
        monkeypatch.setenv("FIREBASE_PROJECT_ID", "p")
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:1")
        assert places_usage.allow("autocomplete") is False

    def test_counter_stops_at_the_monthly_cap(self, monkeypatch):
        import places_usage
        monkeypatch.setenv("FIREBASE_PROJECT_ID", "p")
        monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "emu:8080")
        monkeypatch.setitem(places_usage.LIMITS, "details", 2)
        with patch("places_usage.requests.get") as get, patch("places_usage.requests.post") as post:
            get.return_value.status_code = 200
            get.return_value.json.return_value = {"fields": {"details": {"integerValue": "2"}}}
            assert places_usage.allow("details") is False
            get.return_value.json.return_value = {"fields": {"details": {"integerValue": "1"}}}
            post.return_value.status_code = 200
            assert places_usage.allow("details") is True
            assert post.call_args.kwargs["json"]["writes"][0]["transform"]["fieldTransforms"][0]["increment"] == {"integerValue": "1"}

    def test_upload_geocoding_never_calls_google(self, monkeypatch):
        """Stops without coordinates are geocoded with Nominatim even when a Google key is set."""
        import app as app_module
        monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "test-key")
        app_module.tasks["no-google"] = {"status": "processing"}
        schools = [{"id": 0, "name": "IC Ala", "address": "Via Betta 10, Ala", "demand": 5}]
        with patch("app.smart_geocode", return_value=(45.75, 11.0, True)) as geocode, \
             patch("requests.post") as post, patch("requests.get") as get:
            app_module.continue_file_task("no-google", schools, None, {})
        assert geocode.call_count == 1
        for call in post.call_args_list + get.call_args_list:
            assert "googleapis.com" not in str(call)
        assert app_module.tasks.pop("no-google")["status"] == "completed"

class TestDownloadTraversal:
    def test_names_outside_uploads_are_refused_and_nothing_is_deleted(self, app_client, tmp_path):
        import app as app_module
        assert app_client.get("/api/download/../app.py").status_code == 404
        assert app_client.get("/api/download/..%2Fapp.py").status_code == 404
        assert os.path.exists(os.path.join(os.path.dirname(app_module.__file__), "app.py"))


class TestFixturePaths:
    def test_fixture_name_cannot_escape_realsuite(self, app_client):
        from app import _fixture_dir, REALSUITE_DIR
        assert _fixture_dir("..") is None
        assert _fixture_dir("../x") is None
        assert _fixture_dir(".hidden") is None
        assert _fixture_dir("Evento") == os.path.join(REALSUITE_DIR, "Evento")


class TestRateLimit:
    def test_over_limit_gets_429_with_message(self, app_client):
        for _ in range(120):
            assert app_client.get("/api/places/autocomplete?q=a").status_code == 200
        r = app_client.get("/api/places/autocomplete?q=a")
        assert r.status_code == 429
        assert "Troppe richieste" in r.get_json()["error"]
        assert int(r.headers["Retry-After"]) >= 1

    def test_counted_per_forwarded_ip(self, app_client):
        for _ in range(120):
            app_client.get("/api/places/autocomplete?q=a", headers={"X-Forwarded-For": "1.1.1.1, 10.0.0.1"})
        assert app_client.get("/api/places/autocomplete?q=a", headers={"X-Forwarded-For": "1.1.1.1"}).status_code == 429
        assert app_client.get("/api/places/autocomplete?q=a", headers={"X-Forwarded-For": "2.2.2.2"}).status_code == 200

    def test_limits_are_per_endpoint(self, app_client):
        for _ in range(121):
            app_client.get("/api/places/autocomplete?q=a")
        assert app_client.post("/api/optimize", json={}).status_code != 429
