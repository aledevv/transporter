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
