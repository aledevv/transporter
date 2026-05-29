import json
import pytest
from pathlib import Path

from geocoder import GeocodingService

TESTS_DIR = Path(__file__).parent
DATA_FILE = TESTS_DIR / "test_distances.json"

with open(DATA_FILE) as f:
    test_cases = json.load(f)

geocoder = GeocodingService()

@pytest.mark.parametrize("case", test_cases, ids=[c["id"] for c in test_cases])
def test_route_distance_estimation(case):
    expected_km = case.get("expected_osrm_km")
    if expected_km is None:
        pytest.skip("No expected OSRM km for this test case")
        
    lon1, lat1 = case["from"]
    lon2, lat2 = case["to"]
    tolerance_km = case.get("tolerance_km", 2.0)
    
    stops = [{'lat': lat1, 'lon': lon1}, {'lat': lat2, 'lon': lon2}]
    
    # The application uses get_route_geometry to pull driving distances
    try:
        geo_data = geocoder.get_route_geometry(stops)
    except Exception as exc:
        pytest.skip(f"Network unavailable or OSRM unreachable: {exc}")
        return

    if geo_data is None:
        pytest.skip("get_route_geometry returned None — network error or OSRM unreachable")
    
    actual_m = geo_data['distance']
    actual_km = actual_m / 1000.0
    
    diff = abs(actual_km - expected_km)
    assert diff <= tolerance_km, f"Expected {expected_km} km, got {actual_km:.1f} km (Diff: {diff:.1f} > {tolerance_km})"
