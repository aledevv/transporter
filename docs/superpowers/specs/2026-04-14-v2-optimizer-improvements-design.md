# Design: V2 Optimizer Improvements — Detour Cap + 2-opt + km/time Metrics

**Date:** 2026-04-14  
**Status:** Approved

---

## Context

User feedback from the comparison tool (`busplan_feedback_2026-04-14.json`) shows GT wins 17/29 events (59%). The two most frequent complaint chips are **"Meno km"** (11/17 cases) and **"Orari migliori"** (10/17 cases). These are caused by the same root issue: V2's `_merge_clusters` uses a *minimum inter-cluster distance* criterion, which allows **chaining** — cluster A merges with B and B merges with C, even if A and C are geographically incompatible, as long as each adjacent pair is within `max_merge_minutes`. This produces buses with 10–13 stops spanning the entire province (e.g., Ragazzi bus 5: 13 fermate, partenza 03:47, 117 km).

The current Jaccard/assignment metric rewards similarity to the human plan, but the real goal is: **fewer km, shorter route times, right number of buses** — regardless of whether the groupings match the human plan exactly.

### Key findings from GT data analysis

Route duration stats across 274 GT buses (pure travel time, stops with valid departure times):

| Percentile | Minutes |
|-----------|---------|
| P75 | 115 |
| P90 | 155 |
| P95 | 181 |
| P99 | 196 |
| Max observed | 219 |

A hard absolute cap is wrong: ski/snowboard events legitimately have routes of 180–220 min. The problem is not route length but **unnecessary detours**.

### Current evaluation baseline

```
V1 (OR-Tools):  combined=0.689  assignment=0.628  bus_count=0.780
V2 (HumanStyle): combined=0.704  assignment=0.590  bus_count=0.875
V3 (Savings):   combined=0.667  — does not improve over V2
```

V3 (SavingsSolver) was already tested and loses. This design improves V2 directly.

---

## Solution

Three coordinated changes, all scoped to `optimizer_v2.py`, `tests/evaluate_realSuite.py`, and a new experiment script.

### 1. Incremental detour cap in `_merge_clusters`

**Replace** the absolute `max_merge_seconds` distance check with an additional **incremental route time check**:

```
merge_cost = route_time(A∪B) − max(route_time(A), route_time(B))

allow merge only if merge_cost ≤ max_detour_seconds
```

Where `route_time(cluster)` is estimated by running the NN ordering on the cluster and summing travel times along the path (including the last-stop → destination leg, approximated using `depot_row[i]`).

**Why this scales correctly:**
- Ski event: both clusters are in the same north direction → merged route adds little time → merge_cost small → allowed
- Bad merge (e.g., adding Mezzolombardo to a Cembra/Trento/Pergine/Folgaria chain): requires a large backtrack → merge_cost large → blocked

The existing `max_merge_seconds` check (minimum inter-cluster distance) is kept as-is — the detour check is an *additional* guard, not a replacement. Both conditions must pass for a merge to proceed.

New helper: `_estimate_route_time(school_indices, school_matrix, depot_row) -> int`  
Uses NN ordering internally (does not mutate any state). Cheap: O(n²) for typical cluster sizes of 2–15.

### 2. 2-opt post-processing in `_order_route`

After nearest-neighbor, apply standard 2-opt improvement:

```
for i in range(len(route) - 1):
    for j in range(i + 2, len(route)):
        if reversing route[i+1..j] reduces total route cost:
            reverse the segment
            restart
```

Reduces within-bus km without touching groupings. Converges in 1–3 passes for cluster sizes ≤ 20.

**New helper:** `_two_opt(route, school_matrix) -> list`  
Pure function, returns improved route. Called from `_order_route` after NN.

### 3. New evaluation metrics

Add `compute_route_metrics(solution, schools, time_matrix, distance_matrix)` to `tests/evaluate_realSuite.py`:

- `total_km` — sum of km across all buses in the solution. Uses `distance_matrix` when available (all realSuite fixtures have it), falls back to `time × 30 km/h`.
- `max_route_min` — duration of the longest individual bus route (minutes of pure driving). This is the metric that captures passenger experience for the worst-served school.

Both metrics are **GT-independent** — computed from the solver output only.

Updated `main()` adds two columns per solver: `tot_km` and `max_min`.

---

## Grid Search

**File:** `experiments/v2_improvements/grid_search.py`

Sweeps:
```
max_detour_minutes : [20, 30, 40, ∞]      (∞ = current V2 behavior)
max_merge_minutes  : [25, 35, 45]          (35 = current default)
```

12 combinations + V1 + V2-current as baselines = 14 rows total.

For each combination, aggregated over all 29 events:
- `combined` — mean combined score (0.6×assignment + 0.4×bus_count)
- `tot_km` — total km summed across all events and all buses
- `max_min` — maximum single-route duration across all events

Output format:
```
config           combined  tot_km   max_min
V2 (current)     0.704     XXXX     XXX
V1               0.689     XXXX     XXX
d=20 / m=25      …         …        …
…
```

**Verdict criterion:** Choose the configuration that minimises `tot_km` without losing more than 0.015 combined score vs V2-current. The chosen `(max_detour_minutes, max_merge_minutes)` become the new defaults for `HumanStyleSolver`.

---

## API changes

`HumanStyleSolver.__init__` gains one new parameter:

```python
max_detour_minutes: int = 35   # set by grid search; 35 is initial default
```

`cluster_threshold_minutes` and `max_merge_minutes` remain unchanged.

`app.py` passes `max_detour_minutes` if it instantiates `HumanStyleSolver` directly — no changes needed until the grid search determines the final value, after which the default is updated in the class signature.

---

## File layout

```
optimizer_v2.py
  + _estimate_route_time(school_indices, school_matrix, depot_row) -> int
  + _two_opt(route, school_matrix) -> list
  ~ _merge_clusters: new param max_detour_seconds=float("inf")
  ~ HumanStyleSolver.__init__: new param max_detour_minutes=35
  ~ HumanStyleSolver.solve: passes max_detour_seconds to _merge_clusters,
                             calls _two_opt inside route building loop

tests/evaluate_realSuite.py
  + compute_route_metrics(solution, schools, time_matrix, distance_matrix) -> dict
  ~ main(): adds tot_km, max_min columns for V1 and V2

experiments/v2_improvements/
  __init__.py                (empty)
  grid_search.py             (sweep script, standalone)
```

**Not modified:** `optimizer.py`, `app.py`, `tools/`, `tests/test_*.py`, frontend.

---

## Verification

1. `python3 experiments/v2_improvements/grid_search.py` completes without errors; prints table with 14 rows.
2. The `tot_km` column for V2-current matches `python3 tests/evaluate_realSuite.py` (new columns show identical baseline).
3. At least one `(max_detour, max_merge)` combination beats V2-current on `tot_km` without losing > 0.015 combined score.
4. The worst-case planner route (formerly 13 stops, departure 03:47) is split into smaller buses under the winning configuration.
5. `pytest tests/ -v` passes without regressions.
