"""
Pytest integration for realSuite ground-truth tests.

Parametrized: one test per event folder that has complete artifacts
(input.xlsx or input_corretto.xlsx, time_matrix.json, config.json, groundtruth.xlsx).

Pass thresholds (easy to update after seeing real baseline numbers):
  V1 combined score ≥ V1_THRESHOLD
  V2 combined score ≥ V2_THRESHOLD  (added in Task 12)
"""
from pathlib import Path

import pytest

from evaluate_realSuite import (
    REALSUITE_DIR,
    combined_score,
    load_event,
    load_groundtruth,
    run_v1,
    solution_to_buses,
)

# Tune these after seeing baseline numbers
V1_THRESHOLD = 0.40

# -----------------------------------------------------------------------
# Parametrize: collect all event dirs with complete artifacts
# -----------------------------------------------------------------------

def _ready_events():
    """Return list of event dir paths that have all required files."""
    dirs = []
    for d in sorted(REALSUITE_DIR.iterdir()):
        if not d.is_dir():
            continue
        needed = ["input.xlsx", "time_matrix.json", "config.json", "groundtruth.xlsx"]
        if all((d / f).exists() for f in needed):
            dirs.append(d)
    return dirs


@pytest.fixture(scope="module", params=_ready_events(), ids=lambda d: d.name)
def event(request):
    ev = load_event(request.param)
    if ev is None:
        pytest.skip("Missing artifacts")
    return ev


@pytest.fixture(scope="module")
def groundtruth(event):
    return load_groundtruth(event["gt_path"])


@pytest.fixture(scope="module")
def v1_solution(event):
    sol = run_v1(event)
    assert sol is not None, "V1 returned no solution"
    return sol


# -----------------------------------------------------------------------
# Tests
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

    def test_combined_score(self, v1_solution, event, groundtruth):
        pred = solution_to_buses(v1_solution, event["schools"])
        score = combined_score(pred, groundtruth)
        assert score >= V1_THRESHOLD, (
            f"{event['name']}: V1 score {score:.3f} < threshold {V1_THRESHOLD}"
        )


V2_THRESHOLD = 0.45  # tune after seeing baseline numbers

@pytest.fixture(scope="module")
def v2_solution(event):
    from evaluate_realSuite import run_v2
    sol = run_v2(event)
    assert sol is not None, "V2 returned no solution"
    return sol


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

    def test_combined_score(self, v2_solution, event, groundtruth):
        from evaluate_realSuite import combined_score, solution_to_buses
        pred = solution_to_buses(v2_solution, event["schools"])
        score = combined_score(pred, groundtruth)
        assert score >= V2_THRESHOLD, (
            f"{event['name']}: V2 score {score:.3f} < threshold {V2_THRESHOLD}"
        )
