"""
V2 Human-Style Planner.

Mimics the 2-step approach used by human transport planners:
  Step 1 — Proximity clustering (ignore capacity): group schools that are geographically close.
  Step 2 — Capacity balancing: split oversized groups; merge small ones.

Interface mirrors VRPSolver so it can be swapped in transparently.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform


# -----------------------------------------------------------------------
# Step 1 helpers
# -----------------------------------------------------------------------

def _cluster_schools(school_matrix: list, threshold_seconds: int) -> list:
    """
    Agglomerative clustering on an NxN travel-time matrix (school nodes only).

    Uses complete linkage: a cluster is formed when the maximum pairwise
    travel time within it is ≤ threshold_seconds. This matches the human
    intuition "all schools within D minutes of each other".

    Returns a list of integer labels (0-indexed), length N.
    """
    n = len(school_matrix)
    if n == 1:
        return [0]

    arr = np.array(school_matrix, dtype=float)
    # scipy squareform expects condensed distance vector
    condensed = squareform(arr, checks=False)
    Z = linkage(condensed, method="complete")
    labels = fcluster(Z, t=threshold_seconds, criterion="distance")
    return (labels - 1).tolist()  # 0-indexed


# -----------------------------------------------------------------------
# Step 2 helpers
# -----------------------------------------------------------------------

def _split_cluster(
    school_indices: list,
    demands: list,
    school_matrix: list,
    capacity: int,
) -> list:
    """
    Recursively split a cluster until every sub-cluster fits capacity.

    school_indices: list of indices into school_matrix / demands (school-space, 0-indexed)
    demands: list[int] of length N (school-space)
    school_matrix: NxN travel-time matrix (school-space)
    capacity: int

    Returns list of clusters, each a list of school indices.
    """
    if sum(demands[i] for i in school_indices) <= capacity:
        return [list(school_indices)]

    if len(school_indices) == 1:
        import warnings
        warnings.warn(
            f"School at index {school_indices[0]} has demand {demands[school_indices[0]]} "
            f"exceeding capacity {capacity} — cannot split further."
        )
        return [list(school_indices)]

    # Find the school farthest from the cluster centroid.
    # "distance to centroid" = mean travel time to all other schools in the cluster.
    def dist_to_centroid(idx):
        others = [j for j in school_indices if j != idx]
        return sum(school_matrix[idx][j] for j in others) / len(others)

    farthest = max(school_indices, key=dist_to_centroid)
    remaining = [i for i in school_indices if i != farthest]

    return (
        _split_cluster(remaining, demands, school_matrix, capacity)
        + _split_cluster([farthest], demands, school_matrix, capacity)
    )


def _merge_clusters(
    clusters: list,
    demands: list,
    school_matrix: list,
    capacity: int,
    max_merge_seconds: float = float("inf"),
) -> list:
    """
    Greedily merge clusters if combined demand fits capacity.
    Picks the pair with minimum inter-cluster travel time (closest schools between groups).
    Only merges if the inter-cluster distance is within max_merge_seconds.

    clusters: list of lists of school indices (school-space)
    demands: list[int] (school-space)
    school_matrix: NxN travel-time matrix (school-space)
    capacity: int
    max_merge_seconds: float — skip merge if closest schools between two clusters
                               are farther than this (prevents cross-region grouping)

    Returns the updated clusters list.
    """
    changed = True
    while changed:
        changed = False
        best_pair = None
        best_dist = float("inf")

        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                combined = sum(demands[k] for k in clusters[i] + clusters[j])
                if combined > capacity:
                    continue
                inter_dist = min(
                    school_matrix[a][b]
                    for a in clusters[i]
                    for b in clusters[j]
                )
                if inter_dist > max_merge_seconds:
                    continue
                if inter_dist < best_dist:
                    best_dist = inter_dist
                    best_pair = (i, j)

        if best_pair is not None:
            i, j = best_pair
            merged = clusters[i] + clusters[j]
            clusters = [c for k, c in enumerate(clusters) if k not in (i, j)]
            clusters.append(merged)
            changed = True

    return clusters


# -----------------------------------------------------------------------
# Route ordering (nearest-neighbor TSP)
# -----------------------------------------------------------------------

def _order_route(school_indices: list, school_matrix: list, depot_row: list) -> list:
    """
    Order schools within a bus using nearest-neighbor heuristic.
    Starts from the school farthest from the depot, always moves to the nearest unvisited.

    school_indices: list of school-space indices (0-indexed, into school_matrix)
    school_matrix:  NxN travel-time matrix (school-space)
    depot_row:      row of the time matrix for the depot, restricted to school nodes
                    (i.e. time_matrix[0][1:N+1])

    Returns ordered list of school-space indices.
    """
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


def _estimate_route_time(
    school_indices: list,
    school_matrix: list,
    depot_row: list,
) -> int:
    """
    Estimate total route time for a cluster: depot → NN-ordered schools → depot.

    Uses the same nearest-neighbor ordering as _order_route.
    The return leg (last school → depot) is approximated symmetrically
    using depot_row[last], which is accurate for OSM-routed data.

    Returns travel time in seconds.
    """
    if not school_indices:
        return 0
    ordered = _order_route(school_indices, school_matrix, depot_row)
    t = depot_row[ordered[0]]                          # depot → first school
    for k in range(len(ordered) - 1):
        t += school_matrix[ordered[k]][ordered[k + 1]] # school → school
    t += depot_row[ordered[-1]]                        # last school → depot (approx)
    return int(t)


# -----------------------------------------------------------------------
# HumanStyleSolver
# -----------------------------------------------------------------------

class HumanStyleSolver:
    """
    Human-style 2-step bus planner.

    Same interface as VRPSolver — drop-in replacement.

    time_matrix layout: 0=destination, 1..N=schools, N+1=dummy start.
    demands layout:     same length as time_matrix rows.
    """

    def __init__(
        self,
        time_matrix: list,
        demands: list,
        vehicle_capacity: int,
        cluster_threshold_minutes: int = 25,
        max_merge_minutes: int = 35,
        fixed_vehicle_cost: int = 0,   # ignored — kept for API compatibility
        starts: Optional[list] = None,  # ignored
        ends: Optional[list] = None,    # ignored
        institutes: Optional[list] = None,
        **kwargs,
    ):
        self.time_matrix = time_matrix
        self.demands = demands
        self.vehicle_capacity = vehicle_capacity
        self.threshold_seconds = cluster_threshold_minutes * 60
        self.max_merge_seconds = max_merge_minutes * 60
        self.institutes = institutes

    def solve(self) -> Optional[dict]:
        """
        Run Step 1 (clustering) then Step 2 (balancing) and return a solution dict
        with the same structure as VRPSolver.solve().
        """
        assert len(self.demands) == len(self.time_matrix), (
            f"demands length ({len(self.demands)}) must match time_matrix size ({len(self.time_matrix)})"
        )
        n_schools = len(self.demands) - 2  # subtract depot (0) and dummy (N+1)
        if n_schools == 0:
            return {"routes": [], "total_distance": 0, "total_load": 0, "used_vehicles": 0}

        school_nodes = list(range(1, n_schools + 1))  # node-space: 1..N

        # Build school-only time matrix (school-space: 0-indexed)
        school_matrix = [
            [self.time_matrix[i][j] for j in school_nodes]
            for i in school_nodes
        ]
        school_demands = [self.demands[i] for i in school_nodes]

        # Step 1: Proximity clustering
        labels = _cluster_schools(school_matrix, self.threshold_seconds)

        # Group school-space indices by cluster label
        cluster_map: dict = {}
        for idx, label in enumerate(labels):
            cluster_map.setdefault(label, []).append(idx)
        clusters = list(cluster_map.values())

        # Step 1b: Apply institute constraints — schools sharing a non-UNIVERSAL
        # institute must end up in the same cluster.
        if self.institutes is not None:
            school_institutes = [self.institutes[i] for i in school_nodes]
            clusters = _apply_institute_constraints(clusters, school_institutes)

        # Step 2a: Split oversized clusters
        split_clusters = []
        for c in clusters:
            split_clusters.extend(_split_cluster(c, school_demands, school_matrix, self.vehicle_capacity))

        # Step 2b: Merge under-capacity clusters
        final_clusters = _merge_clusters(split_clusters, school_demands, school_matrix, self.vehicle_capacity, self.max_merge_seconds)

        # Build routes
        depot_row = [self.time_matrix[0][j] for j in school_nodes]  # depot → each school (school-space)
        routes = []
        total_distance = 0
        total_load = 0

        for vehicle_id, cluster in enumerate(final_clusters):
            if not cluster:
                continue

            ordered = _order_route(cluster, school_matrix, depot_row)

            # Convert school-space → node-space and build stops
            stops = []
            load = 0
            for s_idx in ordered:
                node = school_nodes[s_idx]
                stops.append({"node": node, "load": school_demands[s_idx]})
                load += school_demands[s_idx]

            # Add depot at start and end (node 0)
            stops = [{"node": 0, "load": 0}] + stops + [{"node": 0, "load": 0}]

            # Route distance: sum travel times along path (depot→s1→s2→...→depot)
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


def _apply_institute_constraints(clusters: list, school_institutes: list) -> list:
    """
    Merge any clusters that contain schools from the same non-UNIVERSAL institute.
    Ensures institute-labelled schools always share a bus (regardless of distance).
    """
    # Build mapping: institute → set of school-space indices
    inst_to_schools: dict = {}
    for idx, inst in enumerate(school_institutes):
        if inst and inst != "UNIVERSAL":
            inst_to_schools.setdefault(inst, set()).add(idx)

    if not inst_to_schools:
        return clusters

    # Union-Find to merge clusters that share an institute
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

    # Rebuild clusters
    merged: dict = {}
    for ci, cluster in enumerate(clusters):
        root = find(ci)
        merged.setdefault(root, []).extend(cluster)

    return list(merged.values())
