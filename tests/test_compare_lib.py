import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

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
