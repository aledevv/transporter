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
        # Single school exceeds capacity — cannot split further; keep as-is with a warning
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
) -> list:
    """
    Greedily merge clusters if combined demand fits capacity.
    Picks the pair with minimum inter-cluster travel time (closest schools between groups).

    clusters: list of lists of school indices (school-space)
    demands: list[int] (school-space)
    school_matrix: NxN travel-time matrix (school-space)
    capacity: int

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
# HumanStyleSolver (stub — full implementation in Task 11)
# -----------------------------------------------------------------------

class HumanStyleSolver:
    """
    Placeholder class. Full implementation comes in Task 11.
    Exposes the same interface as VRPSolver.
    """
    pass
