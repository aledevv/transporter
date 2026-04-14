# Design: V1-Improved OR-Tools Solver — Distance Objective + Soft Time Windows + Fixed Cost Calibration

**Date:** 2026-04-14  
**Status:** Approved

---

## Context

V2 (HumanStyleSolver) currently scores combined=0.704 vs V1 (OR-Tools VRPSolver) at 0.689. However, combined score measures Jaccard similarity to the human plan — not actual route quality. After adopting `total_km` and `max_route_min` as primary metrics (see design `2026-04-14-v2-optimizer-improvements-design.md`), V1 may recover ground because it is a global optimizer whereas V2 is greedy.

The current V1 has two weaknesses that likely inflate its km and route times:
1. **Arc cost = travel time** — OR-Tools minimizes time, not distance. A bus travelling fast through the highway earns the same "cost" as a short local detour, so the solver may accept geographically inefficient routes.
2. **No early-pickup penalty** — nothing prevents assigning a school that is 5 min from the destination to a bus that starts 3 hours away, forcing that student to ride for 3+ hours. The human planner naturally avoids this; the solver does not.
3. **Fixed vehicle cost uncalibrated** — the penalty for opening a new bus is a single hardcoded value. If too low → too many buses; too high → mega-buses with many stops.

---

## Solution

**File:** `experiments/v1_improved/optimizer_v1_improved.py`

A new class `ImprovedVRPSolver` that inherits the same public interface as the existing `VRPSolver` in `optimizer.py` (i.e., `solve(schools, destination, distance_matrix, time_matrix, bus_capacity, arrival_time_str, time_mode)` → same response dict shape). The three changes are self-contained and additive.

---

## Algorithm Details

### 1. Distance-based arc cost

Replace `time_matrix` arc costs with `distance_matrix` arc costs for `SetArcCostEvaluatorOfAllVehicles`. The time matrix is still used for a **separate time dimension** (needed for departure time calculation and time windows).

```python
# Arc cost = distance (metres or km, already in distance_matrix)
distance_callback = lambda i, j: distance_matrix[manager.IndexToNode(i)][manager.IndexToNode(j)]
transit_callback_index = routing.RegisterTransitCallback(distance_callback)
routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

# Time dimension (for departure time calculation and soft time windows)
time_callback = lambda i, j: time_matrix[manager.IndexToNode(i)][manager.IndexToNode(j)]
time_transit_index = routing.RegisterTransitCallback(time_callback)
routing.AddDimension(time_transit_index, 0, MAX_TIME_SECONDS, False, "Time")
```

### 2. Soft time windows (max wait cap)

For each school `i`, compute the ideal departure time assuming the school is the **last** pickup before the destination:

```
ideal_departure_i = arrival_time_seconds - time_matrix[i][destination] 
```

Apply a **soft lower bound** on the cumulative time variable: no penalty if the bus arrives at school `i` later than `ideal_departure_i - slack_seconds`; penalty accrues if it arrives earlier (student waits longer than `slack_minutes` beyond the direct-trip baseline).

```python
time_dim = routing.GetDimensionOrDie("Time")
slack_seconds = slack_minutes * 60   # default: 20 min
penalty_per_second = penalty_per_minute / 60   # default: 1000/min

for school_idx in range(num_schools):
    ideal_dep = arrival_time_seconds - time_matrix[school_idx][destination_idx]
    soft_lb = max(0, ideal_dep - slack_seconds)
    node_index = manager.NodeToIndex(school_idx)
    time_dim.SetCumulVarSoftLowerBound(node_index, soft_lb, penalty_per_second)

# Hard upper bound at destination: must arrive by arrival_time_seconds
dest_index = manager.NodeToIndex(destination_idx)
time_dim.CumulVar(dest_index).SetMax(arrival_time_seconds)
```

**Why this scales:**
- Ski events: all schools depart early → tight ideal windows → no penalty even for long routes.
- Bad merge (close school on a far-north bus): ideal_dep is late but bus arrives very early → large penalty → solver avoids it.
- `slack_minutes=20` matches the user preference: students tolerate at most 20 extra minutes beyond the direct-trip time.

### 3. Fixed vehicle cost calibration

The fixed vehicle cost is swept in the grid search (see below). The parameter maps directly to `routing.SetFixedCostOfAllVehicles(fixed_cost)`.

The cost unit is the same as arc costs (distance units). To make the penalty interpretable: a `fixed_cost = 600` with distance in km means "opening a new bus is worth 600 km of arc savings."

---

## Grid Search

**File:** `experiments/v1_improved/grid_search.py`

Sweeps:
```
fixed_vehicle_cost   : [300, 600, 1200, 2400]   (distance units)
time_limit_seconds   : [20, 30]
slack_minutes        : 20  (fixed — derived from user preference)
penalty_per_minute   : 1000  (fixed — high enough to outweigh short detours)
```

8 combinations + V1-current + V2-current as baselines = 10 rows total.

For each combination, aggregated over all 29 events:
- `combined` — mean combined score (0.6×assignment + 0.4×bus_count)
- `tot_km` — total km summed across all events and all buses
- `max_min` — maximum single-route duration across all events

Output format:
```
config                 combined  tot_km   max_min
V1 (current)           0.689     XXXX     XXX
V2 (current)           0.704     XXXX     XXX
fvc=300  / tl=20       …         …        …
fvc=600  / tl=20       …         …        …
…
```

**Verdict criterion:** Choose the configuration that minimises `tot_km` without losing more than 0.015 combined score vs V2-current. The chosen `(fixed_vehicle_cost, time_limit_seconds)` become the defaults for `ImprovedVRPSolver`.

---

## API

```python
class ImprovedVRPSolver:
    def __init__(
        self,
        bus_capacity: int = 54,
        fixed_vehicle_cost: int = 600,   # calibrated by grid search
        slack_minutes: int = 20,
        penalty_per_minute: int = 1000,
        time_limit_seconds: int = 30,
    ): ...

    def solve(
        self,
        schools,
        destination,
        distance_matrix,
        time_matrix,
        bus_capacity,
        arrival_time_str,
        time_mode="arrival",
    ) -> dict: ...
```

Response dict shape is identical to `VRPSolver.solve()` — same keys (`buses`, `unassigned`, `stats`). This allows drop-in substitution in `app.py` and in `evaluate_realSuite.py` without changes to consumers.

---

## File Layout

```
experiments/v1_improved/
  __init__.py                  (empty)
  optimizer_v1_improved.py     (ImprovedVRPSolver class)
  grid_search.py               (sweep script, standalone)
```

**Not modified:** `optimizer.py`, `optimizer_v2.py`, `app.py`, `tools/`, `tests/test_*.py`, frontend.

`tests/evaluate_realSuite.py` is used read-only by the grid search (imports `evaluate_event`, `compute_route_metrics`). No changes required to the test file for this experiment.

---

## Verification

1. `python3 experiments/v1_improved/grid_search.py` completes without errors; prints table with 10 rows.
2. The `V1-current` row matches the combined score from `tests/evaluate_realSuite.py` (0.689 ± 0.005 tolerance for any OR-Tools non-determinism).
3. At least one `(fixed_vehicle_cost, time_limit_seconds)` combination beats V1-current on `tot_km`.
4. A school that is 5 min from the destination is no longer placed on a bus that departs 3+ hours before arrival (spot-check on Ragazzi / Cadetti events).
5. `pytest tests/ -v` passes without regressions.
