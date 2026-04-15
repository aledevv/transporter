# Compare Tool Multi-Solver Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a V1 / V1-improved / V2 solver dropdown to the compare tool so any solver's plan can be compared side-by-side with the ground truth without re-running anything.

**Architecture:** All three solver plans are pre-computed by `tools/run_compare.py` and embedded in each `<slug>.json` under a `planners` dict. The frontend reads whichever planner key is active and re-renders in-memory — no extra HTTP requests. Solver selection persists in `localStorage`.

**Tech Stack:** Python 3 / OR-Tools (`ImprovedVRPSolver` from `experiments/v1_improved/`), static HTML+JS compare tool, pre-computed JSON data files.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `experiments/__init__.py` | Create | Package marker so `experiments.v1_improved` is importable |
| `experiments/v1_improved/__init__.py` | Create | Package marker |
| `experiments/v1_improved/optimizer_v1_improved.py` | Create | `ImprovedVRPSolver` class |
| `experiments/v1_improved/grid_search.py` | Create | Grid-search script (already working in worktree) |
| `tools/run_compare.py` | Modify | Run all 3 solvers; output `planners` dict |
| `tools/compare/index.html` | Modify | Add `<select id="solverSelect">`, `setActiveSolver()`, update column header |
| `tools/compare/data/*.json` | Regenerated | Output of `run_compare.py` |
| `tests/test_run_compare.py` | Create | Unit tests for updated `process_event()` output shape |

---

## Task 0: Copy v1-improved experiment files from worktree to main

**Files:**
- Create: `experiments/__init__.py`
- Create: `experiments/v1_improved/__init__.py`
- Create: `experiments/v1_improved/optimizer_v1_improved.py`
- Create: `experiments/v1_improved/grid_search.py`

The `ImprovedVRPSolver` and grid-search code were developed in the worktree `.worktrees/feature/v1-improved/` but never committed. Copy them to the main project directory.

- [ ] **Step 1: Copy optimizer and grid_search files**

```bash
mkdir -p experiments/v1_improved
touch experiments/__init__.py
touch experiments/v1_improved/__init__.py
cp .worktrees/feature/v1-improved/experiments/v1_improved/optimizer_v1_improved.py \
   experiments/v1_improved/optimizer_v1_improved.py
cp .worktrees/feature/v1-improved/experiments/v1_improved/grid_search.py \
   experiments/v1_improved/grid_search.py
```

- [ ] **Step 2: Verify import works from project root**

```bash
python3 -c "from experiments.v1_improved.optimizer_v1_improved import ImprovedVRPSolver; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add experiments/
git commit -m "feat(v1-improved): add ImprovedVRPSolver and grid_search to experiments/"
```

---

## Task 1: Write failing tests for the updated process_event() output shape

**Files:**
- Create: `tests/test_run_compare.py`

The current `process_event()` returns `matched_pairs`, `unmatched_planner`, `unmatched_gt`, `scores` at the root. After this feature, it must return those under a `planners` dict.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_run_compare.py`:

```python
"""Tests for the updated run_compare.process_event() multi-solver output."""
from __future__ import annotations

import json
from pathlib import Path
import pytest

TESTS_DIR = Path(__file__).parent
REALSUITE_DIR = TESTS_DIR / "realSuite"
import sys
sys.path.insert(0, str(TESTS_DIR.parent))

# Pick the first complete event fixture for testing
def _first_complete_ev_dir() -> Path | None:
    for ev_dir in sorted(REALSUITE_DIR.iterdir()):
        if not ev_dir.is_dir():
            continue
        needed = ["config.json", "time_matrix.json"]
        if any(Path(ev_dir, f).exists() for f in needed):
            gt_files = list(ev_dir.glob("*.xlsx"))
            if gt_files:
                return ev_dir
    return None


EV_DIR = _first_complete_ev_dir()


@pytest.mark.skipif(EV_DIR is None, reason="No complete realSuite fixture found")
def test_process_event_returns_planners_dict():
    """process_event() must return a 'planners' key with v1, v2 entries."""
    from tools.run_compare import process_event
    result = process_event(EV_DIR)
    assert result is not None, "process_event() returned None for complete fixture"
    assert "planners" in result, "Missing 'planners' key in result"
    assert "v2" in result["planners"], "Missing 'v2' in planners"
    assert "v1" in result["planners"], "Missing 'v1' in planners"


@pytest.mark.skipif(EV_DIR is None, reason="No complete realSuite fixture found")
def test_process_event_planner_has_required_fields():
    """Each planner entry must have matched_pairs, unmatched_planner, unmatched_gt, scores."""
    from tools.run_compare import process_event
    result = process_event(EV_DIR)
    assert result is not None
    for key in ("v1", "v2"):
        if key not in result["planners"]:
            continue
        p = result["planners"][key]
        assert "matched_pairs" in p, f"{key} missing matched_pairs"
        assert "unmatched_planner" in p, f"{key} missing unmatched_planner"
        assert "unmatched_gt" in p, f"{key} missing unmatched_gt"
        assert "scores" in p, f"{key} missing scores"
        s = p["scores"]
        assert "assignment" in s and "bus_count" in s and "combined" in s


@pytest.mark.skipif(EV_DIR is None, reason="No complete realSuite fixture found")
def test_process_event_root_has_no_legacy_scores():
    """Root-level 'scores', 'matched_pairs', 'unmatched_planner' must not exist anymore."""
    from tools.run_compare import process_event
    result = process_event(EV_DIR)
    assert result is not None
    assert "scores" not in result, "Legacy 'scores' still at root — move it under planners"
    assert "matched_pairs" not in result, "Legacy 'matched_pairs' still at root"
    assert "unmatched_planner" not in result, "Legacy 'unmatched_planner' still at root"


@pytest.mark.skipif(EV_DIR is None, reason="No complete realSuite fixture found")
def test_process_event_shared_fields_present():
    """event, arrival_time, destination must stay at root level."""
    from tools.run_compare import process_event
    result = process_event(EV_DIR)
    assert result is not None
    assert "event" in result
    assert "arrival_time" in result
    assert "destination" in result
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
pytest tests/test_run_compare.py -v
```

Expected: `test_process_event_returns_planners_dict` FAILS — `KeyError: 'planners'` (old structure).

---

## Task 2: Update tools/run_compare.py — multi-solver output

**Files:**
- Modify: `tools/run_compare.py`

Replace the single `run_v2` call with a loop over all three solvers. Each solver's result goes under `planners[key]`. `unmatched_gt` moves inside each planner entry (it depends on the solver's matching).

- [ ] **Step 1: Add imports at top of tools/run_compare.py**

Replace the current imports block (lines 23–39) with:

```python
import math

from evaluate_realSuite import (
    combined_score,
    load_event,
    load_groundtruth,
    run_v1,
    run_v2,
    score_assignment,
    score_bus_count,
    solution_to_buses,
)
from tools.compare_lib import (
    compute_gt_route_distances,
    derive_arrival_time,
    enrich_gt_with_coords,
    format_planner_routes,
    load_groundtruth_full,
    match_buses,
)
from experiments.v1_improved.optimizer_v1_improved import ImprovedVRPSolver
```

- [ ] **Step 2: Add haversine + distance-matrix loader helper after the `_load_config` function**

Add after `_load_config()` (before `process_event()`):

```python
def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> int:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    return int(R * 2 * math.asin(math.sqrt(a)))


def _load_distance_matrix(ev_dir: Path, schools: list[dict], coords: dict, config: dict) -> list[list[int]] | None:
    """Load distance_matrix.json if present; fall back to haversine from coords.json + config."""
    p = ev_dir / "distance_matrix.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    dest_lat = config.get("destination_lat")
    dest_lon = config.get("destination_lon")
    if dest_lat is None or dest_lon is None:
        return None
    locations: list[tuple[float, float]] = [(dest_lat, dest_lon)]
    for s in schools:
        c = coords.get(s["name"])
        if c is None:
            return None
        locations.append((c["lat"], c["lon"]))
    n = len(schools)
    matrix: list[list[int]] = []
    for i in range(n + 1):
        row = []
        for j in range(n + 1):
            if i == j:
                row.append(0)
            else:
                lat1, lon1 = locations[i]
                lat2, lon2 = locations[j]
                row.append(_haversine_m(lat1, lon1, lat2, lon2))
        matrix.append(row)
    return matrix
```

- [ ] **Step 3: Add _run_v1_improved() helper after _load_distance_matrix()**

```python
def _run_v1_improved(ev: dict, dist_matrix_full: list[list[int]]) -> dict | None:
    """Run ImprovedVRPSolver on one event using spec defaults."""
    from evaluate_realSuite import _build_solver_matrix
    schools = ev["schools"]
    n = len(schools)
    capacity = ev["capacity"]
    arrival_time_str = ev.get("arrival_time", "12:00")

    time_matrix = _build_solver_matrix(ev["time_matrix"], n)
    dm_ext = [row[:] + [0] for row in dist_matrix_full]
    dm_ext.append([0] * (n + 2))

    demands = [0] + [s["demand"] for s in schools] + [0]
    total = sum(s["demand"] for s in schools)
    num_vehicles = math.ceil(total / capacity) + 3
    dummy_idx = n + 1

    solver = ImprovedVRPSolver(fixed_vehicle_cost=600, time_limit_seconds=30)
    return solver.solve(
        time_matrix=time_matrix,
        distance_matrix=dm_ext,
        demands=demands,
        num_vehicles=num_vehicles,
        starts=[dummy_idx] * num_vehicles,
        ends=[0] * num_vehicles,
        arrival_time_str=arrival_time_str,
        bus_capacity=capacity,
    )
```

- [ ] **Step 4: Add _run_solver_plan() helper — formats one solver's output**

```python
def _run_solver_plan(
    key: str,
    ev: dict,
    ev_dir: Path,
    coords: dict,
    config: dict,
    gt_simple: dict,
    gt_full: dict,
    arrival_time: str,
    dist_matrix_full: list[list[int]] | None,
    distance_matrix_for_fmt: list[list[int]] | None,
) -> dict | None:
    """Run one solver and return {matched_pairs, unmatched_planner, unmatched_gt, scores} or None."""
    if key == "v2":
        solution = run_v2(ev)
    elif key == "v1":
        solution = run_v1(ev)
    elif key == "v1improved":
        if dist_matrix_full is None:
            print(f"  [warn] v1improved skipped for {ev_dir.name}: no distance matrix")
            return None
        solution = _run_v1_improved(ev, dist_matrix_full)
    else:
        return None

    if solution is None:
        print(f"  [warn] {key} solver returned None for {ev_dir.name}")
        return None

    pred_buses = solution_to_buses(solution, ev["schools"])
    asgn  = score_assignment(pred_buses, gt_simple)
    cnt   = score_bus_count(pred_buses, gt_simple)
    comb  = combined_score(pred_buses, gt_simple)

    planner_routes = format_planner_routes(
        solution, ev["schools"], ev["time_matrix"], coords, arrival_time, distance_matrix_for_fmt
    )
    pairs, unmatched_p, unmatched_gt_ids = match_buses(pred_buses, gt_simple)
    planner_by_id = {str(r["vehicle_id"]): r for r in planner_routes}
    gt_by_fin = gt_full

    matched_pairs = []
    for pair in pairs:
        p_route = planner_by_id.get(pair["p_id"])
        g_bus = gt_by_fin.get(pair["gt_id"])
        matched_pairs.append({
            "jaccard": pair["jaccard"],
            "planner": p_route or {"vehicle_id": pair["p_id"], "stops": [], "distance_km": 0},
            "gt": g_bus or {"stops": [], "distance_km": None},
            "gt_fin": pair["gt_id"],
        })

    unmatched_planner_list = [planner_by_id[pid] for pid in unmatched_p if pid in planner_by_id]
    unmatched_gt_list = [{**gt_by_fin[gid], "fin": gid} for gid in unmatched_gt_ids if gid in gt_by_fin]

    return {
        "matched_pairs": matched_pairs,
        "unmatched_planner": unmatched_planner_list,
        "unmatched_gt": unmatched_gt_list,
        "scores": {
            "assignment": round(asgn, 4),
            "bus_count": round(cnt, 4),
            "combined": round(comb, 4),
        },
    }
```

- [ ] **Step 5: Replace process_event() with the new multi-solver version**

Replace the entire `process_event()` function with:

```python
def process_event(ev_dir: Path) -> dict | None:
    """Run all 3 solvers on one event, return comparison data with planners dict."""
    ev = load_event(ev_dir)
    if ev is None:
        return None

    coords = _load_coords(ev_dir)
    config = _load_config(ev_dir)

    # GT data shared across solvers
    _gt_raw = load_groundtruth(ev["gt_path"])
    gt_simple = {}
    for k, v in _gt_raw.items():
        try:
            gt_simple[str(int(float(k)))] = v
        except (ValueError, TypeError):
            gt_simple[k] = v
    gt_full = load_groundtruth_full(ev["gt_path"])
    gt_full = enrich_gt_with_coords(gt_full, coords)

    # Distance matrices
    dist_matrix_path = ev_dir / "distance_matrix.json"
    distance_matrix_for_fmt = (
        json.loads(dist_matrix_path.read_text(encoding="utf-8"))
        if dist_matrix_path.exists() else None
    )
    dist_matrix_full = _load_distance_matrix(ev_dir, ev["schools"], coords, config)
    if distance_matrix_for_fmt is not None:
        gt_full = compute_gt_route_distances(gt_full, ev["schools"], distance_matrix_for_fmt)

    # Arrival time
    if config.get("arrival_time"):
        arrival_time = config["arrival_time"]
    else:
        arrival_time = derive_arrival_time(gt_full, ev["schools"], ev["time_matrix"])
        config_path = ev_dir / "config.json"
        config["arrival_time"] = arrival_time
        config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")

    # Run all solvers
    # Note: pass arrival_time into ev so _run_v1_improved can read it
    ev_with_time = {**ev, "arrival_time": arrival_time}

    planners: dict = {}
    for key in ("v2", "v1", "v1improved"):
        result = _run_solver_plan(
            key=key,
            ev=ev_with_time,
            ev_dir=ev_dir,
            coords=coords,
            config=config,
            gt_simple=gt_simple,
            gt_full=gt_full,
            arrival_time=arrival_time,
            dist_matrix_full=dist_matrix_full,
            distance_matrix_for_fmt=distance_matrix_for_fmt,
        )
        if result is not None:
            planners[key] = result

    if not planners:
        print(f"  [warn] all solvers failed for {ev_dir.name}")
        return None

    destination = {
        "name": config.get("destination", ""),
        "lat": config.get("destination_lat"),
        "lon": config.get("destination_lon"),
    }

    return {
        "event": {
            "name": ev_dir.name,
            "destination": config.get("destination", ""),
            "capacity": ev["capacity"],
        },
        "arrival_time": arrival_time,
        "destination": destination,
        "planners": planners,
    }
```

- [ ] **Step 6: Update main() — index.json scores per-solver**

Replace the `index.append(...)` block in `main()`:

```python
        # Build per-solver scores for index
        index_scores = {
            key: p["scores"]
            for key, p in data["planners"].items()
        }
        v2_combined = data["planners"].get("v2", {}).get("scores", {}).get("combined", 0.0)

        index.append({
            "slug": slug,
            "name": ev_dir.name,
            "destination": data["event"]["destination"],
            "scores": index_scores,
        })
        print(f"done → {out_path.name}  (v2 combined={v2_combined:.3f})")
```

---

## Task 3: Run tests — green; regenerate data JSONs

- [ ] **Step 1: Run tests**

```bash
pytest tests/test_run_compare.py -v
```

Expected: all 4 tests PASS.

- [ ] **Step 2: Regenerate compare data (may take a few minutes)**

```bash
python3 tools/run_compare.py
```

Expected: each event line prints `done → <slug>.json  (v2 combined=X.XXX)`. No errors.

- [ ] **Step 3: Spot-check one JSON file**

```bash
python3 -c "
import json
from pathlib import Path
d = next(Path('tools/compare/data').glob('*.json'))
data = json.loads(d.read_text())
print('planners keys:', list(data.get('planners', {}).keys()))
print('has arrival_time:', 'arrival_time' in data)
print('has destination:', 'destination' in data)
"
```

Expected output contains `planners keys: ['v2', 'v1', 'v1improved']` (order may vary; v1improved may be absent if haversine fallback is unavailable).

- [ ] **Step 4: Commit**

```bash
git add tools/run_compare.py tools/compare/data/ tests/test_run_compare.py
git commit -m "feat(compare): run all 3 solvers in run_compare; restructure output under planners"
```

---

## Task 4: Update tools/compare/index.html — solver dropdown + setActiveSolver()

**Files:**
- Modify: `tools/compare/index.html`

Add the solver `<select>` to the topbar, wire up `setActiveSolver()`, and update the column header label.

- [ ] **Step 1: Add solver <select> to topbar**

In `tools/compare/index.html`, find the topbar block (around line 132–143):

```html
<div id="topbar">
  <span class="logo">BusPlan Compare</span>
  <button class="nav-btn" id="prevBtn" title="Evento precedente (←)" onclick="navigateEvent(-1)">&#8249;</button>
  <select id="evSelect"><option value="">— scegli un evento —</option></select>
  <button class="nav-btn" id="nextBtn" title="Evento successivo (→)" onclick="navigateEvent(1)">&#8250;</button>
  <label class="arrow-toggle" title="Mostra/nascondi frecce di direzione">
    <input type="checkbox" id="arrowToggle" checked onchange="toggleArrows(this.checked)">
    <span class="track"></span>
    Frecce
  </label>
  <div id="scoreChips" style="display:none;display:flex;gap:8px;flex-wrap:wrap"></div>
</div>
```

Replace with:

```html
<div id="topbar">
  <span class="logo">BusPlan Compare</span>
  <button class="nav-btn" id="prevBtn" title="Evento precedente (←)" onclick="navigateEvent(-1)">&#8249;</button>
  <select id="evSelect"><option value="">— scegli un evento —</option></select>
  <button class="nav-btn" id="nextBtn" title="Evento successivo (→)" onclick="navigateEvent(1)">&#8250;</button>
  <label style="color:#475569;font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-left:6px">Solver</label>
  <select id="solverSelect" onchange="setActiveSolver(this.value)">
    <option value="v2">V2 — Human-style</option>
    <option value="v1">V1 — OR-Tools</option>
    <option value="v1improved">V1-improved</option>
  </select>
  <label class="arrow-toggle" title="Mostra/nascondi frecce di direzione">
    <input type="checkbox" id="arrowToggle" checked onchange="toggleArrows(this.checked)">
    <span class="track"></span>
    Frecce
  </label>
  <div id="scoreChips" style="display:none;display:flex;gap:8px;flex-wrap:wrap"></div>
</div>
```

- [ ] **Step 2: Add currentData, currentSolver, SOLVER_LABELS globals near the top of the <script> block**

Find the JS variable declarations near the top of the `<script>` block (look for `let currentSlug`, `let currentData`, etc.). Add/ensure these lines exist:

```js
let currentData  = null;
let currentSolver = 'v2';
const SOLVER_LABELS = {
  v1:        'V1 — OR-TOOLS',
  v2:        'V2 — HUMAN-STYLE',
  v1improved:'V1-IMPROVED',
};
const BUSPLAN_SOLVER_KEY = 'busplan_solver';
```

- [ ] **Step 3: Add setActiveSolver() function**

Add after `renderSummary()` (or near the other render functions):

```js
function setActiveSolver(key) {
  if (!currentData) return;
  const plannerData = currentData.planners && currentData.planners[key];
  if (!plannerData) {
    console.warn('Solver', key, 'not available for this event — falling back to v2');
    key = 'v2';
  }
  currentSolver = key;
  document.getElementById('solverSelect').value = key;
  try { localStorage.setItem(BUSPLAN_SOLVER_KEY, key); } catch (_) {}
  const pd = currentData.planners[key];
  renderEvent({
    ...currentData,
    matched_pairs:     pd.matched_pairs,
    unmatched_planner: pd.unmatched_planner,
    unmatched_gt:      pd.unmatched_gt,
    scores:            pd.scores,
  });
}
```

- [ ] **Step 4: Update loadEvent() to use setActiveSolver() instead of renderEvent()**

Find `loadEvent()` (around line 439). Replace:

```js
  fetch(`data/${slug}.json`)
    .then(r => r.json())
    .then(data => renderEvent(data));
```

With:

```js
  fetch(`data/${slug}.json`)
    .then(r => r.json())
    .then(data => {
      currentData = data;
      const savedSolver = (() => { try { return localStorage.getItem(BUSPLAN_SOLVER_KEY); } catch(_){} return null; })();
      setActiveSolver(savedSolver || 'v2');
    });
```

- [ ] **Step 5: Update column header to show active solver name**

Find the `renderEvent()` function. After the line that sets `document.getElementById('pSummary')`, find where `<span>Planner V2</span>` would be referenced. The column header `<span>Planner V2</span>` is static HTML (line 147). Update `renderEvent()` to dynamically set the planner column header text:

In `renderEvent()`, add after `document.getElementById('pSummary').textContent = ...`:

```js
  const phSpan = document.querySelector('#colheaders .colh.ph > span:first-child');
  if (phSpan) phSpan.textContent = SOLVER_LABELS[currentSolver] || 'PLANNER';
```

Also update the static HTML for the planner header so the initial text doesn't say "Planner V2" (change it to "PLANNER" as a neutral default):

```html
  <div class="colh ph">
    <span>PLANNER</span><span id="pSummary" class="pill"></span>
  </div>
```

- [ ] **Step 6: Initialise solverSelect from localStorage on page load**

Find the `DOMContentLoaded` listener or the section where `evSelect` is initialised (around where `FB_LAST_SLUG_KEY` is read). Add:

```js
// Restore solver selection
try {
  const saved = localStorage.getItem(BUSPLAN_SOLVER_KEY);
  if (saved) document.getElementById('solverSelect').value = saved;
} catch (_) {}
```

---

## Task 5: Manual browser verification + commit

- [ ] **Step 1: Open compare tool in browser**

Open `tools/compare/index.html` directly in a browser (double-click or `open tools/compare/index.html`).

Expected:
- Topbar shows: logo, `<` prev, event dropdown, `>` next, **Solver** label, solver dropdown (defaulting to "V2 — Human-style"), arrow toggle, score chips.
- Selecting an event renders the left column with a V2 plan.

- [ ] **Step 2: Switch to V1 — OR-Tools**

Change the solver dropdown to "V1 — OR-Tools".

Expected:
- Left column re-renders with V1 plan.
- Column header reads "V1 — OR-TOOLS".
- Score chips update to V1 scores.
- No crash or blank screen.

- [ ] **Step 3: Switch to V1-improved**

Change the solver dropdown to "V1-improved".

Expected:
- Left column re-renders with V1-improved plan (or falls back to V2 gracefully if data is absent, with a console warning).

- [ ] **Step 4: Verify localStorage persistence**

Reload the page.

Expected: the solver dropdown still shows the last-selected solver.

- [ ] **Step 5: Commit**

```bash
git add tools/compare/index.html
git commit -m "feat(compare): add solver dropdown (V1/V1-improved/V2) with localStorage persistence"
```

---

## Self-Review

**Spec coverage:**
- ✅ Pre-computed all solver plans embedded in JSON — Task 2 (process_event loop)
- ✅ `planners` dict structure with per-solver `matched_pairs`, `unmatched_planner`, `unmatched_gt`, `scores` — Task 2 Step 4/5
- ✅ `index.json` per-solver scores — Task 2 Step 6
- ✅ Solver `<select>` in topbar with V2 default — Task 4 Step 1
- ✅ `setActiveSolver(key)` with fallback to v2 — Task 4 Step 3
- ✅ `loadEvent()` stores full data in `currentData`, calls `setActiveSolver` — Task 4 Step 4
- ✅ Column header updated to active solver name — Task 4 Step 5
- ✅ `localStorage` persistence — Task 4 Steps 2, 6
- ✅ v1improved falls back gracefully if distance matrix unavailable — Task 2 Step 5 (`_run_v1_improved` returns None, solver logged and skipped)
- ✅ V1 import from evaluate_realSuite — Task 2 Step 1

**Deviation from spec:** The spec puts `unmatched_gt` at the root of the per-event JSON. This plan moves it inside each `planners[key]` entry because `unmatched_gt` depends on each solver's matching output (different solvers match different buses). The `setActiveSolver()` spreads `unmatched_gt` from the active planner when calling `renderEvent()`.

**Type consistency check:** `_run_solver_plan` returns `dict | None`; called with `key` ∈ `{"v2","v1","v1improved"}` throughout. `setActiveSolver` keys must match exactly — confirmed `"v1improved"` (no hyphen in Python key, matches JS `planners` key). `SOLVER_LABELS` uses same three keys.
