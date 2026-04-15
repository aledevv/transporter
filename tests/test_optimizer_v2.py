"""Unit tests for HumanStyleSolver — Steps 1 and 2."""
import pytest
from optimizer_v2 import HumanStyleSolver, _cluster_schools, _split_cluster, _merge_clusters


# -----------------------------------------------------------------------
# Minimal time matrix helpers
# -----------------------------------------------------------------------

def _make_matrix(distances):
    """Build symmetric NxN matrix from upper-triangle distances dict {(i,j): d}."""
    n = max(max(i, j) for i, j in distances) + 1
    m = [[0] * n for _ in range(n)]
    for (i, j), d in distances.items():
        m[i][j] = d
        m[j][i] = d
    return m


def _full_matrix(n_schools):
    """
    Build a (n_schools+2)×(n_schools+2) time matrix.
    Indices: 0=dest, 1..n=schools, n+1=dummy.
    All distances = 3600 (1 hour) except as specified.
    """
    total = n_schools + 2
    m = [[3600] * total for _ in range(total)]
    for i in range(total):
        m[i][i] = 0
    return m


# -----------------------------------------------------------------------
# _cluster_schools tests
# -----------------------------------------------------------------------

def test_cluster_nearby_schools_together():
    """Schools within threshold should be in the same cluster."""
    # 4 schools: 1+2 are 5 min apart, 3+4 are 5 min apart, cross-group is 60 min
    n = 4  # schools only, 0-indexed for school matrix
    m = [[3600] * n for _ in range(n)]
    for i in range(n):
        m[i][i] = 0
    m[0][1] = m[1][0] = 300   # 5 min
    m[2][3] = m[3][2] = 300   # 5 min

    labels = _cluster_schools(m, threshold_seconds=600)
    assert labels[0] == labels[1], "Schools 0,1 should be clustered together"
    assert labels[2] == labels[3], "Schools 2,3 should be clustered together"
    assert labels[0] != labels[2], "Group 0-1 and group 2-3 should be separate"


def test_cluster_all_close_same_cluster():
    """All schools within threshold → single cluster."""
    m = [[300 if i != j else 0 for j in range(3)] for i in range(3)]
    labels = _cluster_schools(m, threshold_seconds=600)
    assert len(set(labels)) == 1


def test_cluster_all_far_separate_clusters():
    """All schools far apart → each in its own cluster."""
    m = [[7200 if i != j else 0 for j in range(3)] for i in range(3)]
    labels = _cluster_schools(m, threshold_seconds=600)
    assert len(set(labels)) == 3


def test_cluster_single_school():
    """Single school → label [0]."""
    labels = _cluster_schools([[0]], threshold_seconds=600)
    assert labels == [0]


# -----------------------------------------------------------------------
# _split_cluster tests
# -----------------------------------------------------------------------

def test_split_oversized_cluster():
    """A cluster with total demand > capacity must be split."""
    # 3 schools, demands [30, 30, 30], capacity 50
    # school indices 0,1,2 (school-space, not node-space)
    school_matrix = [[0, 300, 600], [300, 0, 300], [600, 300, 0]]
    demands = [30, 30, 30]  # school-space demands
    clusters = _split_cluster([0, 1, 2], demands, school_matrix, capacity=50)
    for c in clusters:
        assert sum(demands[i] for i in c) <= 50


def test_split_already_fits():
    """Cluster within capacity is returned as-is."""
    demands = [10, 20]
    school_matrix = [[0, 300], [300, 0]]
    clusters = _split_cluster([0, 1], demands, school_matrix, capacity=50)
    assert len(clusters) == 1
    assert set(clusters[0]) == {0, 1}


# -----------------------------------------------------------------------
# _merge_clusters tests
# -----------------------------------------------------------------------

def test_merge_small_clusters():
    """Two clusters that fit together should be merged."""
    demands = [10, 10, 10, 10]
    school_matrix = [
        [0, 300, 7200, 7200],
        [300, 0, 7200, 7200],
        [7200, 7200, 0, 300],
        [7200, 7200, 300, 0],
    ]
    clusters = [[0, 1], [2], [3]]  # [2] and [3] are close and small
    merged = _merge_clusters(clusters, demands, school_matrix, capacity=50)
    # [2] and [3] should be merged since 10+10=20 <= 50.
    # With capacity=50 and total demand=40, all 4 schools may end up in one cluster —
    # what matters is that the number of clusters decreased (merging occurred).
    assert len(merged) < 3, "At least one merge should have occurred"
    # Verify schools 2 and 3 are in the same cluster
    cluster_of_2 = next(c for c in merged if 2 in c)
    assert 3 in cluster_of_2, "Schools 2 and 3 should be in the same cluster"


def test_merge_respects_capacity():
    """Clusters whose combined demand exceeds capacity must not be merged."""
    demands = [30, 30, 30, 30]
    school_matrix = [[0 if i == j else 100 for j in range(4)] for i in range(4)]
    clusters = [[0, 1], [2, 3]]  # each has demand 60, capacity 50 → cannot merge
    merged = _merge_clusters(clusters, demands, school_matrix, capacity=50)
    assert len(merged) == 2  # no merge happened


# -----------------------------------------------------------------------
# HumanStyleSolver.solve() integration tests
# -----------------------------------------------------------------------

def _make_full_matrix_close_pair():
    """
    4 schools (nodes 1-4), schools 1+2 close, schools 3+4 close.
    Node layout: 0=dest, 1-4=schools, 5=dummy.
    """
    n_total = 6
    m = [[3600] * n_total for _ in range(n_total)]
    for i in range(n_total):
        m[i][i] = 0
    # Schools 1 and 2 close (5 min)
    m[1][2] = m[2][1] = 300
    # Schools 3 and 4 close (5 min)
    m[3][4] = m[4][3] = 300
    return m


def test_solve_returns_correct_structure():
    m = _make_full_matrix_close_pair()
    demands = [0, 20, 20, 20, 20, 0]
    solver = HumanStyleSolver(m, demands, vehicle_capacity=50, cluster_threshold_minutes=15)
    sol = solver.solve()
    assert sol is not None
    assert "routes" in sol
    assert "used_vehicles" in sol
    assert "total_load" in sol


def test_solve_assigns_all_schools():
    m = _make_full_matrix_close_pair()
    demands = [0, 20, 20, 20, 20, 0]
    solver = HumanStyleSolver(m, demands, vehicle_capacity=50, cluster_threshold_minutes=15)
    sol = solver.solve()
    assigned = {stop["node"] for route in sol["routes"] for stop in route["stops"]}
    for node in range(1, 5):
        assert node in assigned, f"School node {node} not assigned"


def test_solve_respects_capacity():
    m = _make_full_matrix_close_pair()
    demands = [0, 20, 20, 20, 20, 0]
    solver = HumanStyleSolver(m, demands, vehicle_capacity=50, cluster_threshold_minutes=15)
    sol = solver.solve()
    for route in sol["routes"]:
        assert route["load"] <= 50


def test_solve_groups_nearby_schools():
    """Schools 1+2 close, schools 3+4 close — should be on separate buses."""
    m = _make_full_matrix_close_pair()
    demands = [0, 20, 20, 20, 20, 0]
    solver = HumanStyleSolver(m, demands, vehicle_capacity=50, cluster_threshold_minutes=15)
    sol = solver.solve()

    def bus_of(node):
        for route in sol["routes"]:
            if any(s["node"] == node for s in route["stops"]):
                return route["vehicle_id"]
        return None

    assert bus_of(1) == bus_of(2), "Schools 1 and 2 (close) should be on the same bus"
    assert bus_of(3) == bus_of(4), "Schools 3 and 4 (close) should be on the same bus"


# -----------------------------------------------------------------------
# _estimate_route_time
# -----------------------------------------------------------------------

from optimizer_v2 import _estimate_route_time

class TestEstimateRouteTime:
    def test_single_school(self):
        # 1 school: depot→school + school→depot (depot_row approximation)
        school_matrix = [[0]]
        depot_row = [100]  # depot→school0 = 100 s
        # route: depot(100)→school0(100)→depot = 200 s
        result = _estimate_route_time([0], school_matrix, depot_row)
        assert result == 200

    def test_two_schools_ordered(self):
        # school_matrix[0][1] = 30, school_matrix[1][0] = 30
        # depot_row = [100, 50]  → farthest from depot is school 0
        # NN order: start at 0 (farthest), then 1
        # time = depot_row[0] + school_matrix[0][1] + depot_row[1]
        #      = 100 + 30 + 50 = 180
        school_matrix = [[0, 30], [30, 0]]
        depot_row = [100, 50]
        result = _estimate_route_time([0, 1], school_matrix, depot_row)
        assert result == 180

    def test_empty_cluster(self):
        result = _estimate_route_time([], [[0, 10], [10, 0]], [5, 5])
        assert result == 0


# -----------------------------------------------------------------------
# _two_opt
# -----------------------------------------------------------------------

from optimizer_v2 import _two_opt

class TestTwoOpt:
    def test_already_optimal(self):
        # Linear schools 0→1→2 with unit spacing — already optimal
        school_matrix = [
            [0, 10, 20],
            [10, 0, 10],
            [20, 10, 0],
        ]
        route = [0, 1, 2]
        result = _two_opt(route, school_matrix)
        # Total cost: 10+10=20; reversed 0→2→1 costs 20+10=30 — worse
        assert result == [0, 1, 2]

    def test_reversal_improves(self):
        # route [0, 2, 1] can be improved by reversing segment [2,1] → [1,2]
        # i.e. route [0, 1, 2] has cost 10+10=20 < [0, 2, 1] cost 20+10=30
        school_matrix = [
            [0, 10, 20],
            [10, 0, 10],
            [20, 10, 0],
        ]
        route = [0, 2, 1]
        result = _two_opt(route, school_matrix)
        assert result == [0, 1, 2]

    def test_single_school(self):
        result = _two_opt([0], [[0]])
        assert result == [0]

    def test_two_schools(self):
        # 2 schools — nothing to reverse (minimum 3 to benefit from 2-opt)
        school_matrix = [[0, 5], [5, 0]]
        result = _two_opt([0, 1], school_matrix)
        assert result == [0, 1]

    def test_does_not_mutate_input(self):
        school_matrix = [[0, 10, 20], [10, 0, 10], [20, 10, 0]]
        route = [0, 2, 1]
        original = list(route)
        _two_opt(route, school_matrix)
        assert route == original


# -----------------------------------------------------------------------
# _merge_clusters — detour cap
# -----------------------------------------------------------------------

from optimizer_v2 import _merge_clusters

class TestMergeClustersDetourCap:
    def setup_method(self):
        # 4 schools in a line: 0-1-2-3
        # school_matrix[i][j] = |i-j| * 60 (seconds)
        n = 4
        self.school_matrix = [[abs(i - j) * 60 for j in range(n)] for i in range(n)]
        self.demands = [10, 10, 10, 10]
        self.capacity = 40  # all 4 fit
        # depot at same position as school 0: depot_row = [0, 60, 120, 180]
        self.depot_row = [i * 60 for i in range(n)]

    def test_merges_without_detour_cap(self):
        # No detour cap → merges everything into 1 bus
        clusters = [[0], [1], [2], [3]]
        result = _merge_clusters(
            clusters, self.demands, self.school_matrix, self.capacity,
            max_merge_seconds=float("inf"),
            max_detour_seconds=float("inf"),
            depot_row=self.depot_row,
        )
        assert len(result) == 1
        assert sorted(result[0]) == [0, 1, 2, 3]

    def test_no_depot_row_skips_detour_check(self):
        # When depot_row is None and max_detour_seconds is finite, the detour
        # check is skipped and only max_merge_seconds applies.
        clusters = [[0], [1], [2], [3]]
        result = _merge_clusters(
            clusters, self.demands, self.school_matrix, self.capacity,
            max_merge_seconds=float("inf"),
            max_detour_seconds=1,  # very tight — but no depot_row
            depot_row=None,
        )
        # No detour check without depot_row → all merge
        assert len(result) == 1

    def test_backward_compat_no_new_params(self):
        # Old callers that pass only the original 5 params still work.
        clusters = [[0], [1], [2], [3]]
        result = _merge_clusters(
            clusters, self.demands, self.school_matrix, self.capacity,
        )
        assert len(result) == 1
