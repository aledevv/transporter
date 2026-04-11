# Savings Solver Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated `experiments/savings_solver/` folder containing a Clarke-Wright savings-based `SavingsSolver`, a three-way comparison evaluator (V1/V2/SavingsSolver), and a parameter grid search — deletable wholesale if the new solver doesn't beat current V2.

**Architecture:** `SavingsSolver` replaces V2's two-step (proximity cluster → greedy merge) with a single savings-based Union-Find grouping: `s(i,j) = time(depot→i) + time(depot→j) − time(i→j)`. The evaluation scripts import scoring helpers from `tests/evaluate_realSuite.py` (read-only) and existing solvers from the project root (read-only). Zero changes to existing files.

**Tech Stack:** Python 3, numpy, scipy (already installed), existing `time_matrix.json` artifacts per event (no OSRM/LLM calls needed).

---

## File Map

| File | Role |
|---|---|
| `experiments/savings_solver/__init__.py` | Package marker (empty) |
| `experiments/savings_solver/optimizer_savings.py` | `SavingsSolver` class + helpers |
| `experiments/savings_solver/evaluate_savings.py` | V1 / V2 / SavingsSolver comparison table |
| `experiments/savings_solver/grid_search_savings.py` | `min_savings_minutes` sweep (0–20) |

No existing files are modified.

---

## Task 1: `optimizer_savings.py` — SavingsSolver class

**Files:**
- Create: `experiments/savings_solver/__init__.py`
- Create: `experiments/savings_solver/optimizer_savings.py`

- [ ] **Step 1: Create the experiment folder and empty `__init__.py`**

```bash
mkdir -p experiments/savings_solver
touch experiments/savings_solver/__init__.py
```

- [ ] **Step 2: Write `optimizer_savings.py`**

Create `experiments/savings_solver/optimizer_savings.py` with this content:

```python
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
```

- [ ] **Step 3: Smoke-test `SavingsSolver` with a minimal inline check**

Run from the project root:

```bash
python - <<'EOF'
import sys
sys.path.insert(0, ".")
sys.path.insert(0, "experiments/savings_solver")
from optimizer_savings import SavingsSolver

# 3 schools: A is far left, B is between depot and A, C is far right
# depot=0, A=1, B=2, C=3
# time_matrix[depot][A]=60, [depot][B]=30, [depot][C]=60
# time[A][B]=30 (B is between A and depot → same corridor)
# time[A][C]=120 (opposite sides)
tm = [
    [0,  60, 30, 60, 0],   # depot row
    [60,  0, 30,120, 0],   # A
    [30, 30,  0, 90, 0],   # B
    [60,120, 90,  0, 0],   # C
    [0,   0,  0,  0, 0],   # dummy
]
demands = [0, 10, 10, 10, 0]
solver = SavingsSolver(time_matrix=tm, demands=demands, vehicle_capacity=25, min_savings_minutes=0)
sol = solver.solve()
print("Routes:", len(sol["routes"]))
for r in sol["routes"]:
    nodes = [s["node"] for s in r["stops"]]
    print(f"  Bus {r['vehicle_id']}: {nodes}")
# Expected: A+B on same bus (savings(A,B)=60+30-30=60), C alone (savings(A,C)=60+60-120=0 → not merged)
EOF
```

Expected output:
```
Routes: 2
  Bus 0: [0, 1, 2, 0]   (or [0, 2, 1, 0] — order within bus may vary)
  Bus 1: [0, 3, 0]
```

- [ ] **Step 4: Commit**

```bash
git add experiments/savings_solver/__init__.py experiments/savings_solver/optimizer_savings.py
git commit -m "experiment: add SavingsSolver with Clarke-Wright savings-based grouping"
```

---

## Task 2: `evaluate_savings.py` — three-way comparison

**Files:**
- Create: `experiments/savings_solver/evaluate_savings.py`

- [ ] **Step 1: Write `evaluate_savings.py`**

Create `experiments/savings_solver/evaluate_savings.py` with this content:

```python
"""
Three-way comparison: V1 (VRPSolver) / V2 (HumanStyleSolver) / V3 (SavingsSolver).

Usage (from project root):
  python experiments/savings_solver/evaluate_savings.py

Uses pre-computed time_matrix.json — no OSRM or LLM calls.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Path setup: root first (for optimizer*.py), then tests/ (for evaluate_realSuite)
_HERE = Path(__file__).parent
_ROOT = _HERE.parent.parent
_TESTS = _ROOT / "tests"
sys.path.insert(0, str(_HERE))   # optimizer_savings
sys.path.insert(0, str(_ROOT))   # optimizer, optimizer_v2
sys.path.insert(0, str(_TESTS))  # evaluate_realSuite

from evaluate_realSuite import (
    _all_events,
    _build_solver_matrix,
    load_event,
    load_groundtruth,
    run_v1,
    run_v2,
    score_assignment,
    score_bus_count,
    solution_to_buses,
)
from optimizer_savings import SavingsSolver


def run_savings(ev: dict, min_savings_minutes: int = 0) -> dict | None:
    """Run SavingsSolver on an event dict. Returns solution or None."""
    schools = ev["schools"]
    n = len(schools)
    capacity = ev["capacity"]
    time_matrix = _build_solver_matrix(ev["time_matrix"], n)
    demands = [0] + [s["demand"] for s in schools] + [0]

    solver = SavingsSolver(
        time_matrix=time_matrix,
        demands=demands,
        vehicle_capacity=capacity,
        min_savings_minutes=min_savings_minutes,
    )
    return solver.solve()


def main():
    events = _all_events()
    total = len(events)
    rows = []

    for idx, ev_dir in enumerate(events, 1):
        print(f"\r[{idx}/{total}] {ev_dir.name[:50]:<50}", end="", flush=True)
        ev = load_event(ev_dir)
        if ev is None:
            continue

        gt = load_groundtruth(ev["gt_path"])
        gt_count = len([v for v in gt.values() if v])

        def _score(sol):
            if not sol:
                return 0, 0.0, 0.0, 0.0
            pred = solution_to_buses(sol, ev["schools"])
            a = score_assignment(pred, gt)
            c = score_bus_count(pred, gt)
            return len(pred), a, c, 0.6 * a + 0.4 * c

        n_v1, v1_a, v1_c, v1_t = _score(run_v1(ev))
        n_v2, v2_a, v2_c, v2_t = _score(run_v2(ev))
        n_v3, v3_a, v3_c, v3_t = _score(run_savings(ev))

        rows.append({
            "Event":   ev["name"][:45],
            "GT":      gt_count,
            "V1_n":    n_v1,    "V1_asgn": f"{v1_a:.3f}", "V1_cnt": f"{v1_c:.3f}", "V1_tot": f"{v1_t:.3f}",
            "V2_n":    n_v2,    "V2_asgn": f"{v2_a:.3f}", "V2_cnt": f"{v2_c:.3f}", "V2_tot": f"{v2_t:.3f}",
            "V3_n":    n_v3,    "V3_asgn": f"{v3_a:.3f}", "V3_cnt": f"{v3_c:.3f}", "V3_tot": f"{v3_t:.3f}",
        })

    print()

    if not rows:
        print("No events with complete artifacts. Run prepare_realSuite.py first.")
        return

    cols  = ["Event", "GT",
             "V1_n", "V1_asgn", "V1_cnt", "V1_tot",
             "V2_n", "V2_asgn", "V2_cnt", "V2_tot",
             "V3_n", "V3_asgn", "V3_cnt", "V3_tot"]
    col_w = [46, 4,
             5, 8, 8, 8,
             5, 8, 8, 8,
             5, 8, 8, 8]

    header = "  ".join(c.ljust(w) for c, w in zip(cols, col_w))
    sep    = "-" * len(header)
    print(sep)
    print(header)
    print(sep)
    for r in rows:
        print("  ".join(str(r[c]).ljust(w) for c, w in zip(cols, col_w)))
    print(sep)

    numeric_cols = [c for c in cols if c != "Event"]
    mean_row = {"Event": "MEAN"}
    for col in numeric_cols:
        vals = [float(r[col]) for r in rows]
        mean_row[col] = f"{sum(vals)/len(vals):.3f}"
    print("  ".join(str(mean_row.get(c, "")).ljust(w) for c, w in zip(cols, col_w)))

    # Verdict
    mean_v2  = sum(float(r["V2_tot"]) for r in rows) / len(rows)
    mean_v3  = sum(float(r["V3_tot"]) for r in rows) / len(rows)
    print(f"\nVerdict: V2={mean_v2:.3f}  V3_savings={mean_v3:.3f}  "
          f"→ {'SavingsSolver WINS — promote to V2' if mean_v3 > mean_v2 else 'No improvement — keep V2, delete experiments/savings_solver/'}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run `evaluate_savings.py` and check output**

```bash
python experiments/savings_solver/evaluate_savings.py
```

Expected: prints a table with V1/V2/V3 columns and a Verdict line at the bottom. If any event shows `[skip]`, those are events with missing artifacts (normal — just fewer rows).

- [ ] **Step 3: Commit**

```bash
git add experiments/savings_solver/evaluate_savings.py
git commit -m "experiment: add three-way evaluator (V1/V2/SavingsSolver)"
```

---

## Task 3: `grid_search_savings.py` — min_savings_minutes sweep

**Files:**
- Create: `experiments/savings_solver/grid_search_savings.py`

- [ ] **Step 1: Write `grid_search_savings.py`**

Create `experiments/savings_solver/grid_search_savings.py` with this content:

```python
"""
Grid search for min_savings_minutes parameter in SavingsSolver.

Usage (from project root):
  python experiments/savings_solver/grid_search_savings.py

Uses pre-computed time_matrix.json — no OSRM or LLM calls.
"""
from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).parent
_ROOT = _HERE.parent.parent
_TESTS = _ROOT / "tests"
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_TESTS))

from evaluate_realSuite import (
    _all_events,
    load_event,
    load_groundtruth,
    run_v1,
    score_assignment,
    score_bus_count,
    solution_to_buses,
)
from evaluate_savings import run_savings

THRESHOLDS = [0, 5, 10, 15, 20]


def _collect_scores(run_fn, events_data, label):
    n = len(events_data)
    tot, asgn, cnt = [], [], []
    for i, (ev, gt) in enumerate(events_data):
        print(f"[{label}] {i + 1}/{n} {ev['name'][:40]}", end="\r", flush=True)
        sol = run_fn(ev)
        if sol:
            pred = solution_to_buses(sol, ev["schools"])
            a = score_assignment(pred, gt)
            c = score_bus_count(pred, gt)
            tot.append(0.6 * a + 0.4 * c)
            asgn.append(a)
            cnt.append(c)
        else:
            tot.append(None)
            asgn.append(None)
            cnt.append(None)
    print(f"[{label}] done ({n}/{n})                                          ")
    return tot, asgn, cnt


def _safe_mean(lst):
    vals = [x for x in lst if x is not None]
    return f"{sum(vals)/len(vals):.3f}" if vals else "—"


def _mean(lst):
    vals = [x for x in lst if x is not None]
    return sum(vals) / len(vals) if vals else 0.0


def main():
    events_data = []
    for ev_dir in _all_events():
        ev = load_event(ev_dir)
        if ev is None:
            continue
        gt = load_groundtruth(ev["gt_path"])
        events_data.append((ev, gt))

    if not events_data:
        print("No events ready. Run prepare_realSuite.py first.")
        return

    v1_scores, v1_asgn, v1_cnt = _collect_scores(run_v1, events_data, "V1")

    results = {}
    asgn_results = {}
    cnt_results = {}
    for S in THRESHOLDS:
        results[S], asgn_results[S], cnt_results[S] = _collect_scores(
            lambda ev, S=S: run_savings(ev, min_savings_minutes=S),
            events_data, f"S={S:2d}",
        )

    col_w = [46] + [8] * (len(THRESHOLDS) + 1)
    header_parts = ["Event", "V1"] + [f"S={S}" for S in THRESHOLDS]
    header = "  ".join(str(h).ljust(w) for h, w in zip(header_parts, col_w))
    sep = "-" * len(header)
    print(sep)
    print(header)
    print(sep)

    for i, (ev, _) in enumerate(events_data):
        v1_s = f"{v1_scores[i]:.3f}" if v1_scores[i] is not None else "—"
        row = [ev["name"][:45], v1_s] + [
            f"{results[S][i]:.3f}" if results[S][i] is not None else "—"
            for S in THRESHOLDS
        ]
        print("  ".join(str(r).ljust(w) for r, w in zip(row, col_w)))

    print(sep)

    summary   = ["MEAN",      _safe_mean(v1_scores)] + [_safe_mean(results[S])      for S in THRESHOLDS]
    mean_asgn = ["MEAN_ASGN", _safe_mean(v1_asgn)]   + [_safe_mean(asgn_results[S]) for S in THRESHOLDS]
    mean_cnt  = ["MEAN_CNT",  _safe_mean(v1_cnt)]     + [_safe_mean(cnt_results[S])  for S in THRESHOLDS]
    print("  ".join(str(s).ljust(w) for s, w in zip(summary,   col_w)))
    print("  ".join(str(s).ljust(w) for s, w in zip(mean_asgn, col_w)))
    print("  ".join(str(s).ljust(w) for s, w in zip(mean_cnt,  col_w)))

    best_S    = max(THRESHOLDS, key=lambda S: _mean(results[S]))
    best_mean = _mean(results[best_S])
    v1_mean   = _mean(v1_scores)
    print(f"\nBest S: {best_S} min  (mean score {best_mean:.3f} vs V1 {v1_mean:.3f})")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the grid search**

```bash
python experiments/savings_solver/grid_search_savings.py
```

Expected: progress lines per threshold, then a table with columns `V1 | S=0 | S=5 | S=10 | S=15 | S=20`, then MEAN / MEAN_ASGN / MEAN_CNT rows and a "Best S" line.

- [ ] **Step 3: Commit**

```bash
git add experiments/savings_solver/grid_search_savings.py
git commit -m "experiment: add min_savings_minutes grid search for SavingsSolver"
```

---

## Task 4: Run full evaluation and decide

- [ ] **Step 1: Run the three-way evaluator with default settings (S=0)**

```bash
python experiments/savings_solver/evaluate_savings.py
```

Record the MEAN row and the Verdict line.

- [ ] **Step 2: Run the grid search to find the best S**

```bash
python experiments/savings_solver/grid_search_savings.py
```

Note the best `S` value and whether it meaningfully differs from S=0.

- [ ] **Step 3: If the best S > 0, re-run evaluate_savings.py with that threshold**

Edit the `run_savings(ev)` call in `evaluate_savings.py` `main()` to pass the best S:

```python
n_v3, v3_a, v3_c, v3_t = _score(run_savings(ev, min_savings_minutes=<BEST_S>))
```

Re-run:

```bash
python experiments/savings_solver/evaluate_savings.py
```

- [ ] **Step 4a: If SavingsSolver wins — promote to V2**

Copy the new logic into `optimizer_v2.py`: replace `_cluster_schools` + `_merge_clusters` with `_compute_savings` + `_savings_cluster`, update `HumanStyleSolver.__init__` to accept `min_savings_minutes` (keep `cluster_threshold_minutes` as an alias for backwards compatibility), update `HumanStyleSolver.solve()` to call the new helpers.

Then delete the experiment folder:

```bash
git rm -r experiments/savings_solver/
git commit -m "feat: promote SavingsSolver to V2 (Clarke-Wright savings grouping, S=<BEST_S>)"
```

- [ ] **Step 4b: If SavingsSolver does not win — delete experiment**

```bash
git rm -r experiments/savings_solver/
git commit -m "experiment: remove savings_solver (did not beat V2)"
```
