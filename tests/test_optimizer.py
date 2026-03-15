"""Tests for VRPSolver."""
import pytest

from optimizer import VRPSolver


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_solver(matrix, demands, capacity, num_vehicles, fixed_cost=0):
    return VRPSolver(
        time_matrix=matrix,
        demands=demands,
        vehicle_capacity=capacity,
        num_vehicles=num_vehicles,
        depot_index=0,
        fixed_vehicle_cost=fixed_cost,
    )


# ---------------------------------------------------------------------------
# Basic routing
# ---------------------------------------------------------------------------

class TestBasicRouting:
    def test_single_vehicle_visits_all_stops(self):
        # 3 nodes: 0=depot, 1=A, 2=B
        matrix = [[0, 10, 20], [10, 0, 5], [20, 5, 0]]
        solver = make_solver(matrix, demands=[0, 10, 10], capacity=30, num_vehicles=1)
        sol = solver.solve()

        assert sol is not None
        assert len(sol["routes"]) == 1
        assert sol["total_load"] == 20
        # Optimal route is 0→1→2→0 or 0→2→1→0, both cost 35
        assert sol["total_distance"] == 35

    def test_capacity_forces_two_vehicles(self):
        # Each stop demands 20, capacity is 30 → needs 2 buses
        matrix = [[0, 10, 10], [10, 0, 10], [10, 10, 0]]
        solver = make_solver(matrix, demands=[0, 20, 20], capacity=30, num_vehicles=2)
        sol = solver.solve()

        assert sol is not None
        assert len(sol["routes"]) == 2

    def test_no_solution_when_demand_exceeds_total_capacity(self):
        # 1 vehicle, capacity 10, total demand 30 → infeasible
        matrix = [[0, 1, 1, 1], [1, 0, 1, 1], [1, 1, 0, 1], [1, 1, 1, 0]]
        solver = make_solver(matrix, demands=[0, 10, 10, 10], capacity=10, num_vehicles=1)
        sol = solver.solve()

        assert sol is None

    def test_solution_contains_all_stops(self):
        matrix = [[0, 5, 10, 15], [5, 0, 5, 10], [10, 5, 0, 5], [15, 10, 5, 0]]
        demands = [0, 5, 5, 5]
        solver = make_solver(matrix, demands=demands, capacity=20, num_vehicles=1)
        sol = solver.solve()

        assert sol is not None
        visited = {s["node"] for r in sol["routes"] for s in r["stops"]}
        # All non-depot nodes (1, 2, 3) must be visited
        assert {1, 2, 3}.issubset(visited)


# ---------------------------------------------------------------------------
# Fixed-cost behaviour (replaces multi-strategy tests)
# ---------------------------------------------------------------------------

class TestStrategies:
    """
    Topology: depot (0) is close to A (1) and B (2), but A and B are far apart.
    - Low fixed_cost: SAVINGS won't merge A+B (negative savings) → 2 buses
    - High fixed_cost: penalty for extra bus outweighs detour → 1 bus
    """

    MATRIX = [
        [0,  10, 10],
        [10,  0, 80],
        [10, 80,  0],
    ]
    DEMANDS = [0, 25, 25]
    CAPACITY = 50

    def test_low_fixed_cost_uses_two_buses(self):
        # Savings(A,B) = 10+10-80 = -60 (negative) → SAVINGS won't merge → 2 buses
        solver = make_solver(
            self.MATRIX, self.DEMANDS, self.CAPACITY,
            num_vehicles=5, fixed_cost=0,
        )
        sol = solver.solve()
        assert sol["used_vehicles"] == 2

    def test_high_fixed_cost_uses_one_bus(self):
        # High fixed cost makes 1 bus cheaper despite detour
        solver = make_solver(
            self.MATRIX, self.DEMANDS, self.CAPACITY,
            num_vehicles=5, fixed_cost=1_000_000,
        )
        sol = solver.solve()
        assert sol["used_vehicles"] == 1

    def test_fixed_cost_controls_vehicle_count(self):
        sol_low = make_solver(
            self.MATRIX, self.DEMANDS, self.CAPACITY,
            num_vehicles=5, fixed_cost=0,
        ).solve()
        sol_high = make_solver(
            self.MATRIX, self.DEMANDS, self.CAPACITY,
            num_vehicles=5, fixed_cost=1_000_000,
        ).solve()
        assert sol_low["used_vehicles"] != sol_high["used_vehicles"]


# ---------------------------------------------------------------------------
# Solution structure
# ---------------------------------------------------------------------------

class TestSolutionStructure:
    def test_route_load_does_not_exceed_capacity(self):
        matrix = [[0, 5, 5, 5], [5, 0, 5, 5], [5, 5, 0, 5], [5, 5, 5, 0]]
        demands = [0, 15, 15, 15]
        solver = make_solver(matrix, demands, capacity=20, num_vehicles=3)
        sol = solver.solve()

        assert sol is not None
        for route in sol["routes"]:
            assert route["load"] <= 20

    def test_total_load_equals_sum_of_demands(self):
        matrix = [[0, 10, 10], [10, 0, 10], [10, 10, 0]]
        demands = [0, 12, 18]
        solver = make_solver(matrix, demands, capacity=50, num_vehicles=1)
        sol = solver.solve()

        assert sol["total_load"] == 30

    def test_used_vehicles_matches_routes_length(self):
        matrix = [[0, 10, 10], [10, 0, 10], [10, 10, 0]]
        solver = make_solver(matrix, demands=[0, 20, 20], capacity=30, num_vehicles=2)
        sol = solver.solve()

        assert sol["used_vehicles"] == len(sol["routes"])
