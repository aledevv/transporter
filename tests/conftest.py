"""
Shared pytest configuration and fixtures.

Stubs out heavy third-party packages (datapizza, gemini_agent) so tests
run without real API keys or the datapizza SDK installed.
The stubs must be inserted into sys.modules BEFORE any project module is
imported, which is why this file lives here (pytest loads conftest.py first).
"""
import os
import sys
from unittest.mock import MagicMock

# Make the project root importable when running `pytest` from any directory.
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Stub packages that have side-effects at import time or require API keys.
for _mod in [
    "dotenv",
    "datapizza",
    "datapizza.clients",
    "datapizza.clients.google",
    "datapizza.agents",
    "datapizza.tools",
    "datapizza.tools.duckduckgo",
    "gemini_agent",
]:
    sys.modules.setdefault(_mod, MagicMock())

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------
import json

import pandas as pd
import pytest


SAMPLE_SCHOOLS = [
    {"id": 0, "name": "Scuola Primaria Roma", "address": "Via Roma, 1 - 38100 Trento", "demand": 10, "institute": "IC Trento 1"},
    {"id": 1, "name": "Scuola Media Dante",   "address": "P.za Dante 3 Rovereto",      "demand": 5,  "institute": "IC Rovereto"},
]

MOCK_AGENT_RESPONSE = json.dumps([
    {"name": "Scuola Primaria Roma", "normalized_address": "Via Roma, 1, 38100 Trento, Trentino, Italia"},
    {"name": "Scuola Media Dante",   "normalized_address": "Piazza Dante, 3, Rovereto, Trentino, Italia"},
])


@pytest.fixture
def sample_schools():
    return [s.copy() for s in SAMPLE_SCHOOLS]


@pytest.fixture
def sample_excel(tmp_path):
    """Minimal valid Excel file matching the DataLoader schema."""
    path = tmp_path / "test.xlsx"
    df = pd.DataFrame([
        {"Nome": s["name"], "Indirizzo": s["address"], "Partecipanti": s["demand"], "Istituto": s["institute"]}
        for s in SAMPLE_SCHOOLS
    ])
    df.to_excel(path, index=False)
    return path


@pytest.fixture(autouse=True)
def clear_nominatim_cache():
    """Reset in-memory Nominatim cache before each test to prevent cross-test pollution."""
    import nominatim_cache
    nominatim_cache.clear()


@pytest.fixture
def app_client():
    """Flask test client with testing mode enabled."""
    # Import here so that the sys.modules stubs above are already in place.
    from app import app  # noqa: PLC0415
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


# ---------------------------------------------------------------------------
# Pytest hooks
# ---------------------------------------------------------------------------
import warnings as _warnings
from pathlib import Path as _Path


def pytest_configure(config):
    """Warn if any realSuite event folder is missing input_corretto.xlsx."""
    realsuite = _Path(__file__).parent / "realSuite"
    if not realsuite.exists():
        return
    uncorrected = [
        d.name for d in sorted(realsuite.iterdir())
        if d.is_dir()
        and (d / "input.xlsx").exists()
        and not (d / "input_corretto.xlsx").exists()
    ]
    if uncorrected:
        _warnings.warn(
            f"\n[realSuite] {len(uncorrected)} event(s) missing AI address correction.\n"
            f"Run: python tests/prepare_realSuite.py --correct\n"
            f"Events: {', '.join(uncorrected)}",
            UserWarning,
            stacklevel=1,
        )
