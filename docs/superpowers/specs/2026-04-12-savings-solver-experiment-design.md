# Design: Savings-Based Solver Experiment

**Date:** 2026-04-12
**Status:** Approved

---

## Overview

An isolated experiment to test whether replacing V2's pairwise proximity clustering with a Clarke-Wright savings-based grouping improves assignment quality. The new solver lives in `experiments/savings_solver/` and can be deleted wholesale if it doesn't outperform the current V2.

**Hypothesis:** Current V2 clusters schools by pairwise travel time, ignoring direction relative to the destination. Human planners group schools along the same road corridor toward the event. The savings metric `s(i,j) = time(depot→i) + time(depot→j) − time(i→j)` captures this naturally: high savings = schools are on the same road; negative savings = opposite directions.

**Root-cause evidence from grid search:** `cluster_threshold_minutes` D has almost no effect on V2 output (D=5 and D=30 produce identical results for ~20/29 events), proving the current merge step dominates and erases the clustering signal entirely.

---

## Evaluation Baseline (current scores)

```
MEAN V1_tot: 0.629   V1_asgn: 0.593   V1_cnt: 0.684
MEAN V2_tot: 0.652   V2_asgn: 0.601   V2_cnt: 0.729
```

Known V2 regressions vs V1 (target cases to fix):
- `Piano-Giocopallamano_3-marzo-26_con-vettore`: V1=0.816 → V2=0.683 (asgn drops 0.22)
- `Piano-Viaggi-GdG_24-marzo-26`: V1=0.767 → V2=0.617 (asgn drops 0.25)
- `Piano-Viaggi_Volley-S3`: V1=0.502 → V2=0.446

**Verdict criterion:** If `MEAN_tot(SavingsSolver) > MEAN_tot(V2=0.652)`, promote to V2. Otherwise delete the folder.

---

## Algorithm: SavingsSolver

Same interface as `VRPSolver` and `HumanStyleSolver` — drop-in replacement.

### Step 1 — Compute savings

For every pair of schools (i, j) in school-space (0-indexed):

```
savings(i, j) = depot_time[i] + depot_time[j] − school_matrix[i][j]
```

where `depot_time[i] = time_matrix[0][school_nodes[i]]`.

Positive savings: combining i and j on one bus saves travel time vs. two separate buses — they are on the same road corridor.  
Zero/negative savings: schools in opposite or perpendicular directions — no benefit to combining.

### Step 2 — Savings-based grouping (Union-Find)

1. Each school starts as its own cluster.
2. Sort all pairs by savings descending.
3. For each pair (i, j):
   - If `savings(i, j) ≤ min_savings_threshold`: stop (remaining pairs only get worse).
   - If i and j are in different clusters and `combined_demand ≤ vehicle_capacity`: merge.
4. Track cluster demand in the Union-Find structure for O(1) capacity check per merge.

**Parameter:** `min_savings_minutes` (default: 0) — minimum savings in minutes required to merge. Replaces `cluster_threshold_minutes` semantically; kept as an optional knob for the grid search.

### Step 3 — Apply institute constraints

Same `_apply_institute_constraints()` logic as V2: force-join schools sharing a non-UNIVERSAL institute label, even if savings is negative.

### Step 4 — Split oversized clusters (safety net)

Same `_split_cluster()` logic as V2: handles clusters that exceed capacity after institute force-joins.

### Step 5 — Order routes

Same `_order_route()` nearest-neighbor TSP heuristic as V2.

---

## File Layout

```
experiments/savings_solver/
  __init__.py               # empty
  optimizer_savings.py      # SavingsSolver class
  evaluate_savings.py       # comparison runner: V1 / V2 / SavingsSolver, full table
  grid_search_savings.py    # min_savings_minutes sweep: 0, 5, 10, 15, 20
```

No existing files are modified.

### `optimizer_savings.py`

- `SavingsSolver` class with same `__init__` signature as `HumanStyleSolver`
- `min_savings_minutes` parameter (default 0) instead of `cluster_threshold_minutes`
- Internal helpers: `_compute_savings`, `_savings_cluster` (Union-Find grouping)
- Reuses `_split_cluster`, `_apply_institute_constraints`, `_order_route` — copied from `optimizer_v2.py` (no import dependency to avoid coupling)

### `evaluate_savings.py`

Standalone script (no pytest). Columns:

```
Event | GT | V1_n | V1_asgn | V1_cnt | V1_tot | V2_n | V2_asgn | V2_cnt | V2_tot | V3_n | V3_asgn | V3_cnt | V3_tot
```

Uses pre-computed `time_matrix.json` from each event folder (no OSRM/LLM calls).  
Imports `VRPSolver` from `optimizer.py`, `HumanStyleSolver` from `optimizer_v2.py`, `SavingsSolver` from `optimizer_savings.py`.  
Imports scoring functions from `tests/evaluate_realSuite.py`.

Run: `python experiments/savings_solver/evaluate_savings.py`

### `grid_search_savings.py`

Sweeps `min_savings_minutes ∈ {0, 5, 10, 15, 20}` across all 29 events.  
Columns: `V1 | S=0 | S=5 | S=10 | S=15 | S=20` (same layout as existing grid search).  
Shows MEAN, MEAN_ASGN, MEAN_CNT rows.

Run: `python experiments/savings_solver/grid_search_savings.py`

---

## Promotion Path

If `SavingsSolver` wins:
1. Copy `_compute_savings` + `_savings_cluster` into `optimizer_v2.py`
2. Replace `HumanStyleSolver` internals (Steps 1+2 only; keep Steps 3–5 unchanged)
3. Rename `min_savings_minutes` → `cluster_threshold_minutes` in the public API for backwards compatibility
4. Delete `experiments/savings_solver/`

If it loses:
1. `rm -rf experiments/savings_solver/`

---

## Out of Scope

- No changes to `optimizer.py`, `optimizer_v2.py`, `app.py`, or any test file
- No frontend changes
- No new pytest tests (this is an experiment, not a feature)
- No OSRM or LLM calls during evaluation
