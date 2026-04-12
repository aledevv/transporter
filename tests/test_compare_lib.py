from pathlib import Path

ROOT = Path(__file__).parent.parent

from tools.compare_lib import load_groundtruth_full

def test_load_groundtruth_full_returns_structured_buses():
    gt_files = list((ROOT / "tests/realSuite").glob("*/groundtruth.xlsx"))
    assert gt_files, "No groundtruth.xlsx found in realSuite"
    result = load_groundtruth_full(gt_files[0])
    assert isinstance(result, dict)
    assert len(result) > 0
    fin, bus = next(iter(result.items()))
    assert "stops" in bus
    assert "distance_km" in bus
    assert len(bus["stops"]) > 0
    stop = bus["stops"][0]
    assert "name" in stop
    assert "luogo_ritrovo" in stop
    assert "departure_time" in stop
    assert "return_time" in stop
    assert "count" in stop

def test_load_groundtruth_full_no_empty_bus_names():
    gt_files = list((ROOT / "tests/realSuite").glob("*/groundtruth.xlsx"))
    result = load_groundtruth_full(gt_files[0])
    for fin, bus in result.items():
        for stop in bus["stops"]:
            assert stop["name"], f"Bus {fin} has a stop with empty name"

def test_resolve_coords_exact_match():
    from tools.compare_lib import resolve_coords
    coords = {"IC ALA": {"lat": 45.756, "lon": 11.001}}
    assert resolve_coords("IC ALA", coords) == {"lat": 45.756, "lon": 11.001}

def test_resolve_coords_case_insensitive():
    from tools.compare_lib import resolve_coords
    coords = {"IC ALA": {"lat": 45.756, "lon": 11.001}}
    assert resolve_coords("ic ala ", coords) == {"lat": 45.756, "lon": 11.001}

def test_resolve_coords_missing_returns_none():
    from tools.compare_lib import resolve_coords
    assert resolve_coords("IC UNKNOWN", {"IC ALA": {"lat": 45.756, "lon": 11.001}}) is None

def test_enrich_gt_with_coords_adds_fields():
    from tools.compare_lib import enrich_gt_with_coords
    gt = {
        "7": {
            "stops": [{"name": "IC ALA", "luogo_ritrovo": "", "departure_time": "09:00", "return_time": "", "count": 10}],
            "distance_km": 50.0,
        }
    }
    coords = {"IC ALA": {"lat": 45.756, "lon": 11.001}}
    result = enrich_gt_with_coords(gt, coords)
    s = result["7"]["stops"][0]
    assert s["lat"] == 45.756
    assert s["lon"] == 11.001
    assert s["coords_missing"] is False
    original_stop = gt["7"]["stops"][0]
    assert "lat" not in original_stop  # original stop dict not mutated

def test_enrich_gt_with_coords_marks_missing():
    from tools.compare_lib import enrich_gt_with_coords
    gt = {
        "7": {
            "stops": [{"name": "IC UNKNOWN", "luogo_ritrovo": "", "departure_time": "", "return_time": "", "count": 5}],
            "distance_km": None,
        }
    }
    result = enrich_gt_with_coords(gt, {})
    assert result["7"]["stops"][0]["coords_missing"] is True
    assert result["7"]["stops"][0]["lat"] is None
    assert result["7"]["stops"][0]["lon"] is None

def test_match_buses_perfect_pair():
    from tools.compare_lib import match_buses
    p = {"bus0": {"A", "B", "C"}}
    g = {"fin1": {"A", "B", "C"}}
    pairs, up, ug = match_buses(p, g)
    assert len(pairs) == 1
    assert pairs[0]["jaccard"] == 1.0
    assert pairs[0]["p_id"] == "bus0"
    assert pairs[0]["gt_id"] == "fin1"
    assert up == [] and ug == []

def test_match_buses_unmatched_gt_when_more_gt_buses():
    from tools.compare_lib import match_buses
    p = {"bus0": {"A", "B"}}
    g = {"fin1": {"A", "B"}, "fin2": {"C", "D"}}
    pairs, up, ug = match_buses(p, g)
    assert len(pairs) == 1
    assert len(ug) == 1
    assert up == []

def test_match_buses_unmatched_planner_when_more_planner_buses():
    from tools.compare_lib import match_buses
    p = {"bus0": {"A", "B"}, "bus1": {"C", "D"}}
    g = {"fin1": {"A", "B"}}
    pairs, up, ug = match_buses(p, g)
    assert len(pairs) == 1
    assert len(up) == 1
    assert ug == []

def test_match_buses_ordered_by_descending_jaccard():
    from tools.compare_lib import match_buses
    p = {"bus0": {"A", "B"}, "bus1": {"C"}}
    g = {"fin1": {"A", "B"}, "fin2": {"C", "X", "Y"}}
    pairs, _, _ = match_buses(p, g)
    assert pairs[0]["jaccard"] == 1.0
    import pytest
    assert pairs[1]["jaccard"] == pytest.approx(1/3, rel=1e-3)

def test_match_buses_empty_inputs_return_empty_lists():
    from tools.compare_lib import match_buses
    pairs, up, ug = match_buses({}, {})
    assert pairs == [] and up == [] and ug == []

def test_match_buses_empty_planner_returns_all_gt_unmatched():
    from tools.compare_lib import match_buses
    g = {"fin1": {"A", "B"}, "fin2": {"C"}}
    pairs, up, ug = match_buses({}, g)
    assert pairs == [] and up == [] and len(ug) == 2
