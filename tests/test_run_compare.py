"""Tests for the updated run_compare.process_event() multi-solver output."""
from __future__ import annotations

import json
from pathlib import Path
import pytest

TESTS_DIR = Path(__file__).parent
REALSUITE_DIR = TESTS_DIR / "realSuite"
import sys
sys.path.insert(0, str(TESTS_DIR.parent))

# Pick the first complete event fixture for testing
def _first_complete_ev_dir() -> Path | None:
    for ev_dir in sorted(REALSUITE_DIR.iterdir()):
        if not ev_dir.is_dir():
            continue
        needed = ["config.json", "time_matrix.json"]
        if any(Path(ev_dir, f).exists() for f in needed):
            gt_files = list(ev_dir.glob("*.xlsx"))
            if gt_files:
                return ev_dir
    return None


EV_DIR = _first_complete_ev_dir()


@pytest.mark.skipif(EV_DIR is None, reason="No complete realSuite fixture found")
def test_process_event_returns_planners_dict():
    """process_event() must return a 'planners' key with v1, v2 entries."""
    from tools.run_compare import process_event
    result = process_event(EV_DIR)
    assert result is not None, "process_event() returned None for complete fixture"
    assert "planners" in result, "Missing 'planners' key in result"
    assert "v2" in result["planners"], "Missing 'v2' in planners"
    assert "v1" in result["planners"], "Missing 'v1' in planners"


@pytest.mark.skipif(EV_DIR is None, reason="No complete realSuite fixture found")
def test_process_event_planner_has_required_fields():
    """Each planner entry must have matched_pairs, unmatched_planner, unmatched_gt, scores."""
    from tools.run_compare import process_event
    result = process_event(EV_DIR)
    assert result is not None
    for key in ("v1", "v2"):
        if key not in result["planners"]:
            continue
        p = result["planners"][key]
        assert "matched_pairs" in p, f"{key} missing matched_pairs"
        assert "unmatched_planner" in p, f"{key} missing unmatched_planner"
        assert "unmatched_gt" in p, f"{key} missing unmatched_gt"
        assert "scores" in p, f"{key} missing scores"
        s = p["scores"]
        assert "assignment" in s and "bus_count" in s and "combined" in s


@pytest.mark.skipif(EV_DIR is None, reason="No complete realSuite fixture found")
def test_process_event_root_has_no_legacy_scores():
    """Root-level 'scores', 'matched_pairs', 'unmatched_planner' must not exist anymore."""
    from tools.run_compare import process_event
    result = process_event(EV_DIR)
    assert result is not None
    assert "scores" not in result, "Legacy 'scores' still at root — move it under planners"
    assert "matched_pairs" not in result, "Legacy 'matched_pairs' still at root"
    assert "unmatched_planner" not in result, "Legacy 'unmatched_planner' still at root"


@pytest.mark.skipif(EV_DIR is None, reason="No complete realSuite fixture found")
def test_process_event_shared_fields_present():
    """event, arrival_time, destination must stay at root level."""
    from tools.run_compare import process_event
    result = process_event(EV_DIR)
    assert result is not None
    assert "event" in result
    assert "arrival_time" in result
    assert "destination" in result
