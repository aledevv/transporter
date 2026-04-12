# Planner vs Ground Truth Comparison Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone developer tool (`tools/compare/index.html`) to compare V2 planner outputs against ground truth plans, with side-by-side Leaflet maps and bus-level diffs.

**Architecture:** A pre-computation script (`tools/run_compare.py`) iterates over all complete `tests/realSuite/` fixtures, calls `run_v2()` from the existing `evaluate_realSuite.py`, formats the routes with departure times, matches planner buses to GT buses using Hungarian algorithm, and writes JSON to `tools/compare/data/`. A standalone HTML page loads these JSON files via `fetch()` and renders the comparison UI.

**Tech Stack:** Python 3 (pandas, scipy, numpy, json), HumanStyleSolver from `optimizer_v2.py`, Leaflet.js 1.9 (CDN), vanilla JS/CSS.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `tools/__init__.py` | Create | Makes `tools` a Python package |
| `tools/compare_lib.py` | Create | Pure utility functions: GT loader, coord resolver, bus matcher, route formatter |
| `tools/run_compare.py` | Create | CLI script: iterate fixtures → solve → format → write JSON |
| `tools/compare/index.html` | Create | Standalone comparison UI (Leaflet + vanilla JS) |
| `tools/compare/data/.gitkeep` | Create | Ensures data/ dir is tracked in git |
| `tests/test_compare_lib.py` | Create | Unit tests for compare_lib |

---

## Task 1: Project skeleton + GT full loader

**Files:**
- Create: `tools/__init__.py`
- Create: `tools/compare_lib.py`
- Create: `tools/compare/data/.gitkeep`
- Create: `tests/test_compare_lib.py`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p tools/compare/data
touch tools/__init__.py
touch tools/compare/data/.gitkeep
```

- [ ] **Step 2: Write failing test**

```python
# tests/test_compare_lib.py
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from tools.compare_lib import load_groundtruth_full

def test_load_groundtruth_full_returns_structured_buses():
    gt_files = list((ROOT / "tests/realSuite").glob("*/groundtruth.xlsx"))
    assert gt_files, "No groundtruth.xlsx found in realSuite"
    result = load_groundtruth_full(gt_files[0])
    assert isinstance(result, dict)
    assert len(result) > 0
    fin, bus = next(iter(result.items()))
    assert "stops" in bus
    assert "distance_km" in bus
    assert len(bus["stops"]) > 0
    stop = bus["stops"][0]
    assert "name" in stop
    assert "luogo_ritrovo" in stop
    assert "departure_time" in stop
    assert "return_time" in stop
    assert "count" in stop

def test_load_groundtruth_full_no_empty_bus_names():
    gt_files = list((ROOT / "tests/realSuite").glob("*/groundtruth.xlsx"))
    result = load_groundtruth_full(gt_files[0])
    for fin, bus in result.items():
        for stop in bus["stops"]:
            assert stop["name"], f"Bus {fin} has a stop with empty name"
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd /Users/dev/Desktop/busplan
pytest tests/test_compare_lib.py -v
```

Expected: `ModuleNotFoundError: No module named 'tools.compare_lib'`

- [ ] **Step 4: Create `tools/compare_lib.py` with `load_groundtruth_full`**

```python
# tools/compare_lib.py
"""Utilities for the planner-vs-GT comparison tool."""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment

AVERAGE_SPEED_KMH = 30.0   # must match app.py
STOP_DWELL_TIME_MIN = 3    # must match app.py


def load_groundtruth_full(gt_path: Path) -> dict:
    """
    Parse groundtruth.xlsx into rich per-bus data.

    Returns:
        {
          fin_id: {
            "stops": [{"name", "luogo_ritrovo", "departure_time", "return_time", "count"}],
            "distance_km": float | None
          }
        }
    Stops are ordered by their row position in the Excel (= route order).
    FIN # column may have blank cells below the first row of each bus group;
    ffill() fills them.
    """
    df = pd.read_excel(gt_path, sheet_name="Per Istituto")
    df.columns = [str(c).strip() for c in df.columns]
    df["FIN #"] = df["FIN #"].ffill()

    result: dict = {}
    for fin, group in df.groupby("FIN #", sort=False):
        fin_key = str(int(fin)) if not isinstance(fin, str) and not math.isnan(float(fin)) else str(fin)
        stops = []
        for _, row in group.iterrows():
            name = str(row.get("Istituto", "") or "").strip()
            if not name or name == "nan":
                continue
            stops.append({
                "name": name,
                "luogo_ritrovo": str(row.get("Luogo Ritrovo", "") or "").strip(),
                "departure_time": str(row.get("Orario Partenza", "") or "").strip(),
                "return_time": str(row.get("Rientro Presunto", "") or "").strip(),
                "count": int(row["Persone"]) if pd.notna(row.get("Persone")) else 0,
            })
        km_series = group["Km"].dropna() if "Km" in group.columns else pd.Series([], dtype=float)
        distance_km = float(km_series.iloc[0]) if not km_series.empty else None
        if stops:
            result[fin_key] = {"stops": stops, "distance_km": distance_km}
    return result
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pytest tests/test_compare_lib.py::test_load_groundtruth_full_returns_structured_buses tests/test_compare_lib.py::test_load_groundtruth_full_no_empty_bus_names -v
```

Expected: 2 PASS

- [ ] **Step 6: Commit**

```bash
git add tools/__init__.py tools/compare_lib.py tools/compare/data/.gitkeep tests/test_compare_lib.py
git commit -m "feat(compare): add project skeleton and load_groundtruth_full"
```

---

## Task 2: Coordinate resolver

**Files:**
- Modify: `tools/compare_lib.py`
- Modify: `tests/test_compare_lib.py`

- [ ] **Step 1: Write failing tests**

```python
# append to tests/test_compare_lib.py
from tools.compare_lib import resolve_coords, enrich_gt_with_coords

def test_resolve_coords_exact_match():
    coords = {"IC ALA": {"lat": 45.756, "lon": 11.001}}
    assert resolve_coords("IC ALA", coords) == {"lat": 45.756, "lon": 11.001}

def test_resolve_coords_case_insensitive():
    coords = {"IC ALA": {"lat": 45.756, "lon": 11.001}}
    assert resolve_coords("ic ala ", coords) == {"lat": 45.756, "lon": 11.001}

def test_resolve_coords_missing_returns_none():
    assert resolve_coords("IC UNKNOWN", {"IC ALA": {"lat": 45.756, "lon": 11.001}}) is None

def test_enrich_gt_with_coords_adds_fields():
    gt = {
        "7": {
            "stops": [{"name": "IC ALA", "luogo_ritrovo": "", "departure_time": "09:00", "return_time": "", "count": 10}],
            "distance_km": 50.0,
        }
    }
    coords = {"IC ALA": {"lat": 45.756, "lon": 11.001}}
    result = enrich_gt_with_coords(gt, coords)
    s = result["7"]["stops"][0]
    assert s["lat"] == 45.756
    assert s["lon"] == 11.001
    assert s["coords_missing"] is False

def test_enrich_gt_with_coords_marks_missing():
    gt = {
        "7": {
            "stops": [{"name": "IC UNKNOWN", "luogo_ritrovo": "", "departure_time": "", "return_time": "", "count": 5}],
            "distance_km": None,
        }
    }
    result = enrich_gt_with_coords(gt, {})
    assert result["7"]["stops"][0]["coords_missing"] is True
    assert result["7"]["stops"][0]["lat"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/test_compare_lib.py -k "resolve_coords or enrich_gt" -v
```

Expected: `ImportError` for `resolve_coords`

- [ ] **Step 3: Add `resolve_coords` and `enrich_gt_with_coords` to `tools/compare_lib.py`**

Add after `load_groundtruth_full`:

```python
def resolve_coords(name: str, coords: dict) -> Optional[dict]:
    """
    Match school name to coords dict (from coords.json).
    Returns {"lat": float, "lon": float} or None.
    Tries exact match first, then case-insensitive stripped match.
    """
    if name in coords:
        e = coords[name]
        return {"lat": e["lat"], "lon": e["lon"]}
    normalized = name.strip().lower()
    for key, e in coords.items():
        if key.strip().lower() == normalized:
            return {"lat": e["lat"], "lon": e["lon"]}
    return None


def enrich_gt_with_coords(gt_buses: dict, coords: dict) -> dict:
    """
    Add lat/lon to every GT stop by matching name against coords.json.
    Sets coords_missing=True for any stop without a match.
    Does not mutate gt_buses.
    """
    result = {}
    for fin, bus in gt_buses.items():
        enriched = []
        for stop in bus["stops"]:
            c = resolve_coords(stop["name"], coords)
            enriched.append({
                **stop,
                "lat": c["lat"] if c else None,
                "lon": c["lon"] if c else None,
                "coords_missing": c is None,
            })
        result[fin] = {**bus, "stops": enriched}
    return result
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest tests/test_compare_lib.py -k "resolve_coords or enrich_gt" -v
```

Expected: 5 PASS

- [ ] **Step 5: Commit**

```bash
git add tools/compare_lib.py tests/test_compare_lib.py
git commit -m "feat(compare): add coordinate resolver for GT stops"
```

---

## Task 3: Bus matcher returning pairs

**Files:**
- Modify: `tools/compare_lib.py`
- Modify: `tests/test_compare_lib.py`

- [ ] **Step 1: Write failing tests**

```python
# append to tests/test_compare_lib.py
from tools.compare_lib import match_buses

def test_match_buses_perfect_pair():
    p = {"bus0": {"A", "B", "C"}}
    g = {"fin1": {"A", "B", "C"}}
    pairs, up, ug = match_buses(p, g)
    assert len(pairs) == 1
    assert pairs[0]["jaccard"] == 1.0
    assert pairs[0]["p_id"] == "bus0"
    assert pairs[0]["gt_id"] == "fin1"
    assert up == [] and ug == []

def test_match_buses_unmatched_gt_when_more_gt_buses():
    p = {"bus0": {"A", "B"}}
    g = {"fin1": {"A", "B"}, "fin2": {"C", "D"}}
    pairs, up, ug = match_buses(p, g)
    assert len(pairs) == 1
    assert len(ug) == 1
    assert up == []

def test_match_buses_unmatched_planner_when_more_planner_buses():
    p = {"bus0": {"A", "B"}, "bus1": {"C", "D"}}
    g = {"fin1": {"A", "B"}}
    pairs, up, ug = match_buses(p, g)
    assert len(pairs) == 1
    assert len(up) == 1
    assert ug == []

def test_match_buses_ordered_by_descending_jaccard():
    p = {"bus0": {"A", "B"}, "bus1": {"C"}}
    g = {"fin1": {"A", "B"}, "fin2": {"C", "X", "Y"}}
    pairs, _, _ = match_buses(p, g)
    assert pairs[0]["jaccard"] >= pairs[1]["jaccard"]
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/test_compare_lib.py -k "match_buses" -v
```

Expected: `ImportError` for `match_buses`

- [ ] **Step 3: Add `_jaccard` and `match_buses` to `tools/compare_lib.py`**

Add after `enrich_gt_with_coords`:

```python
def _jaccard(a: set, b: set) -> float:
    union = a | b
    return len(a & b) / len(union) if union else 1.0


def match_buses(planner_buses: dict, gt_buses: dict):
    """
    Match planner buses to GT buses maximising Jaccard similarity.

    Args:
        planner_buses: {bus_id: set(school_names)}
        gt_buses:      {fin_id: set(school_names)}

    Returns:
        (pairs, unmatched_planner, unmatched_gt)
        pairs: [{"p_id": str, "gt_id": str, "jaccard": float}] descending Jaccard
        unmatched_planner: [bus_id, ...] — excess planner buses
        unmatched_gt:      [fin_id, ...]  — excess GT buses
    """
    p_ids = list(planner_buses.keys())
    g_ids = list(gt_buses.keys())
    if not p_ids or not g_ids:
        return [], p_ids[:], g_ids[:]

    n, m = len(p_ids), len(g_ids)
    cost = np.zeros((n, m))
    for i, pid in enumerate(p_ids):
        for j, gid in enumerate(g_ids):
            cost[i, j] = -_jaccard(planner_buses[pid], gt_buses[gid])

    row_ind, col_ind = linear_sum_assignment(cost)
    paired_p, paired_g = set(), set()
    pairs = []
    for r, c in zip(row_ind, col_ind):
        pairs.append({
            "p_id": p_ids[r],
            "gt_id": g_ids[c],
            "jaccard": round(float(-cost[r, c]), 4),
        })
        paired_p.add(p_ids[r])
        paired_g.add(g_ids[c])

    pairs.sort(key=lambda x: x["jaccard"], reverse=True)
    return (
        pairs,
        [p for p in p_ids if p not in paired_p],
        [g for g in g_ids if g not in paired_g],
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest tests/test_compare_lib.py -k "match_buses" -v
```

Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add tools/compare_lib.py tests/test_compare_lib.py
git commit -m "feat(compare): add bus matcher with Hungarian pairing"
```

---

## Task 4: Route formatter with departure times

**Files:**
- Modify: `tools/compare_lib.py`
- Modify: `tests/test_compare_lib.py`

This converts raw VRPSolver/HumanStyleSolver output to the UI-ready format with back-calculated departure times (arrival_time → back-propagate through route).

- [ ] **Step 1: Write failing tests**

```python
# append to tests/test_compare_lib.py
from tools.compare_lib import format_planner_routes, derive_arrival_time

def _make_time_matrix():
    # 4-node matrix: dest=0, A=1, B=2, dummy=3
    # time_matrix.json is (N+1)x(N+1): just dest+schools (no dummy)
    # So raw 3x3: dest=0, A=1, B=2
    #   time_matrix[1][2] = 600  (A→B = 10 min)
    #   time_matrix[2][0] = 1200 (B→dest = 20 min)
    return [
        [0, 1200, 600],   # dest row
        [1200, 0, 600],   # A: A→dest=1200, A→B=600
        [1200, 600, 0],   # B: B→dest=1200, B→A=600
    ]

def test_format_planner_routes_departure_times():
    # arrival_time = "09:00" = 540 min
    # B dep = 540 - 1200//60 - 3 = 540 - 20 - 3 = 517 = "08:37"
    # A dep = 517 - 600//60 - 3 = 517 - 10 - 3 = 504 = "08:24"
    schools = [{"name": "School A", "demand": 10}, {"name": "School B", "demand": 15}]
    coords = {
        "School A": {"lat": 46.0, "lon": 11.0},
        "School B": {"lat": 46.1, "lon": 11.1},
    }
    solution = {
        "routes": [{
            "vehicle_id": 0,
            "stops": [
                {"node": 3, "load": 0},   # dummy (not a school node — filtered)
                {"node": 1, "load": 10},  # School A
                {"node": 2, "load": 25},  # School B
                {"node": 0, "load": 0},   # dest
            ],
            "distance": 1800, "load": 25,
        }],
        "total_distance": 1800, "total_load": 25, "used_vehicles": 1,
    }
    result = format_planner_routes(solution, schools, _make_time_matrix(), coords, "09:00")
    assert len(result) == 1
    route = result[0]
    assert len(route["stops"]) == 2
    assert route["stops"][0]["name"] == "School A"
    assert route["stops"][0]["departure_time"] == "08:24"
    assert route["stops"][1]["name"] == "School B"
    assert route["stops"][1]["departure_time"] == "08:37"
    assert route["stops"][0]["lat"] == 46.0
    assert route["distance_km"] > 0

def test_format_planner_routes_skips_empty_routes():
    schools = [{"name": "School A", "demand": 10}]
    solution = {
        "routes": [
            {"vehicle_id": 0, "stops": [{"node": 0, "load": 0}], "distance": 0, "load": 0},
        ],
        "total_distance": 0, "total_load": 0, "used_vehicles": 0,
    }
    result = format_planner_routes(solution, schools, [[0, 0], [0, 0]], {}, "09:00")
    assert result == []

def test_derive_arrival_time_from_gt():
    # GT bus has last stop "School B" departing "08:37"
    # time_matrix[2][0] = 1200 (20 min to dest)
    # arrival = 08:37 + 20 = 08:57
    schools = [{"name": "School A", "demand": 10}, {"name": "School B", "demand": 15}]
    gt = {
        "7": {
            "stops": [
                {"name": "School A", "departure_time": "08:24", "return_time": "", "luogo_ritrovo": "", "count": 10},
                {"name": "School B", "departure_time": "08:37", "return_time": "", "luogo_ritrovo": "", "count": 15},
            ],
            "distance_km": 15.0,
        }
    }
    arrival = derive_arrival_time(gt, schools, _make_time_matrix())
    # median of one bus: 517 + 20 = 537 = "08:57"
    assert arrival == "08:57"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/test_compare_lib.py -k "format_planner or derive_arrival" -v
```

Expected: `ImportError`

- [ ] **Step 3: Add time helpers + `derive_arrival_time` + `format_planner_routes` to `tools/compare_lib.py`**

Add after `match_buses`:

```python
def _parse_time(t: str) -> int:
    """Parse HH:MM to total minutes. Returns 0 if unparseable."""
    try:
        h, m = str(t).strip().split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return 0


def _fmt_time(total_minutes: int) -> str:
    """Format total minutes to HH:MM."""
    h = int(total_minutes) // 60
    m = int(total_minutes) % 60
    return f"{h:02d}:{m:02d}"


def derive_arrival_time(gt_buses: dict, schools: list, time_matrix: list) -> str:
    """
    Estimate target arrival time at destination from GT departure times.

    For each GT bus, takes the last stop's departure_time and adds the
    travel time from that school to the destination (node 0) using time_matrix.
    Returns the median of all estimates as HH:MM. Falls back to "09:00".

    Args:
        gt_buses:    output of load_groundtruth_full (stops have departure_time strings)
        schools:     [{"name": str, ...}] in the same order as time_matrix nodes 1..N
        time_matrix: raw (N+1)×(N+1) matrix (index 0=dest, 1..N=schools)
    """
    school_index = {s["name"]: i + 1 for i, s in enumerate(schools)}
    arrivals = []
    for fin, bus in gt_buses.items():
        valid = [s for s in bus["stops"] if ":" in s.get("departure_time", "")]
        if not valid:
            continue
        last = valid[-1]
        node = school_index.get(last["name"])
        if node is None or node >= len(time_matrix):
            continue
        dep_min = _parse_time(last["departure_time"])
        travel_min = time_matrix[node][0] // 60
        arrivals.append(dep_min + travel_min)

    if not arrivals:
        return "09:00"
    return _fmt_time(sorted(arrivals)[len(arrivals) // 2])


def format_planner_routes(
    solution: dict,
    schools: list,
    time_matrix: list,
    coords: dict,
    arrival_time: str,
) -> list:
    """
    Convert raw VRP solution to UI-ready route list.

    Departure times are back-calculated from arrival_time at destination:
        dep(stop_i) = arrival_time
                    - Σ travel(stop_k → stop_{k+1}) for k=i..last
                    - (n_stops_after_i) × STOP_DWELL_TIME_MIN

    Args:
        solution:     VRPSolver / HumanStyleSolver .solve() output
        schools:      [{"name": str, "demand": int}] — same order as time_matrix nodes 1..N
        time_matrix:  raw (N+1)×(N+1) (index 0=dest, 1..N=schools)
        coords:       {school_name: {"lat": float, "lon": float}}
        arrival_time: "HH:MM" when all buses arrive at destination

    Returns:
        [{"vehicle_id": int, "stops": [...], "distance_km": float}]
        Each stop: {"name", "lat", "lon", "departure_time", "count"}
    """
    arrival_min = _parse_time(arrival_time)
    n = len(schools)
    routes = []

    for route in solution["routes"]:
        # Collect school nodes (exclude dest=0 and dummy=n+1)
        school_nodes = [s["node"] for s in route["stops"] if 1 <= s["node"] <= n]
        if not school_nodes:
            continue

        # Back-calculate departure times from arrival_time
        cum = arrival_min
        stop_times: list = []
        for k in range(len(school_nodes) - 1, -1, -1):
            node = school_nodes[k]
            next_node = school_nodes[k + 1] if k + 1 < len(school_nodes) else 0
            travel_min = time_matrix[node][next_node] // 60
            cum -= travel_min + STOP_DWELL_TIME_MIN
            stop_times.insert(0, cum)

        # Build stop list + compute total km (time-matrix estimate)
        total_km = 0.0
        stop_list = []
        for k, node in enumerate(school_nodes):
            school = schools[node - 1]
            c = resolve_coords(school["name"], coords)
            next_node = school_nodes[k + 1] if k + 1 < len(school_nodes) else 0
            seg_s = time_matrix[node][next_node]
            seg_km = round(seg_s / 3600 * AVERAGE_SPEED_KMH, 2)
            total_km += seg_km
            stop_list.append({
                "name": school["name"],
                "lat": c["lat"] if c else None,
                "lon": c["lon"] if c else None,
                "departure_time": _fmt_time(stop_times[k]),
                "count": school["demand"],
            })

        routes.append({
            "vehicle_id": route["vehicle_id"],
            "stops": stop_list,
            "distance_km": round(total_km, 2),
        })
    return routes
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pytest tests/test_compare_lib.py -k "format_planner or derive_arrival" -v
```

Expected: 3 PASS

- [ ] **Step 5: Run full test suite to check nothing broke**

```bash
pytest tests/ -v --tb=short 2>&1 | tail -20
```

Expected: existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add tools/compare_lib.py tests/test_compare_lib.py
git commit -m "feat(compare): add route formatter with back-calculated departure times"
```

---

## Task 5: `run_compare.py` main script

**Files:**
- Create: `tools/run_compare.py`

This script calls the existing `run_v2()` and related functions from `tests/evaluate_realSuite.py`, formats the output using `compare_lib`, and writes JSON to `tools/compare/data/`.

- [ ] **Step 1: Create `tools/run_compare.py`**

```python
#!/usr/bin/env python3
"""
Pre-compute planner-vs-GT comparison data for all complete realSuite fixtures.

Usage:
    python3 tools/run_compare.py

Writes:
    tools/compare/data/index.json         — event list with summary scores
    tools/compare/data/<slug>.json        — per-event comparison data
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from evaluate_realSuite import (
    combined_score,
    load_event,
    load_groundtruth,
    run_v2,
    score_assignment,
    score_bus_count,
    solution_to_buses,
)
from tools.compare_lib import (
    derive_arrival_time,
    enrich_gt_with_coords,
    format_planner_routes,
    load_groundtruth_full,
    match_buses,
)

REALSUITE_DIR = ROOT / "tests" / "realSuite"
OUT_DIR = ROOT / "tools" / "compare" / "data"


def _slug(name: str) -> str:
    """Convert event directory name to a URL-safe slug."""
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:80]


def _load_coords(ev_dir: Path) -> dict:
    coords_path = ev_dir / "coords.json"
    if not coords_path.exists():
        return {}
    return json.loads(coords_path.read_text(encoding="utf-8"))


def _load_config(ev_dir: Path) -> dict:
    config_path = ev_dir / "config.json"
    if not config_path.exists():
        return {}
    return json.loads(config_path.read_text(encoding="utf-8"))


def process_event(ev_dir: Path) -> dict | None:
    """
    Run V2 planner on one event, compute comparison data.
    Returns None if fixture is incomplete or solver fails.
    """
    ev = load_event(ev_dir)
    if ev is None:
        return None

    coords = _load_coords(ev_dir)
    config = _load_config(ev_dir)

    # --- Ground truth ---
    gt_simple = load_groundtruth(ev["gt_path"])   # {fin: set(names)} for scoring
    gt_full = load_groundtruth_full(ev["gt_path"]) # {fin: {stops, distance_km}}
    gt_full = enrich_gt_with_coords(gt_full, coords)

    # --- Run V2 planner ---
    solution = run_v2(ev)
    if solution is None:
        print(f"  [warn] solver returned None for {ev_dir.name}")
        return None

    # --- Scores ---
    pred_buses = solution_to_buses(solution, ev["schools"])  # {bus_id: set(names)}
    asgn  = score_assignment(pred_buses, gt_simple)
    cnt   = score_bus_count(pred_buses, gt_simple)
    comb  = combined_score(pred_buses, gt_simple)

    # --- Format planner routes with departure times ---
    arrival_time = derive_arrival_time(gt_full, ev["schools"], ev["time_matrix"])
    planner_routes = format_planner_routes(
        solution, ev["schools"], ev["time_matrix"], coords, arrival_time
    )

    # --- Match planner buses to GT buses ---
    pairs, unmatched_p, unmatched_gt = match_buses(pred_buses, gt_simple)

    # Build planner + GT dicts keyed by id for easy lookup
    planner_by_id = {str(r["vehicle_id"]): r for r in planner_routes}
    gt_by_fin = gt_full  # already keyed by fin_id

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

    unmatched_planner_list = [
        planner_by_id[pid] for pid in unmatched_p if pid in planner_by_id
    ]
    unmatched_gt_list = [
        {**gt_by_fin[gid], "fin": gid} for gid in unmatched_gt if gid in gt_by_fin
    ]

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
        "scores": {
            "assignment": round(asgn, 4),
            "bus_count": round(cnt, 4),
            "combined": round(comb, 4),
        },
        "destination": destination,
        "matched_pairs": matched_pairs,
        "unmatched_planner": unmatched_planner_list,
        "unmatched_gt": unmatched_gt_list,
    }


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    events = sorted(d for d in REALSUITE_DIR.iterdir() if d.is_dir())
    index = []

    for ev_dir in events:
        print(f"Processing {ev_dir.name}...", end=" ", flush=True)
        data = process_event(ev_dir)
        if data is None:
            print("skipped")
            continue

        slug = _slug(ev_dir.name)
        out_path = OUT_DIR / f"{slug}.json"
        out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

        index.append({
            "slug": slug,
            "name": ev_dir.name,
            "destination": data["event"]["destination"],
            "scores": data["scores"],
        })
        print(f"done → {out_path.name}  (combined={data['scores']['combined']:.3f})")

    (OUT_DIR / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n✓ {len(index)} events written to {OUT_DIR}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the script**

```bash
cd /Users/dev/Desktop/busplan
python3 tools/run_compare.py
```

Expected output: lines like `Processing Piano-Viaggi-Corsa-Campestre... done → piano-viaggi-corsa-campestre.json (combined=0.612)` for each event with complete fixtures. Some events may be skipped.

Expected: at least one `<slug>.json` and `index.json` appear in `tools/compare/data/`.

- [ ] **Step 3: Verify output shape**

```bash
python3 -c "
import json
from pathlib import Path
idx = json.loads(Path('tools/compare/data/index.json').read_text())
print(f'{len(idx)} events')
slug = idx[0]['slug']
ev = json.loads(Path(f'tools/compare/data/{slug}.json').read_text())
print('scores:', ev['scores'])
print('matched_pairs:', len(ev['matched_pairs']))
print('first pair jaccard:', ev['matched_pairs'][0]['jaccard'])
print('first planner stop:', ev['matched_pairs'][0]['planner']['stops'][0] if ev['matched_pairs'][0]['planner']['stops'] else 'empty')
"
```

Expected: prints event count, scores dict, at least 1 matched pair, a stop with `departure_time` set.

- [ ] **Step 4: Commit**

```bash
git add tools/run_compare.py tools/compare/data/.gitkeep
git commit -m "feat(compare): add run_compare.py pre-computation script"
```

---

## Task 6: HTML skeleton — event selector + score chips

**Files:**
- Create: `tools/compare/index.html`

- [ ] **Step 1: Create `tools/compare/index.html`**

```html
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BusPlan Compare</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;min-height:100vh}
/* ── Top bar ── */
#topbar{background:#161b2e;border-bottom:1px solid #334155;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;position:sticky;top:0;z-index:1000}
#topbar .logo{font-weight:700;font-size:15px;color:#60a5fa;letter-spacing:.5px}
#evSelect{background:#1e2130;border:1px solid #334155;color:#e2e8f0;padding:5px 10px;border-radius:6px;font-size:12px;max-width:360px}
.score-chip{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:3px 10px;font-size:11px;display:flex;gap:6px;align-items:center}
.score-chip .val{font-weight:700}
.green .val{color:#4ade80}.yellow .val{color:#fbbf24}.red .val{color:#f87171}
/* ── Column headers ── */
#colheaders{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #334155}
.colh{padding:8px 16px;font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.colh.ph{background:#1a2744;color:#93c5fd;border-right:1px solid #334155}
.colh.gh{background:#1a2c1a;color:#86efac}
.colh .pill{background:rgba(255,255,255,.08);border-radius:10px;padding:1px 8px;font-size:10px;font-weight:400}
/* ── Maps ── */
#maps{display:grid;grid-template-columns:1fr 1fr;border-bottom:2px solid #334155}
#mapP,#mapG{height:220px}
#mapP{border-right:1px solid #334155}
/* ── Bus pairs ── */
#buses{overflow:auto}
.bus-section{border-bottom:1px solid #1e293b}
.bus-section:last-child{border-bottom:none}
.bus-pair-header{background:#111827;padding:7px 16px;display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #1e293b;cursor:pointer}
.bus-pair-header:hover{background:#1e293b}
.bh-cell{display:flex;align-items:center;gap:8px;font-size:11px}
.bh-cell.ph{border-right:1px solid #1e293b}
.bus-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.bstat{color:#64748b;font-size:10px}.bstat span{color:#94a3b8}
.jbadge{margin-left:auto;font-size:10px;padding:1px 7px;border-radius:10px}
.jg{background:rgba(74,222,128,.1);color:#4ade80}
.jy{background:rgba(251,191,36,.1);color:#fbbf24}
.jr{background:rgba(248,113,113,.1);color:#f87171}
.stops-grid{display:grid;grid-template-columns:1fr 1fr}
.stops-col.pc{border-right:1px solid #1e293b}
.stop-row{display:flex;align-items:center;padding:5px 16px;border-bottom:1px solid #0f1117;gap:8px;font-size:11px}
.stop-row:last-child{border-bottom:none}
.stop-row.da{background:rgba(74,222,128,.07)}
.stop-row.dr{background:rgba(248,113,113,.07)}
.stop-row.dt{background:rgba(251,191,36,.06)}
.snum{color:#475569;font-size:10px;min-width:14px;text-align:right}
.sname{flex:1;color:#cbd5e1}
.stime{color:#64748b;font-variant-numeric:tabular-nums;min-width:38px;text-align:right}
.spax{color:#475569;font-size:10px;min-width:22px;text-align:right}
.dtag{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;min-width:22px;text-align:center}
.dtag.same{background:rgba(100,116,139,.12);color:#64748b}
.dtag.add{background:rgba(74,222,128,.15);color:#4ade80}
.dtag.rem{background:rgba(248,113,113,.15);color:#f87171}
.dtag.chg{background:rgba(251,191,36,.12);color:#fbbf24}
.km-row{display:grid;grid-template-columns:1fr 1fr;background:#0d1117;border-top:1px solid #1e293b}
.km-cell{padding:5px 16px;font-size:10px;color:#64748b;display:flex;gap:6px;align-items:center}
.km-cell.pc{border-right:1px solid #1e293b}
.km-val{color:#94a3b8;font-weight:600}
.km-delta.worse{color:#f87171}.km-delta.better{color:#4ade80}
.warn-coords{color:#fb923c;font-size:9px;margin-left:4px}
/* ── Unmatched section ── */
.unmatched-section{background:#0d1117;border-top:2px solid #334155;padding:12px 16px}
.unmatched-section h4{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.unmatched-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.unmatched-bus{background:#1e2130;border:1px solid #334155;border-radius:6px;padding:8px 12px}
.unmatched-bus .ub-header{font-size:11px;color:#94a3b8;margin-bottom:6px;display:flex;align-items:center;gap:6px}
.unmatched-bus .ub-stop{font-size:10px;color:#64748b;padding:2px 0}
/* ── Empty state ── */
#empty{display:flex;align-items:center;justify-content:center;height:200px;color:#475569;font-size:14px}
</style>
</head>
<body>

<div id="topbar">
  <span class="logo">BusPlan Compare</span>
  <select id="evSelect"><option value="">— scegli un evento —</option></select>
  <div id="scoreChips" style="display:none;display:flex;gap:8px;flex-wrap:wrap"></div>
</div>

<div id="colheaders" style="display:none">
  <div class="colh ph">
    <span>Planner V2</span><span id="pSummary" class="pill"></span>
  </div>
  <div class="colh gh">
    <span>Ground Truth</span><span id="gSummary" class="pill"></span>
  </div>
</div>

<div id="maps" style="display:none">
  <div id="mapP"></div>
  <div id="mapG"></div>
</div>

<div id="buses"></div>
<div id="empty">Seleziona un evento dal menu in alto</div>

<script>
// ── Constants ──
const ROUTE_COLORS = [
  '#3b82f6','#22c55e','#f59e0b','#a855f7','#ef4444',
  '#06b6d4','#ec4899','#84cc16','#f97316','#6366f1',
  '#14b8a6','#eab308','#8b5cf6','#10b981','#f43f5e',
  '#0ea5e9','#d946ef','#fb923c','#a3e635','#38bdf8',
];

let mapP = null, mapG = null;
let plannerLayers = [], gtLayers = [];

// ── Bootstrap ──
fetch('data/index.json')
  .then(r => r.json())
  .then(index => {
    const sel = document.getElementById('evSelect');
    index.forEach(ev => {
      const opt = document.createElement('option');
      opt.value = ev.slug;
      opt.textContent = ev.name;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      if (sel.value) loadEvent(sel.value);
    });
  })
  .catch(() => {
    document.getElementById('empty').textContent =
      'Errore: avvia il server con: cd tools/compare && python3 -m http.server 8080';
  });

// ── Score chips ──
function scoreColor(v) {
  return v >= 0.7 ? 'green' : v >= 0.4 ? 'yellow' : 'red';
}

function renderScoreChips(scores, nP, nG) {
  const el = document.getElementById('scoreChips');
  el.style.display = 'flex';
  el.innerHTML = `
    <div class="score-chip ${scoreColor(scores.assignment)}">
      <span>Assignment</span><span class="val">${(scores.assignment * 100).toFixed(1)}%</span>
    </div>
    <div class="score-chip ${scoreColor(Math.max(0, 1 - Math.abs(nP - nG) / Math.max(nG, 1)))}">
      <span>Bus</span><span class="val">${nP} vs ${nG}</span>
    </div>
    <div class="score-chip ${scoreColor(scores.combined)}">
      <span>Combined</span><span class="val">${(scores.combined * 100).toFixed(1)}%</span>
    </div>`;
}

// ── Load event ──
function loadEvent(slug) {
  fetch(`data/${slug}.json`)
    .then(r => r.json())
    .then(data => renderEvent(data));
}

function renderEvent(data) {
  document.getElementById('empty').style.display = 'none';
  document.getElementById('colheaders').style.display = 'grid';
  document.getElementById('maps').style.display = 'grid';

  const nP = data.matched_pairs.length + data.unmatched_planner.length;
  const nG = data.matched_pairs.length + data.unmatched_gt.length;

  renderScoreChips(data.scores, nP, nG);
  document.getElementById('pSummary').textContent = `${nP} bus`;
  document.getElementById('gSummary').textContent = `${nG} bus`;

  initMaps(data);
  renderBusPairs(data);
}
</script>
</body>
</html>
```

- [ ] **Step 2: Verify skeleton works**

```bash
cd /Users/dev/Desktop/busplan/tools/compare && python3 -m http.server 8080
```

Open `http://localhost:8080`. Expected: dropdown populates with event names; score chips appear when an event is selected (scores rendered, no maps/buses yet).

- [ ] **Step 3: Commit**

```bash
git add tools/compare/index.html
git commit -m "feat(compare): add HTML skeleton with event selector and score chips"
```

---

## Task 7: HTML — maps

**Files:**
- Modify: `tools/compare/index.html`

- [ ] **Step 1: Add `initMaps` function inside the `<script>` block** (before closing `</script>`)

```javascript
// ── Maps ──
function initMaps(data) {
  // Destroy old map instances if re-loading an event
  if (mapP) { mapP.remove(); mapP = null; }
  if (mapG) { mapG.remove(); mapG = null; }
  plannerLayers = [];
  gtLayers = [];

  mapP = L.map('mapP', { zoomControl: false });
  mapG = L.map('mapG', { zoomControl: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 16
  }).addTo(mapP);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 16
  }).addTo(mapG);

  const dest = data.destination;
  const allCoords = [];

  // Draw each matched pair
  data.matched_pairs.forEach((pair, idx) => {
    const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
    const pLayer = drawRoute(mapP, pair.planner.stops, dest, color);
    const gLayer = drawRoute(mapG, pair.gt.stops, dest, color);
    if (pLayer) plannerLayers.push({ id: idx, layer: pLayer, color });
    if (gLayer) gtLayers.push({ id: idx, layer: gLayer, color });
    allCoords.push(...pair.planner.stops.filter(s => s.lat).map(s => [s.lat, s.lon]));
    allCoords.push(...pair.gt.stops.filter(s => s.lat).map(s => [s.lat, s.lon]));
  });

  // Unmatched buses (grey)
  data.unmatched_planner.forEach(bus => {
    drawRoute(mapP, bus.stops, dest, '#64748b');
    bus.stops.filter(s => s.lat).forEach(s => allCoords.push([s.lat, s.lon]));
  });
  data.unmatched_gt.forEach(bus => {
    drawRoute(mapG, bus.stops, dest, '#64748b');
    bus.stops.filter(s => s.lat).forEach(s => allCoords.push([s.lat, s.lon]));
  });

  // Destination marker on both maps
  if (dest.lat && dest.lon) {
    const destIcon = L.divIcon({
      html: `<div style="font-size:18px">🏁</div>`,
      className: '', iconAnchor: [9, 18]
    });
    L.marker([dest.lat, dest.lon], { icon: destIcon }).addTo(mapP);
    L.marker([dest.lat, dest.lon], { icon: destIcon }).addTo(mapG);
    allCoords.push([dest.lat, dest.lon]);
  }

  // Fit both maps to same bounds
  if (allCoords.length > 0) {
    const bounds = L.latLngBounds(allCoords);
    mapP.fitBounds(bounds, { padding: [10, 10] });
    mapG.fitBounds(bounds, { padding: [10, 10] });
  }
}

function drawRoute(map, stops, dest, color) {
  const validStops = stops.filter(s => s.lat != null && s.lon != null);
  if (validStops.length === 0) return null;

  const latlngs = validStops.map(s => [s.lat, s.lon]);
  if (dest.lat && dest.lon) latlngs.push([dest.lat, dest.lon]);

  const line = L.polyline(latlngs, { color, weight: 2.5, opacity: 0.85 }).addTo(map);

  // School markers
  validStops.forEach(stop => {
    const icon = L.divIcon({
      html: `<div style="
        background:${color};border-radius:50%;width:10px;height:10px;
        border:2px solid rgba(255,255,255,0.7)"></div>`,
      className: '', iconAnchor: [5, 5]
    });
    L.marker([stop.lat, stop.lon], { icon })
      .bindTooltip(`${stop.name}<br>${stop.departure_time || ''} · ${stop.count || ''}p`, { sticky: true })
      .addTo(map);
  });

  return line;
}

function highlightBus(pairIdx) {
  // Reset all
  plannerLayers.forEach(l => l.layer.setStyle({ weight: 2.5, opacity: 0.85 }));
  gtLayers.forEach(l => l.layer.setStyle({ weight: 2.5, opacity: 0.85 }));

  // Highlight selected
  const pl = plannerLayers.find(l => l.id === pairIdx);
  const gl = gtLayers.find(l => l.id === pairIdx);
  if (pl) pl.layer.setStyle({ weight: 5, opacity: 1 });
  if (gl) gl.layer.setStyle({ weight: 5, opacity: 1 });

  // Scroll map into view
  document.getElementById('maps').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
```

- [ ] **Step 2: Verify maps render**

Reload `http://localhost:8080`, select an event. Expected: two maps with coloured polylines connecting schools to destination. Destination flag marker visible on both.

- [ ] **Step 3: Commit**

```bash
git add tools/compare/index.html
git commit -m "feat(compare): add side-by-side Leaflet maps with bus routes"
```

---

## Task 8: HTML — bus pairs with diff + map interaction

**Files:**
- Modify: `tools/compare/index.html`

- [ ] **Step 1: Add `renderBusPairs` function inside `<script>` block**

```javascript
// ── Bus pair rendering ──
function renderBusPairs(data) {
  const container = document.getElementById('buses');
  container.innerHTML = '';

  data.matched_pairs.forEach((pair, idx) => {
    const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
    const jScore = pair.jaccard;
    const jClass = jScore >= 0.7 ? 'jg' : jScore >= 0.4 ? 'jy' : 'jr';

    // Align stops: build merged list of (planner_stop|null, gt_stop|null) rows
    const rows = alignStops(pair.planner.stops || [], pair.gt.stops || []);

    const pKm = pair.planner.distance_km ?? '—';
    const gKm = pair.gt.distance_km ?? '—';
    const kmDelta = (typeof pKm === 'number' && typeof gKm === 'number')
      ? (pKm - gKm).toFixed(1) : null;
    const deltaClass = kmDelta !== null ? (parseFloat(kmDelta) > 0 ? 'worse' : 'better') : '';
    const deltaStr = kmDelta !== null
      ? `<span class="km-delta ${deltaClass}">(${parseFloat(kmDelta) > 0 ? '+' : ''}${kmDelta} km)</span>`
      : '';

    const pStops = pair.planner.stops || [];
    const gStops = pair.gt.stops || [];
    const pPax = pStops.reduce((s, st) => s + (st.count || 0), 0);
    const gPax = gStops.reduce((s, st) => s + (st.count || 0), 0);

    const section = document.createElement('div');
    section.className = 'bus-section';
    section.dataset.pairIdx = idx;

    section.innerHTML = `
      <div class="bus-pair-header" onclick="highlightBus(${idx})">
        <div class="bh-cell ph">
          <div class="bus-dot" style="background:${color}"></div>
          <span>Bus P-${idx + 1}</span>
          <span class="bstat">· <span>${pStops.length} fermate</span> · <span>${pPax} pax</span></span>
        </div>
        <div class="bh-cell">
          <div class="bus-dot" style="background:${color};opacity:.6"></div>
          <span>FIN #${pair.gt_fin}</span>
          <span class="bstat">· <span>${gStops.length} fermate</span> · <span>${gPax} pax</span></span>
          <span class="jbadge ${jClass}">J:${jScore.toFixed(2)}</span>
        </div>
      </div>
      <div class="stops-grid">
        <div class="stops-col pc">${rows.map((r, i) => renderStopCell(r.p, i + 1, r.tag)).join('')}</div>
        <div class="stops-col">${rows.map((r, i) => renderStopCell(r.g, i + 1, r.tag, true)).join('')}</div>
      </div>
      <div class="km-row">
        <div class="km-cell pc">Dist.: <span class="km-val">${pKm} km</span> ${deltaStr}</div>
        <div class="km-cell">Dist. GT: <span class="km-val">${gKm} km</span></div>
      </div>`;

    container.appendChild(section);
  });

  // Unmatched buses section
  if (data.unmatched_planner.length > 0 || data.unmatched_gt.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'unmatched-section';
    sec.innerHTML = `
      <h4>Bus senza corrispondenza</h4>
      <div class="unmatched-grid">
        <div>
          ${data.unmatched_planner.map(b => renderUnmatchedBus(b, 'Planner', '#64748b')).join('')}
        </div>
        <div>
          ${data.unmatched_gt.map(b => renderUnmatchedBus(b, `FIN #${b.fin}`, '#4ade80')).join('')}
        </div>
      </div>`;
    container.appendChild(sec);
  }
}

function alignStops(pStops, gStops) {
  // Build name→stop maps for GT
  const gByName = {};
  gStops.forEach(s => { if (s.name) gByName[s.name] = s; });

  const rows = [];
  const usedG = new Set();

  pStops.forEach(ps => {
    const gs = gByName[ps.name];
    let tag;
    if (!gs) {
      tag = 'add'; // planner-only
    } else {
      usedG.add(ps.name);
      const tDiff = Math.abs(
        (gs.departure_time && ps.departure_time)
          ? parseMinutes(ps.departure_time) - parseMinutes(gs.departure_time)
          : 0
      );
      tag = tDiff > 5 ? 'chg' : 'same';
    }
    rows.push({ p: ps, g: gs || null, tag });
  });

  // GT stops not in planner
  gStops.forEach(gs => {
    if (!usedG.has(gs.name)) {
      rows.push({ p: null, g: gs, tag: 'rem' });
    }
  });

  return rows;
}

function parseMinutes(t) {
  try { const [h, m] = t.split(':'); return +h * 60 + +m; } catch { return 0; }
}

function renderStopCell(stop, num, tag, isGt = false) {
  if (!stop) {
    return `<div class="stop-row ${tag === 'add' ? 'da' : tag === 'rem' ? 'dr' : ''}" style="opacity:.25">
      <span class="snum">—</span><span class="sname" style="color:#334155">–</span>
      <span class="dtag rem">–</span>
    </div>`;
  }
  const rowClass = tag === 'add' ? 'da' : tag === 'rem' ? 'dr' : tag === 'chg' ? 'dt' : '';
  const tagLabel = tag === 'same' ? '=' : tag === 'add' ? '+' : tag === 'rem' ? '–' : 'Δt';
  const tagClass = tag;
  const warnCoords = stop.coords_missing ? '<span class="warn-coords" title="coordinate non trovate">⚠</span>' : '';
  const ret = (isGt && stop.return_time) ? `<span style="color:#475569;font-size:9px" title="rientro"> /${stop.return_time}</span>` : '';
  return `<div class="stop-row ${rowClass}">
    <span class="snum">${num}</span>
    <span class="sname">${stop.name}${warnCoords}</span>
    <span class="stime">${stop.departure_time || '—'}${ret}</span>
    <span class="spax">${stop.count || ''}p</span>
    <span class="dtag ${tagClass}">${tagLabel}</span>
  </div>`;
}

function renderUnmatchedBus(bus, label, color) {
  const stops = (bus.stops || []).slice(0, 6);
  const more = (bus.stops || []).length - stops.length;
  return `<div class="unmatched-bus">
    <div class="ub-header">
      <div class="bus-dot" style="background:${color}"></div>
      <span>${label}</span>
      <span style="color:#475569;font-size:10px">· ${bus.stops?.length || 0} fermate · ${bus.distance_km ?? '—'} km</span>
    </div>
    ${stops.map(s => `<div class="ub-stop">${s.name} <span style="color:#475569">${s.departure_time || ''}</span></div>`).join('')}
    ${more > 0 ? `<div class="ub-stop" style="color:#475569">+${more} altri...</div>` : ''}
  </div>`;
}
```

- [ ] **Step 2: Verify full UI**

Reload `http://localhost:8080`, select an event.

Check:
1. Maps render with coloured polylines
2. Bus pairs appear below maps with matching colours
3. Stop rows show diff tags (`=`, `+`, `–`, `Δt`)
4. Return times visible on GT side for rows with data
5. Km row shows delta in red (planner > GT) or green (planner < GT)
6. GT stops with missing coords show orange ⚠ icon
7. Clicking a bus pair header highlights the corresponding route on both maps and scrolls maps into view
8. Unmatched buses section appears at bottom if there are unmatched buses

- [ ] **Step 3: Commit**

```bash
git add tools/compare/index.html
git commit -m "feat(compare): add bus pair diffs and map highlight interaction"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Standalone HTML (`tools/compare/index.html`) — Task 6-8
- [x] Pre-computation script (`tools/run_compare.py`) — Task 5
- [x] `data/index.json` + `data/<slug>.json` — Task 5
- [x] GT loader with ffill, ordered stops, distance_km — Task 1
- [x] Coord resolution by name, coords_missing flag — Task 2
- [x] Hungarian bus matching returning pairs — Task 3
- [x] Route formatter with back-calculated times — Task 4
- [x] Reuse `run_v2()` from evaluate_realSuite.py — Task 5
- [x] Score chips (assignment, bus count, combined) — Task 6
- [x] Dual Leaflet maps — Task 7
- [x] Bus pairs ordered by descending Jaccard — Task 8
- [x] Stop-level diff tags (`=`, `+`, `–`, `Δt`) — Task 8
- [x] Km delta per bus pair — Task 8
- [x] Click-to-highlight on maps — Task 8
- [x] Unmatched buses section — Task 8
- [x] GT return time displayed — Task 8
- [x] `coords_missing` warning (orange ⚠) — Task 8

**Type consistency:**
- `load_groundtruth_full()` returns `{fin_key: {"stops": [...], "distance_km": float|None}}`; `enrich_gt_with_coords()` preserves this shape + adds `lat/lon/coords_missing` to each stop — used consistently throughout Task 5 and 8
- `format_planner_routes()` returns `[{"vehicle_id", "stops", "distance_km"}]`; each stop has `name/lat/lon/departure_time/count` — consistent with Task 7/8 rendering
- `match_buses()` returns `(pairs, unmatched_p, unmatched_gt)`; pairs have `p_id/gt_id/jaccard` — consumed correctly in Task 5

---

## Verification (end-to-end)

```bash
# 1. Generate data
cd /Users/dev/Desktop/busplan
python3 tools/run_compare.py
# Expected: ≥1 .json files in tools/compare/data/

# 2. Run unit tests
pytest tests/test_compare_lib.py -v
# Expected: all PASS

# 3. Serve UI
cd tools/compare && python3 -m http.server 8080
# Open http://localhost:8080

# 4. Select an event → verify:
#    - Score chips show assignment %, bus count N vs M, combined %
#    - Both maps render coloured polylines
#    - Bus pairs listed with Jaccard badges
#    - Diff tags visible (=, +, –, Δt)
#    - Clicking bus header highlights routes on both maps
#    - Unmatched buses section at bottom (if any)
```
