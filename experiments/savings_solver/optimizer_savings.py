"""
SavingsSolver — Clarke-Wright savings-based bus planner (experiment).

Replaces V2's proximity-cluster + greedy-merge with a single savings-based
grouping pass:

  savings(i, j) = time(depot→i) + time(depot→j) − time(i→j)

High savings → schools are on the same road corridor toward the destination.
Greedy Union-Find merge in savings order, respecting capacity.

Interface mirrors HumanStyleSolver / VRPSolver — drop-in replacement.
To remove: delete experiments/savings_solver/ entirely.
"""
from __future__ import annotations

import warnings
from typing import Optional


# -----------------------------------------------------------------------
# Savings helpers
# -----------------------------------------------------------------------

def _compute_savings(depot_times: list, school_matrix: list) -> list:
    """
    Returns a list of (savings, i, j) tuples sorted descending.

    depot_times:   list[int] length N — time(depot → school_i) in school-space
    school_matrix: NxN int — travel times between schools in school-space
    """
    n = len(depot_times)
    result = []
    for i in range(n):
        for j in range(i + 1, n):
            s = depot_times[i] + depot_times[j] - school_matrix[i][j]
            result.append((s, i, j))
    result.sort(reverse=True)
    return result


def _savings_cluster(
    savings_list: list,
    school_demands: list,
    capacity: int,
    min_savings: int,
) -> list:
    """
    Greedy Union-Find merge in savings order.

    savings_list:   sorted [(savings, i, j), ...] descending
    school_demands: list[int] length N
    capacity:       int
    min_savings:    int — pairs with savings <= this are skipped

    Returns list of clusters, each a list of school-space indices.
    """
    n = len(school_demands)
    parent = list(range(n))
    cluster_demand = list(school_demands)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for s, i, j in savings_list:
        if s <= min_savings:
            break
        ri, rj = find(i), find(j)
        if ri == rj:
            continue
        if cluster_demand[ri] + cluster_demand[rj] <= capacity:
            if cluster_demand[ri] >= cluster_demand[rj]:
                parent[rj] = ri
                cluster_demand[ri] += cluster_demand[rj]
            else:
                parent[ri] = rj
                cluster_demand[rj] += cluster_demand[ri]

    cluster_map: dict = {}
    for idx in range(n):
        root = find(idx)
        cluster_map.setdefault(root, []).append(idx)
    return list(cluster_map.values())


# -----------------------------------------------------------------------
# Copied from optimizer_v2.py — no import dependency to allow clean removal
# -----------------------------------------------------------------------

def _split_cluster(
    school_indices: list,
    demands: list,
    school_matrix: list,
    capacity: int,
) -> list:
    if sum(demands[i] for i in school_indices) <= capacity:
        return [list(school_indices)]

    if len(school_indices) == 1:
        warnings.warn(
            f"School at index {school_indices[0]} has demand {demands[school_indices[0]]} "
            f"exceeding capacity {capacity} — cannot split further."
        )
        return [list(school_indices)]

    def dist_to_centroid(idx):
        others = [j for j in school_indices if j != idx]
        return sum(school_matrix[idx][j] for j in others) / len(others)

    farthest = max(school_indices, key=dist_to_centroid)
    remaining = [i for i in school_indices if i != farthest]

    return (
        _split_cluster(remaining, demands, school_matrix, capacity)
        + _split_cluster([farthest], demands, school_matrix, capacity)
    )


def _order_route(school_indices: list, school_matrix: list, depot_row: list) -> list:
    if not school_indices:
        return []
    if len(school_indices) == 1:
        return list(school_indices)

    start = max(school_indices, key=lambda i: depot_row[i])
    visited = [start]
    remaining = [i for i in school_indices if i != start]

    while remaining:
        last = visited[-1]
        nearest = min(remaining, key=lambda i: school_matrix[last][i])
        visited.append(nearest)
        remaining.remove(nearest)

    return visited


def _apply_institute_constraints(clusters: list, school_institutes: list) -> list:
    inst_to_schools: dict = {}
    for idx, inst in enumerate(school_institutes):
        if inst and inst != "UNIVERSAL":
            inst_to_schools.setdefault(inst, set()).add(idx)

    if not inst_to_schools:
        return clusters

    parent = list(range(len(clusters)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        px, py = find(x), find(y)
        if px != py:
            parent[px] = py

    school_to_cluster = {}
    for ci, cluster in enumerate(clusters):
        for s_idx in cluster:
            school_to_cluster[s_idx] = ci

    for inst, school_set in inst_to_schools.items():
        school_list = sorted(school_set)
        for i in range(1, len(school_list)):
            ca = school_to_cluster.get(school_list[0])
            cb = school_to_cluster.get(school_list[i])
            if ca is not None and cb is not None:
                union(ca, cb)

    merged: dict = {}
    for ci, cluster in enumerate(clusters):
        root = find(ci)
        merged.setdefault(root, []).extend(cluster)

    return list(merged.values())


# -----------------------------------------------------------------------
# SavingsSolver
# -----------------------------------------------------------------------

class SavingsSolver:
    """
    Clarke-Wright savings-based bus planner (experiment).

    Same interface as VRPSolver and HumanStyleSolver — drop-in replacement.

    time_matrix layout: 0=destination, 1..N=schools, N+1=dummy start.
    demands layout:     same length as time_matrix rows.
    """

    def __init__(
        self,
        time_matrix: list,
        demands: list,
        vehicle_capacity: int,
        min_savings_minutes: int = 0,
        fixed_vehicle_cost: int = 0,   # ignored — API compatibility
        starts: Optional[list] = None,  # ignored
        ends: Optional[list] = None,    # ignored
        institutes: Optional[list] = None,
        **kwargs,
    ):
        self.time_matrix = time_matrix
        self.demands = demands
        self.vehicle_capacity = vehicle_capacity
        self.min_savings = min_savings_minutes * 60
        self.institutes = institutes

    def solve(self) -> Optional[dict]:
        assert len(self.demands) == len(self.time_matrix), (
            f"demands length ({len(self.demands)}) must match time_matrix size ({len(self.time_matrix)})"
        )
        n_schools = len(self.demands) - 2
        if n_schools == 0:
            return {"routes": [], "total_distance": 0, "total_load": 0, "used_vehicles": 0}

        school_nodes = list(range(1, n_schools + 1))

        school_matrix = [
            [self.time_matrix[i][j] for j in school_nodes]
            for i in school_nodes
        ]
        school_demands = [self.demands[i] for i in school_nodes]
        depot_times = [self.time_matrix[0][j] for j in school_nodes]

        # Step 1: Savings-based grouping
        savings_list = _compute_savings(depot_times, school_matrix)
        clusters = _savings_cluster(
            savings_list, school_demands, self.vehicle_capacity, self.min_savings
        )

        # Step 2: Apply institute constraints
        if self.institutes is not None:
            school_institutes = [self.institutes[i] for i in school_nodes]
            clusters = _apply_institute_constraints(clusters, school_institutes)

        # Step 3: Split oversized clusters (safety net)
        split_clusters = []
        for c in clusters:
            split_clusters.extend(
                _split_cluster(c, school_demands, school_matrix, self.vehicle_capacity)
            )

        # Step 4: Build ordered routes
        depot_row = [self.time_matrix[0][j] for j in school_nodes]
        routes = []
        total_distance = 0
        total_load = 0

        for vehicle_id, cluster in enumerate(split_clusters):
            if not cluster:
                continue

            ordered = _order_route(cluster, school_matrix, depot_row)

            stops = []
            load = 0
            for s_idx in ordered:
                node = school_nodes[s_idx]
                stops.append({"node": node, "load": school_demands[s_idx]})
                load += school_demands[s_idx]

            stops = [{"node": 0, "load": 0}] + stops + [{"node": 0, "load": 0}]

            route_dist = 0
            for k in range(len(stops) - 1):
                route_dist += self.time_matrix[stops[k]["node"]][stops[k + 1]["node"]]

            routes.append({
                "vehicle_id": vehicle_id,
                "stops": stops,
                "distance": route_dist,
                "load": load,
            })
            total_distance += route_dist
            total_load += load

        return {
            "routes": routes,
            "total_distance": total_distance,
            "total_load": total_load,
            "used_vehicles": len(routes),
        }
