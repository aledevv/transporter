"""Tests for compute_route_metrics in evaluate_realSuite."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from evaluate_realSuite import compute_route_metrics


class TestComputeRouteMetrics:
    def _make_solution(self, routes):
        """routes: list of lists of node indices (including depot at 0)."""
        result = {"routes": []}
        for vid, stop_nodes in enumerate(routes):
            stops = [{"node": n, "load": 0} for n in stop_nodes]
            result["routes"].append({
                "vehicle_id": vid,
                "stops": stops,
                "distance": 0,
                "load": 0,
            })
        return result

    def test_total_km_with_distance_matrix(self):
        # Route: depot(0) → school1(1) → depot(0)
        # distance_matrix[0][1] = 10000 m, distance_matrix[1][0] = 10000 m
        # Expected total_km = 20.0 km
        time_matrix = [[0, 120], [120, 0]]
        dist_matrix = [[0, 10000], [10000, 0]]
        schools = [{"name": "S1", "demand": 5}]
        sol = self._make_solution([[0, 1, 0]])
        result = compute_route_metrics(sol, schools, time_matrix, dist_matrix)
        assert result["total_km"] == 20.0

    def test_total_km_fallback_time(self):
        # No distance_matrix → falls back to time_matrix * 30 km/h
        # Route: depot→school1(120s)→depot(120s) → 240s * 30/3600 = 2.0 km
        time_matrix = [[0, 120], [120, 0]]
        schools = [{"name": "S1", "demand": 5}]
        sol = self._make_solution([[0, 1, 0]])
        result = compute_route_metrics(sol, schools, time_matrix, None)
        assert abs(result["total_km"] - 2.0) < 0.05

    def test_max_route_min(self):
        # Two routes: 600s and 1200s → max_route_min = 20.0 min
        time_matrix = [
            [0, 300, 600],
            [300, 0, 300],
            [600, 300, 0],
        ]
        schools = [{"name": "S1", "demand": 5}, {"name": "S2", "demand": 5}]
        # Route 1: 0→1→0 = 300+300 = 600s = 10 min
        # Route 2: 0→2→0 = 600+600 = 1200s = 20 min
        sol = self._make_solution([[0, 1, 0], [0, 2, 0]])
        result = compute_route_metrics(sol, schools, time_matrix, None)
        assert result["max_route_min"] == 20.0

    def test_empty_solution(self):
        result = compute_route_metrics({"routes": []}, [], [[0]], None)
        assert result["total_km"] == 0.0
        assert result["max_route_min"] == 0.0
