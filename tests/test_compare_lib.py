from pathlib import Path

ROOT = Path(__file__).parent.parent

from tools.compare_lib import load_groundtruth_full, format_planner_routes, derive_arrival_time

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


def _make_time_matrix():
    # 3x3: dest=0, A=1, B=2
    #   time_matrix[1][2] = 600  (A→B = 10 min)
    #   time_matrix[2][0] = 1200 (B→dest = 20 min)
    return [
        [0, 1200, 600],   # dest row
        [1200, 0, 600],   # A: A→dest=1200, A→B=600
        [1200, 600, 0],   # B: B→dest=1200, B→A=600
    ]

def test_format_planner_routes_departure_times():
    # arrival_time = "09:00" = 540 min
    # B dep = 540 - 1200//60 - 3 = 540 - 20 - 3 = 517 = "08:37"
    # A dep = 517 - 600//60 - 3 = 517 - 10 - 3 = 504 = "08:24"
    schools = [{"name": "School A", "demand": 10}, {"name": "School B", "demand": 15}]
    coords = {
        "School A": {"lat": 46.0, "lon": 11.0},
        "School B": {"lat": 46.1, "lon": 11.1},
    }
    solution = {
        "routes": [{
            "vehicle_id": 0,
            "stops": [
                {"node": 3, "load": 0},   # dummy (filtered out — node > n)
                {"node": 1, "load": 10},  # School A
                {"node": 2, "load": 25},  # School B
                {"node": 0, "load": 0},   # dest (filtered out — node == 0)
            ],
            "distance": 1800, "load": 25,
        }],
        "total_distance": 1800, "total_load": 25, "used_vehicles": 1,
    }
    result = format_planner_routes(solution, schools, _make_time_matrix(), coords, "09:00")
    assert len(result) == 1
    route = result[0]
    assert len(route["stops"]) == 2
    assert route["stops"][0]["name"] == "School A"
    assert route["stops"][0]["departure_time"] == "08:24"
    assert route["stops"][1]["name"] == "School B"
    assert route["stops"][1]["departure_time"] == "08:37"
    assert route["stops"][0]["lat"] == 46.0
    assert route["distance_km"] > 0

def test_format_planner_routes_skips_empty_routes():
    schools = [{"name": "School A", "demand": 10}]
    solution = {
        "routes": [
            {"vehicle_id": 0, "stops": [{"node": 0, "load": 0}], "distance": 0, "load": 0},
        ],
        "total_distance": 0, "total_load": 0, "used_vehicles": 0,
    }
    result = format_planner_routes(solution, schools, [[0, 0], [0, 0]], {}, "09:00")
    assert result == []

def test_derive_arrival_time_from_gt():
    # GT bus has last stop "School B" departing "08:37"
    # time_matrix[2][0] = 1200 (20 min to dest)
    # arrival = 08:37 + 20 = 08:57
    schools = [{"name": "School A", "demand": 10}, {"name": "School B", "demand": 15}]
    gt = {
        "7": {
            "stops": [
                {"name": "School A", "departure_time": "08:24", "return_time": "", "luogo_ritrovo": "", "count": 10},
                {"name": "School B", "departure_time": "08:37", "return_time": "", "luogo_ritrovo": "", "count": 15},
            ],
            "distance_km": 15.0,
        }
    }
    arrival = derive_arrival_time(gt, schools, _make_time_matrix())
    # median of one bus: 517 + 20 = 537 = "08:57"
    assert arrival == "08:57"

def test_derive_arrival_time_ignores_unparseable_times():
    # Bus 7: last valid stop is "School B" at "08:37" (School A has HH:MM:SS — ignored)
    # Bus 8: all stops have unparseable times — excluded entirely, no contribution
    # Only bus 7 contributes: 517 + 20 = 537 = "08:57"
    schools = [{"name": "School A", "demand": 10}, {"name": "School B", "demand": 15}]
    gt = {
        "7": {
            "stops": [
                {"name": "School A", "departure_time": "08:24:00", "return_time": "", "luogo_ritrovo": "", "count": 10},
                {"name": "School B", "departure_time": "08:37", "return_time": "", "luogo_ritrovo": "", "count": 15},
            ],
            "distance_km": 15.0,
        },
        "8": {
            "stops": [
                {"name": "School A", "departure_time": "nan", "return_time": "", "luogo_ritrovo": "", "count": 10},
            ],
            "distance_km": None,
        },
    }
    arrival = derive_arrival_time(gt, schools, _make_time_matrix())
    assert arrival == "08:57"

def test_derive_arrival_time_falls_back_when_no_valid_stops():
    schools = [{"name": "School A", "demand": 10}]
    gt = {
        "7": {
            "stops": [{"name": "School A", "departure_time": "invalid", "return_time": "", "luogo_ritrovo": "", "count": 10}],
            "distance_km": None,
        }
    }
    assert derive_arrival_time(gt, schools, [[0, 0], [0, 0]]) == "09:00"
