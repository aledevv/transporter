# Design: realSuite Test Cases + V2 Human-Style Planner

**Date:** 2026-04-10  
**Status:** Approved

---

## Overview

Three coordinated deliverables:

1. **Test case extraction** — turn every `_structured.xlsx` in `tests/realSuite/` into a planner-ready `input.xlsx` + groundtruth pair, one sub-folder per event.
2. **Evaluation suite** — a combined pytest + standalone script that scores planner output against groundtruth using bus-assignment similarity and bus count.
3. **V2 planner** — a separate `optimizer_v2.py` + `/api/optimize_v2` endpoint that mimics the human 2-step approach (proximity clustering → capacity balancing), benchmarked against V1.

---

## Section 1 — Test Case Extraction

### Script: `tests/prepare_realSuite.py`

One-shot script (idempotent — re-running is safe). For each `_structured.xlsx` in `tests/realSuite/` (skipping `tests/realSuite/pending/`):

1. Create `tests/realSuite/<event_name>/` folder (event_name = filename without `_structured.xlsx`).
2. Read the `Per Istituto` sheet (flat, one row per stop).
3. Map columns:
   - `Istituto` → `Nome`
   - `Luogo Ritrovo` → `Indirizzo`
   - `Persone` → `Partecipanti`
4. Skip rows where `Persone` or `Luogo Ritrovo` is null/empty.
5. Deduplicate: if the same school name appears on multiple FINs in one event, keep one row summing `Partecipanti`.
6. **Do NOT populate the `Istituto` column** in the output — leave it absent. Grouping is purely by proximity at solve time.
7. Write `input.xlsx` in standard planner format (`Nome`, `Indirizzo`, `Partecipanti`).
8. Copy the `_structured.xlsx` as `groundtruth.xlsx` into the same folder.

**Also:** delete `tests/real3/` (already represented in realSuite).

---

## Section 2 — Address Correction & Geocoding Pipeline

### Phase A — AI Correction (run once, reuse forever)

`prepare_realSuite.py` (or a separate `--correct` flag) calls `AddressCorrector` on each `input.xlsx`:
- Writes `input_corretto.xlsx` with `AI_Corrected=True` column.
- Skips entirely if `input_corretto.xlsx` already exists with all rows `AI_Corrected=True`.
- If Gemini call fails for any row: print a warning with the school name and raw address; leave that row uncorrected (do not silently drop it).

### Phase B — Geocoding

After AI correction, geocode each `input_corretto.xlsx` via `GeocodingService` (Nominatim):
- Writes `coords.json` per event folder.
- City-only addresses (no street): use OSM town centroid; log as a notice.
- Failed geocodes: use Trento center fallback `(46.0697, 11.1211)`; print a warning.
- After `coords.json` is written, call the OSRM Table API to build the travel-time matrix (destination at index 0, schools at 1..N). Writes `time_matrix.json`. Falls back to haversine if OSRM is unreachable. Skip if `time_matrix.json` already exists.

### Phase C — Sanity Check

After geocoding, compute pairwise haversine distances between all schools in each event:
- If any school's nearest neighbor is **> 100 km** away, print a warning:
  ```
  WARNING [<event>] <school_name> is >100km from all others — check address: <raw_address> → geocoded: (<lat>, <lon>)
  ```
- This catches geocoding errors (wrong city, wrong region, wrong country).

### Phase D — Uncorrected Detection (pytest)

In `tests/conftest.py`, at collection time:
- Scan all `tests/realSuite/<event>/` folders for `input.xlsx` without a sibling `input_corretto.xlsx`.
- If any found: emit a `pytest.warns` / `warnings.warn` listing the uncorrected folders.
- Does **not** fail the test run — just alerts the user to run the correction step.

---

## Section 3 — Evaluation Suite

### Core Logic: `tests/evaluate_realSuite.py`

Shared scoring functions used by both the standalone script and the pytest file.

#### Cost function (per event)

**Input:** predicted solution dict (same shape as `VRPSolver.solve()`) + groundtruth from `groundtruth.xlsx` (`Per Istituto` sheet, `FIN #` column as bus label).

**Step 1 — Bus assignment score (weight 0.6):**
- Build sets: `pred_buses = {bus_id: {school_name, ...}}`, `gt_buses = {fin: {school_name, ...}}`.
- Hungarian-algorithm matching (minimize negative Jaccard) between pred and gt buses.
- For each matched pair: `Jaccard = |intersection| / |union|`.
- Assignment score = mean Jaccard across all matched pairs.

**Step 2 — Bus count score (weight 0.4):**
- `count_score = 1 - |len(pred_buses) - len(gt_buses)| / len(gt_buses)`, clipped to [0, 1].

**Combined:** `score = 0.6 * assignment_score + 0.4 * count_score`

#### Standalone mode

```bash
python tests/evaluate_realSuite.py
```

- Runs both V1 (`VRPSolver`) and V2 (`HumanStyleSolver`) on every event with `input_corretto.xlsx` present.
- Uses pre-computed `time_matrix.json` (no OSRM calls).
- Prints a table:
  ```
  Event                      | V1 score | V2 score | GT buses | V1 buses | V2 buses
  Piano-Viaggi_Volley-S3_... |   0.61   |   0.74   |    8     |    9     |    8
  ...
  ```

### Pytest file: `tests/test_realSuite.py`

One parameterized test per event folder. Asserts:
- V1 combined score ≥ 0.5
- V2 combined score ≥ 0.6

Thresholds are constants at the top of the file — easy to tune once baseline numbers are known.

---

## Section 4 — V2 Planner

### Module: `optimizer_v2.py`

Class `HumanStyleSolver` with same interface as `VRPSolver`:

```python
HumanStyleSolver(
    time_matrix,          # NxN int seconds (same layout as VRPSolver)
    demands,              # list[int], len N
    vehicle_capacity,     # int
    cluster_threshold_minutes=20,  # primary grid-search param
    institutes=None,      # optional list[str], same semantics as VRPSolver
)
```

Returns the same dict shape as `VRPSolver.solve()`: `{routes, total_distance, total_load, used_vehicles}`.

#### Step 1 — Proximity Clustering (ignore capacity)

- Use `scipy.cluster.hierarchy` agglomerative clustering on the travel-time matrix (schools only, not depot/dummy node).
- Linkage method: **complete** (max pairwise time within cluster = "all schools within D minutes of each other").
- Cut tree at `cluster_threshold_minutes * 60` seconds → initial cluster assignments.
- If `institutes` provided: post-process to ensure schools sharing a non-UNIVERSAL institute label are always in the same cluster (override clustering for those pairs).

#### Step 2 — Capacity Balancing

**Split oversized clusters:**
- For any cluster where `sum(demands) > vehicle_capacity`:
  - Compute each school's "distance to cluster centroid" as the mean of its row in the time-matrix restricted to other schools in the cluster.
  - Repeatedly remove the school farthest from the centroid into a new sub-cluster until all sub-clusters fit capacity.

**Merge under-capacity clusters:**
- Build a graph of clusters; merge the pair with the smallest inter-cluster travel time if `combined_demand ≤ vehicle_capacity`.
- Repeat until no valid merges remain.

#### Output formatting

After balancing, each final cluster becomes one bus route. Route ordering (stop sequence within a bus) is solved with a nearest-neighbor TSP heuristic (start from the farthest school from depot, always go to nearest unvisited).

### Endpoint: `POST /api/optimize_v2`

Same request body as `/api/optimize`, with one additional optional field:
```json
{ "cluster_threshold_minutes": 20 }
```

Same response schema as `/api/optimize`. Calls `HumanStyleSolver` instead of `VRPSolver`.

### Grid Search: `tests/grid_search_v2.py`

```bash
python tests/grid_search_v2.py
```

- Iterates `D ∈ {10, 15, 20, 25, 30}` minutes.
- Runs `HumanStyleSolver` on every event with `time_matrix.json` present (no OSRM).
- Computes combined score for each (event, D) pair.
- Prints best D per event + global best D (by mean combined score).
- Also runs V1 as baseline column.

**Important:** grid search uses only `input_corretto.xlsx` (AI-corrected) to avoid LLM costs. Run `prepare_realSuite.py --correct` once before the grid search.

---

## File Layout After Implementation

```
tests/
  realSuite/
    <event_name>/
      input.xlsx            # extracted planner input
      input_corretto.xlsx   # AI-corrected addresses (generated once)
      groundtruth.xlsx      # copy of _structured.xlsx
      coords.json           # geocoded coordinates
      time_matrix.json      # OSRM travel-time matrix (generated once)
    README_pdf_to_excel_structure.md
    *.xlsx                  # original structured files (kept in place)
    pending/                # ignored by all scripts
  prepare_realSuite.py      # extraction + correction + geocoding
  evaluate_realSuite.py     # standalone scorer + shared cost functions
  test_realSuite.py         # pytest integration
  grid_search_v2.py         # parameter search for V2
optimizer_v2.py             # HumanStyleSolver
app.py                      # add /api/optimize_v2 endpoint
```

---

## Key Constraints & Notes

- `prepare_realSuite.py` is idempotent: re-running skips already-done steps (checks for `input_corretto.xlsx`, `coords.json`, `time_matrix.json`).
- Grid search never calls LLM or OSRM — uses pre-computed artifacts only.
- V1 and V2 share the same request/response contract — frontend can switch between them with a single flag.
- Scoring thresholds (0.5 / 0.6) in `test_realSuite.py` are constants, easy to update after seeing real baseline numbers.
- The `Istituto` grouping column is intentionally absent from extracted `input.xlsx` files to avoid biasing the proximity test.
