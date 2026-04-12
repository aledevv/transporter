# Planner vs Ground Truth Comparison Tool

**Date:** 2026-04-12  
**Status:** Approved

---

## Context

The V2 planner produces routes that differ from expert (ground truth) plans in ways that are hard to diagnose without a side-by-side view. This tool addresses that gap: a developer runs a pre-computation script once to generate comparison data for all fixtures, then opens a standalone HTML page to explore differences bus-by-bus. The goal is to identify systematic patterns in planner behaviour (wrong groupings, extra buses, time deviations) to guide future improvements.

---

## Architecture

Two artefacts, no build step:

```
tools/run_compare.py           ← pre-computation script (Python)
tools/compare/
  index.html                   ← standalone UI (Leaflet CDN, vanilla JS)
  data/
    index.json                 ← event list with summary scores
    <event-slug>.json          ← per-event comparison data
```

### Running

```bash
# Step 1 – generate comparison data (once, or when fixtures change)
python3 tools/run_compare.py

# Step 2 – serve
cd tools/compare && python3 -m http.server 8080
# Open http://localhost:8080
```

---

## Pre-computation Script (`tools/run_compare.py`)

Iterates over every `tests/realSuite/<event>/` directory that has all four required files:
- `input_corretto.xlsx`
- `coords.json`
- `time_matrix.json`
- `groundtruth.xlsx`

For each qualifying event:

1. **Load fixture** — reuse `load_event()` from `tests/evaluate_realSuite.py`; reads schools, time matrix, config (destination, capacity, end time).
2. **Run planner** — call `VRPSolver` directly (no Flask). Use `time_matrix.json` as-is; skip OSRM and geocoding. Post-process routes by extracting the time/distance computation logic from `optimize_v2()` in `app.py` (arrival time back-calculation, per-segment km from time matrix + avg speed).
3. **Parse ground truth** — read "Per Istituto" sheet from `groundtruth.xlsx`. Apply `ffill()` on the `FIN #` column (values appear only on first row of each bus group; subsequent rows are blank). Group rows by FIN # to get ordered stop lists. `distance_km` for a GT bus = the `Km` column value from the first non-null row of that group (the value is repeated or blank for subsequent rows of the same bus). Columns used: `FIN #`, `Istituto`, `Luogo Ritrovo`, `Persone`, `Orario Partenza`, `Rientro Presunto`, `Km`. Columns ignored (subjective): `Ditta`, `Sport`, `Data`, `Categoria`, `Destinazione`.
4. **Resolve GT coordinates** — for each GT stop, match `Istituto` name to `coords.json` keys: exact match first, then case-insensitive stripped match. If no match found, set `coords_missing: true` (the stop is shown in the UI with a warning but still listed by name). Using `coords.json` (derived from `input_corretto.xlsx`) ensures both sides use identical geocoded positions and maps are directly comparable.
5. **Match buses** — Hungarian algorithm on Jaccard similarity matrix between planner bus sets and GT bus sets (reuse logic from `evaluate_realSuite.score_assignment`, extended to return the actual pairing not just the score). The algorithm produces `min(N_planner, N_GT)` 1-to-1 pairs; excess buses on either side become `unmatched_planner` / `unmatched_gt`. Pairs ordered by descending Jaccard.
6. **Compute scores** — `assignment_score`, `bus_count_score`, `combined_score` (0.6/0.4 weights) from existing `evaluate_realSuite.py`.
7. **Write output** — `tools/compare/data/<slug>.json` (slug = event directory name, lowercased, spaces→hyphens). Also update `tools/compare/data/index.json`.

---

## Data Format

### `index.json`
```json
[
  {
    "slug": "atletica-cadetti-14-mar-25",
    "name": "Atletica Cadetti — 14 mar 2025",
    "destination": "Rovereto – Stadio Quercia",
    "scores": { "assignment": 0.68, "bus_count": 0.78, "combined": 0.61 }
  }
]
```

### `<event>.json`
```json
{
  "event": {
    "name": "Atletica Cadetti — 14 mar 2025",
    "destination": "Rovereto – Stadio Quercia",
    "capacity": 54
  },
  "scores": { "assignment": 0.68, "bus_count": 0.78, "combined": 0.61 },
  "destination": { "name": "Rovereto – Stadio Quercia", "lat": 45.9009, "lon": 11.0375 },
  "matched_pairs": [
    {
      "jaccard": 0.82,
      "planner": {
        "vehicle_id": 0,
        "stops": [
          { "name": "IC ALA", "lat": 45.756, "lon": 11.001, "departure_time": "08:55", "count": 26 }
        ],
        "distance_km": 89.0
      },
      "gt": {
        "fin": 7,
        "stops": [
          {
            "name": "IC ALA",
            "luogo_ritrovo": "Via Betta, ALA",
            "lat": 45.756, "lon": 11.001,
            "departure_time": "08:55",
            "return_time": "17:25",
            "count": 26,
            "coords_missing": false
          }
        ],
        "distance_km": 77.0
      }
    }
  ],
  "unmatched_planner": [ { "vehicle_id": 3, "stops": [...], "distance_km": 45.0 } ],
  "unmatched_gt":      [ { "fin": 12,     "stops": [...], "distance_km": 60.0 } ]
}
```

---

## UI (`tools/compare/index.html`)

Pure HTML + vanilla JS + Leaflet (CDN). No build step, no framework.

### Layout (matching approved mockup)

```
┌─────────────────────────────────────────────────────┐
│ BusPlan Compare  [event dropdown]  [score chips]    │
├──────────────────────┬──────────────────────────────┤
│  PLANNER V2          │  GROUND TRUTH                │
│  [Leaflet map]       │  [Leaflet map]               │
├──────────────────────┼──────────────────────────────┤
│ Bus P-1  ·  3 fermate│ FIN #7  ·  3 fermate  J:0.82│
│  1  IC ALA  08:55 26p│  1  IC ALA  08:55 26p   =   │
│  2  IC ALDEN 09:05   │  2  IC ALDEN 09:15      Δt  │
│  3  IC ALTOP 09:22 + │  –  (absent)                │
│  dist: 89 km (+12)   │  dist: 77 km                │
├──────────────────────┼──────────────────────────────┤
│ … next bus pair …                                   │
├──────────────────────┴──────────────────────────────┤
│ [Unmatched planner buses]  [Unmatched GT buses]     │
└─────────────────────────────────────────────────────┘
```

### Score chips (top bar)
- Assignment score (%), Bus count (planner N vs GT M), Combined score — colour-coded green/yellow/red.

### Maps
- Two independent Leaflet instances, same bounding box.
- Each route = polyline connecting stops in order → destination, coloured by bus index.
- Destination marker shared across all routes (flag icon).
- School markers: circle with count label, coloured by bus.
- Hover on marker → tooltip with school name + departure time.
- Clicking a bus row in the list highlights that bus's polyline on both maps.

### Bus pairs
- Ordered by descending Jaccard (most similar first).
- Each pair: side-by-side stop lists aligned by matched school name (schools unique to one side shown with empty row on the other).
- Diff tags: `=` identical, `Δt` same school different time, `+` planner-only stop, `–` GT-only stop.
- Km row: planner km | GT km | delta (red if planner > GT, green if planner < GT).
- Jaccard badge on GT header: green ≥ 0.7, yellow ≥ 0.4, red < 0.4.

### Unmatched buses
- Shown below matched pairs, full-width, with a distinct background.
- Planner-only buses on the left column; GT-only buses on the right column.

### Warnings
- GT stops with `coords_missing: true` shown with orange highlight and tooltip "coordinate non trovate".

---

## Key reused code

| Purpose | Source file | Symbol |
|---|---|---|
| Load fixture | `tests/evaluate_realSuite.py` | `load_event()` |
| Parse GT bus assignments | `tests/evaluate_realSuite.py` | `load_groundtruth()` (extend to return ordered stops + times) |
| Hungarian bus matching | `tests/evaluate_realSuite.py` | `score_assignment()` (extend to return pairs) |
| Scoring | `tests/evaluate_realSuite.py` | `score_assignment`, `score_bus_count`, `combined_score` |
| VRP solving | `optimizer.py` | `VRPSolver` |
| Route post-processing | `app.py` | logic extracted from `optimize_v2()` inline |

---

## Verification

1. `python3 tools/run_compare.py` completes without errors; `tools/compare/data/` contains at least one `<event>.json` and `index.json`.
2. `cd tools/compare && python3 -m http.server 8080` — open `http://localhost:8080`; event dropdown populates.
3. Select an event: both maps render with coloured polylines; bus pairs appear below.
4. Score chips match values from running `python3 tests/evaluate_realSuite.py` manually for the same event.
5. A bus pair with Jaccard > 0.7 shows mostly `=` tags; a low-Jaccard pair shows many `+`/`–` tags.
6. GT stops with unresolved names show orange warning in the UI.
7. Clicking a bus row highlights the correct polyline on both maps.
