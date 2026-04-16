"""
Pytest integration for realSuite ground-truth tests.

Parametrized: one test per event folder that has complete artifacts
(input.xlsx or input_corretto.xlsx, time_matrix.json, config.json, groundtruth.xlsx).

Only structural correctness is enforced: all schools assigned, capacity respected.
Score/calibration metrics are computed separately via: python tests/evaluate_realSuite.py

Fast mode (CI / deploy):
    REALSUITE_FAST=1 pytest tests/test_realSuite.py
    Runs only the first REALSUITE_FAST_N (default 3) valid events alphabetically.
    The deploy script sets this automatically; full suite runs during development.
"""
import os
import pytest

from evaluate_realSuite import (
    REALSUITE_DIR,
    load_event,
    run_v1,
    run_v2,
)

_FAST_N = int(os.environ.get('REALSUITE_FAST_N', '3'))


# -----------------------------------------------------------------------
# Parametrize: collect all event dirs with complete artifacts
# -----------------------------------------------------------------------

def _ready_events():
    """Return list of event dir paths that have all required files.

    In fast mode (REALSUITE_FAST=1) only the first _FAST_N valid events
    (alphabetically) are returned, giving a quick smoke-test for CI/deploy.
    """
    dirs = []
    for d in sorted(REALSUITE_DIR.iterdir()):
        if not d.is_dir():
            continue
        needed = ["input.xlsx", "time_matrix.json", "config.json", "groundtruth.xlsx"]
        if all((d / f).exists() for f in needed):
            dirs.append(d)

    if os.environ.get('REALSUITE_FAST'):
        dirs = dirs[:_FAST_N]

    return dirs


@pytest.fixture(scope="module", params=_ready_events(), ids=lambda d: d.name)
def event(request):
    ev = load_event(request.param)
    if ev is None:
        pytest.skip("Missing artifacts")
    return ev


@pytest.fixture(scope="module")
def v1_solution(event):
    sol = run_v1(event)
    assert sol is not None, "V1 returned no solution"
    return sol


@pytest.fixture(scope="module")
def v2_solution(event):
    sol = run_v2(event)
    assert sol is not None, "V2 returned no solution"
    return sol


# -----------------------------------------------------------------------
# Tests — structural correctness only
# -----------------------------------------------------------------------

class TestV1:
    def test_all_schools_assigned(self, v1_solution, event):
        assigned = {
            stop["node"]
            for route in v1_solution["routes"]
            for stop in route["stops"]
        }
        for i in range(1, len(event["schools"]) + 1):
            assert i in assigned, f"School node {i} not assigned"

    def test_capacity_respected(self, v1_solution, event):
        cap = event["capacity"]
        for route in v1_solution["routes"]:
            assert route["load"] <= cap, (
                f"Bus {route['vehicle_id']} load={route['load']} exceeds capacity {cap}"
            )


class TestV2:
    def test_all_schools_assigned(self, v2_solution, event):
        assigned = {
            stop["node"]
            for route in v2_solution["routes"]
            for stop in route["stops"]
        }
        for i in range(1, len(event["schools"]) + 1):
            assert i in assigned, f"School node {i} not assigned in V2"

    def test_capacity_respected(self, v2_solution, event):
        cap = event["capacity"]
        for route in v2_solution["routes"]:
            assert route["load"] <= cap, (
                f"V2 Bus {route['vehicle_id']} load={route['load']} > capacity {cap}"
            )
