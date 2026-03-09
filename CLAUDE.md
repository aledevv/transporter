# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

BusPlan is a bus route optimization tool for the Trentino region (Italy). Users upload an Excel file listing school stops with passenger counts, and the app geocodes the addresses, then solves a Vehicle Routing Problem (VRP) to assign stops to buses and generate optimized routes.

## Development Commands

### Run both services (recommended for local dev)
```bash
./start.sh
```
- Backend: http://localhost:5001
- Frontend: http://localhost:5173

### Run individually
```bash
# Backend (from project root, with venv activated)
source venv/bin/activate
python3 app.py

# Frontend
cd frontend && npm run dev
```

### Frontend build & lint
```bash
cd frontend
npm run build    # production build to frontend/dist/
npm run lint     # ESLint (0 warnings allowed)
npm run preview  # preview production build
```

### Run tests
```bash
# Full suite (convenience script)
python3 run_tests.py

# Directly with pytest (more options)
pytest tests/ -v
pytest tests/test_address_corrector.py -v
pytest tests/test_optimizer.py::TestStrategies::test_distance_strategy_uses_two_buses -v
```

### Deploy (Google Cloud Run)
```bash
./gcloud_deploy.sh
```
The Dockerfile builds the frontend, copies the dist into the Python image, and serves everything via gunicorn on `$PORT` (default 8080 in Cloud Run).

## Architecture

### Backend (Python/Flask — `app.py`)
Single Flask app serving both the API and the built frontend (`frontend/dist/`).

**Request flow for optimization:**
1. **`/api/upload`** — Accepts Excel file, starts a background thread (`process_file_task`) that reads it via `DataLoader`, geocodes each address via `smart_geocode()`, and stores results in the `tasks` dict.
2. **`/api/status/<task_id>`** — Polls the background task for progress/result.
3. **`/api/optimize`** — Takes geocoded schools + destination, pre-groups schools by `institute` into meta-nodes, builds a distance matrix via OSRM, then calls `VRPSolver`. Post-processes routes to expand meta-nodes back to individual schools and synchronize departure/arrival times.

**Key modules:**
- `data_loader.py` — Reads Excel; requires columns `Nome`, `Indirizzo`, `Partecipanti`; optional `Istituto` column for institute grouping.
- `address_corrector.py` — `AddressCorrector`: called in `process_file_task` after loading data. Sends addresses to `call_agent()` from `gemini_agent.py`, parses the JSON response (`{id, normalized_address}`), saves `<name>_corretto.xlsx` with an `AI_Corrected=True` column. If that column is already present and `True` for all rows, the agent call is skipped to avoid unnecessary API costs.
- `gemini_agent.py` — datapizza-ai agent wrapping Gemini Flash. Exposes `call_agent(user_input: str) -> str`. System prompt lives in `gemini_SYSTEM_PROMPT.py`. Requires `GOOGLE_API_KEY` env var.
- `geocoder.py` — `GeocodingService`: geocodes via Nominatim (OSM), distance matrices via OSRM Table API, route geometry via OSRM Route API. Falls back to Euclidean distance if OSRM fails. Fallback coordinates: Trento center `(46.0697, 11.1211)`.
- `optimizer.py` — `VRPSolver` wraps Google OR-Tools. Uses a dummy start node (zero-cost from anywhere) and the destination as the end depot. Supports three strategies: `distance` (PATH_CHEAPEST_ARC), `vehicles` (SAVINGS + high fixed cost), `balanced`. Institute mixing is penalized with a cost of 100,000,000 on cross-institute arcs.

### Frontend (React/Vite — `frontend/`)
Single-page app using React 18, Tailwind CSS, Leaflet (react-leaflet) for maps, and jsPDF for PDF export.

**Component flow:**
- `App.jsx` — Top-level state: `schools` array, loading overlay. Two sections: FileUpload → Dashboard.
- `FileUpload.jsx` — Handles Excel upload, polls `/api/status` for geocoding progress.
- `Dashboard.jsx` — Main control panel: destination input (with `AddressAutocomplete`), optimization settings (capacity, strategy, time mode), calls `/api/optimize`, displays results.
- `Map.jsx` — Leaflet map displaying school markers and route polylines.
- `SchoolEditor.jsx` — Inline table editor for adding/editing/deleting stops manually.

**API URL configuration (`src/config.js`):**
- Dev: `http://localhost:5001`
- Prod: `''` (relative, same origin)

## Key Data Shapes

**Excel input columns:** `Nome` (stop name), `Indirizzo` (address), `Partecipanti` (passenger count), `Istituto` (optional, groups stops onto same bus), `AI_Corrected` (bool, added by `AddressCorrector` — presence prevents redundant agent calls).

**Institute grouping logic:** Schools sharing an `Istituto` value are pre-grouped into meta-nodes before VRP. If total demand exceeds bus capacity, the group is split into sub-batches. Meta-nodes are expanded back to individual schools in the response.

**Time modes:**
- `arrival` — user specifies when all buses must arrive at destination; departure times are back-calculated.
- `departure` — user specifies when buses leave the first stop.
