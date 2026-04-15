# Design: Multi-Solver Selector in Compare Tool

**Date:** 2026-04-15
**Status:** Approved

---

## Context

The compare tool (`tools/compare/index.html`) currently shows only the V2 (HumanStyleSolver) plan on the left column, matched against the human ground truth on the right. Now that V1 (OR-Tools VRPSolver) and V1-improved (distance-objective + soft time windows) exist, users need a way to switch between solver versions to compare their plans side-by-side with the ground truth and provide targeted feedback.

---

## Decision

**Option chosen:** Pre-compute all solver plans and embed them in the existing per-event JSON. Switching solvers loads from in-memory data — no extra HTTP requests, no server required.

---

## Data Format

### Per-event JSON (`tools/compare/data/<slug>.json`)

Shared top-level fields (GT data, destination, arrival time) remain unchanged. A new `planners` object contains one entry per solver:

```json
{
  "event":        { "name": "...", "destination": "...", "capacity": 54 },
  "arrival_time": "12:00",
  "destination":  { "name": "...", "lat": 0.0, "lon": 0.0 },
  "unmatched_gt": [ ... ],
  "planners": {
    "v2":         { "matched_pairs": [...], "unmatched_planner": [...], "scores": { "assignment": 0.0, "bus_count": 0.0, "combined": 0.0 } },
    "v1":         { "matched_pairs": [...], "unmatched_planner": [...], "scores": { ... } },
    "v1improved": { "matched_pairs": [...], "unmatched_planner": [...], "scores": { ... } }
  }
}
```

`matched_pairs` and `unmatched_planner` keep the same structure as today — the only structural change is moving them under `planners[key]` instead of at the top level.

### Index JSON (`tools/compare/data/index.json`)

Each entry's `scores` field changes from a single object to a per-solver map:

```json
{
  "slug": "basket-cadetti-...",
  "name": "Basket-cadetti_...",
  "destination": "...",
  "scores": {
    "v1":         { "assignment": 0.0, "bus_count": 0.0, "combined": 0.0 },
    "v2":         { "assignment": 0.0, "bus_count": 0.0, "combined": 0.0 },
    "v1improved": { "assignment": 0.0, "bus_count": 0.0, "combined": 0.0 }
  }
}
```

---

## Backend — `tools/run_compare.py`

### New helper: `_run_solver_plan(solver_key, ev, coords, config, gt_simple, gt_full, distance_matrix)`

Runs the appropriate solver and returns `{ matched_pairs, unmatched_planner, scores }`.

Solver dispatch:
- `"v2"` — calls `run_v2(ev)` (already imported from `evaluate_realSuite`)
- `"v1"` — calls `run_v1(ev)` (add import from `evaluate_realSuite`)
- `"v1improved"` — calls a local `_run_v1_improved(ev, distance_matrix)`:
  - Loads `distance_matrix.json` if present, else computes haversine from `coords.json` + `config.json` destination lat/lon (same logic as `grid_search.py`)
  - Uses `ImprovedVRPSolver(fixed_vehicle_cost=600, time_limit_seconds=30)` (spec defaults)
  - If distance matrix unavailable, logs a warning and returns `None` (event shows no V1-improved data)

All three solvers return the same solution dict shape — `format_planner_routes`, `match_buses`, and scoring functions are called identically for each.

### `process_event()` changes

Replace the single `run_v2` call with a loop over `["v2", "v1", "v1improved"]`, collecting results into `planners`. Skip a solver gracefully (log warning, omit key) if its runner returns `None`.

Return structure updated: `matched_pairs` / `unmatched_planner` / top-level `scores` are removed from the root and replaced with the `planners` dict.

### `main()` changes

`index.json` entries: `scores` field updated to the per-solver map. The event summary score shown in the dropdown list uses `v2.combined` (existing behaviour) as default.

---

## Frontend — `tools/compare/index.html`

### 1. Topbar — solver `<select>`

Add immediately after the `<>` nav buttons:

```html
<label style="...">Solver</label>
<select id="solverSelect">
  <option value="v2">V2 — Human-style</option>
  <option value="v1">V1 — OR-Tools</option>
  <option value="v1improved">V1-improved</option>
</select>
```

Default: `v2` (preserves current behaviour).  
On change: call `setActiveSolver(this.value)`.  
Persist selection in `localStorage` under key `busplan_solver`.

### 2. `loadEvent(slug)`

After fetching and receiving JSON:
- Store full data in `currentData`
- Read `localStorage.getItem('busplan_solver') || 'v2'` → `currentSolver`
- Call `setActiveSolver(currentSolver)` instead of `renderEvent(data)` directly

### 3. `setActiveSolver(key)`

```js
function setActiveSolver(key) {
  if (!currentData) return;
  const plannerData = currentData.planners?.[key];
  if (!plannerData) {
    // solver not available for this event — show notice, fall back to v2
    key = 'v2';
  }
  currentSolver = key;
  document.getElementById('solverSelect').value = key;
  localStorage.setItem('busplan_solver', key);
  // merge planner data with shared GT fields and render
  renderEvent({
    ...currentData,
    matched_pairs:      plannerData.matched_pairs,
    unmatched_planner:  plannerData.unmatched_planner,
    scores:             plannerData.scores,
  });
}
```

### 4. Column header label

`renderEvent()` already sets the planner column header text. Update it to reflect the active solver:

```js
const SOLVER_LABELS = { v1: 'V1 — OR-TOOLS', v2: 'V2 — HUMAN-STYLE', v1improved: 'V1-IMPROVED' };
// set colh.ph text to SOLVER_LABELS[currentSolver] || 'PLANNER'
```

---

## Files Changed

| File | Change |
|------|--------|
| `tools/run_compare.py` | Run all 3 solvers; restructure output under `planners` |
| `tools/compare/index.html` | Add solver `<select>`; add `setActiveSolver()`; update header label |
| `tools/compare/data/*.json` | Regenerated by `run_compare.py` |

**Not changed:** `tools/compare_lib.py`, `evaluate_realSuite.py`, `optimizer.py`, `optimizer_v2.py`, `experiments/`.

---

## Verification

1. `python3 tools/run_compare.py` completes; each `<slug>.json` contains a `planners` key with entries for `v1`, `v2`, and `v1improved`.
2. Opening `tools/compare/index.html` in a browser: solver dropdown visible in topbar, defaults to V2.
3. Switching to V1: left column re-renders with V1 plan, column header reads "V1 — OR-TOOLS", score chips update.
4. Switching to V1-improved: same as above with "V1-IMPROVED" label.
5. Reloading the page: solver selection is preserved via `localStorage`.
6. An event where V1-improved has no data (e.g., distance matrix unavailable): tool falls back to V2 gracefully with no crash.
