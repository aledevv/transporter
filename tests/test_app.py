"""Tests for Flask API routes."""
import io
import json
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# /api/upload
# ---------------------------------------------------------------------------

class TestUpload:
    def test_missing_file_field_returns_400(self, app_client):
        resp = app_client.post("/api/upload")
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_empty_filename_returns_400(self, app_client):
        data = {"file": (io.BytesIO(b""), "")}
        resp = app_client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert resp.status_code == 400

    def test_valid_upload_returns_task_id(self, app_client, sample_excel):
        """A valid Excel upload starts a background task and returns a task_id."""
        with open(sample_excel, "rb") as f:
            data = {"file": (f, "test.xlsx")}
            # Patch the background thread so it doesn't actually run geocoding.
            with patch("app.threading.Thread") as mock_thread:
                mock_thread.return_value.start = lambda: None
                resp = app_client.post("/api/upload", data=data, content_type="multipart/form-data")

        assert resp.status_code == 202
        body = resp.get_json()
        assert "task_id" in body


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
