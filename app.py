
from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_cors import CORS
import pandas as pd
import os
import uuid
import copy
import json
from geocoder import GeocodingService
from optimizer import VRPSolver
import tempfile
from document_generator import generate_piano_viaggi, generate_richiesta_servizio
from scripts.find_overlaps import find_bus_overlaps
import school_cache as _school_cache

# Setup static folder to point to frontend/dist
app = Flask(__name__, static_folder='frontend/dist', static_url_path='')
# Reject oversized uploads before they hit the disk
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024
# In production the frontend is served from the same origin; CORS is only needed by the Vite dev server
CORS(app, origins=[r"http://localhost:\d+", r"http://127\.0\.0\.1:\d+"])

tasks = {}


# --- Per-IP rate limit -------------------------------------------------------
# Generous thresholds that normal use never reaches; they only stop scripted
# abuse of the costly endpoints. Counted per instance, in memory.
import collections as _collections
import functools as _functools
import threading as _threading
import time as _time

_rate_hits = _collections.defaultdict(_collections.deque)
_rate_lock = _threading.Lock()


def _client_ip():
    # Cloud Run appends the real client address as the LAST X-Forwarded-For
    # entry; earlier entries come from the client and can be forged
    fwd = request.headers.get('X-Forwarded-For', '')
    return fwd.split(',')[-1].strip() if fwd else (request.remote_addr or '?')


def rate_limit(per_minute):
    def wrap(view):
        @_functools.wraps(view)
        def limited(*args, **kwargs):
            key = (view.__name__, _client_ip())
            now = _time.monotonic()
            with _rate_lock:
                # Drop clients idle for a minute so the table can't grow forever
                if len(_rate_hits) > 5000:
                    for k in [k for k, h in _rate_hits.items() if not h or now - h[-1] > 60]:
                        del _rate_hits[k]
                hits = _rate_hits[key]
                while hits and now - hits[0] > 60:
                    hits.popleft()
                if len(hits) >= per_minute:
                    retry = max(1, int(60 - (now - hits[0])))
                    resp = jsonify({'error': f'Troppe richieste in poco tempo: riprova tra {retry} secondi.'})
                    resp.status_code = 429
                    resp.headers['Retry-After'] = str(retry)
                    return resp
                hits.append(now)
            return view(*args, **kwargs)
        return limited
    return wrap

import random

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Clean uploads folder on every startup (remove leftover files from previous sessions)
for _f in os.listdir(UPLOAD_FOLDER):
    try:
        os.remove(os.path.join(UPLOAD_FOLDER, _f))
    except OSError:
        pass

geocoder = GeocodingService()

def format_time_from_minutes(total_minutes):
    """Format minutes to HH:MM, handling times past midnight."""
    hours = int(total_minutes // 60)
    minutes = int(total_minutes % 60)
    
    if hours >= 24:
        # Time goes into next day
        days = hours // 24
        hours = hours % 24
        return f"{hours:02d}:{minutes:02d} (+{days}g)"
    else:
        return f"{hours:02d}:{minutes:02d}"

def parse_time_to_minutes(time_str):
    """Parse a time string (HH:MM or HH:MM (+Ng)) to total minutes."""
    # Remove any day suffix like (+1g)
    clean_time = time_str.split(' ')[0] if ' ' in time_str else time_str
    h, m = map(int, clean_time.split(':'))
    return h * 60 + m

def calculate_return_times_for_routes(formatted_routes, fine_manifestazione: str) -> None:
    """
    Mutates formatted_routes in-place, adding 'return_time' (HH:MM) to each pickup stop.

    Algorithm (per route):
      The return trip reverses the outbound order: destination → last_pickup → ... → first_pickup.
      We reuse outbound leg times (time_to_next_min) as symmetric approximation:
        - last pickup:  return_time = fine + last_pickup.time_to_next_min
        - each earlier stop: return_time = next_stop.return_time + DWELL + this_stop.time_to_next_min
    """
    try:
        base_h, base_m = map(int, fine_manifestazione.split(':'))
    except Exception:
        return  # Invalid format — skip silently

    DWELL = 3  # minutes per stop (same as STOP_DWELL_TIME_MIN in optimize())
    base_minutes = base_h * 60 + base_m

    for route in formatted_routes:
        pickup_stops = [s for s in route['outbound']['stops'] if s['type'] == 'pickup']
        if not pickup_stops:
            continue

        n = len(pickup_stops)
        # Walk backwards: pickup_stops[n-1] is closest to destination on outbound
        cumulative = base_minutes
        for i in range(n - 1, -1, -1):
            leg_min = pickup_stops[i].get('time_to_next_min', 0)
            cumulative += leg_min
            pickup_stops[i]['return_time'] = format_time_from_minutes(cumulative)
            if i > 0:
                cumulative += DWELL


import threading
import time

import re

# Trento Center Fallback (Matches geocoder.py)
FALLBACK_COORDS = (46.0697, 11.1211)

# Common Trentino Municipalities for Context Extraction
TRENTINO_MUNICIPALITIES = [
    "Rovereto", "Pergine", "Arco", "Riva", "Mori", "Ala", "Lavis", "Levico", 
    "Cles", "Borgo", "Mezzolombardo", "Fiemme", "Fassa", "Primiero", "Rendena",
    "Giudicarie", "Chiese", "Cembra", "Non", "Sole", "Ledro", "Grigno", "Tesino",
    "Valsugana", "Bondone", "Bleggio", "Comano", "Storo", "Tione", "Pinzolo",
    "Andalo", "Molveno", "Fai", "San Michele", "Mezzocorona", "Romagnano", "Aldeno",
    "Mattarello", "Ravina", "Povo", "Villazzano", "Gardolo", "Cognola", "Argentario"
]

def extract_city_context(text):
    """
    Extracts a likely city/area from text (e.g. school name) based on a known list.
    Returns the city name if found, else None.
    """
    if not text:
        return None
    
    text_lower = text.lower()
    for city in TRENTINO_MUNICIPALITIES:
        if city.lower() in text_lower:
            # Special case for "Non" or "Sole" to avoid false positives if they appear in other words?
            # For now simple substring check is okay for this specific domain
            return city
            
    return None

def smart_geocode(address, school_name=None, default_city="Trento"):
    """
    Attempts to geocode the address using Google Geocoding API.
    Returns (lat, lon, success).
    """
    def is_fallback(lat, lon):
        return abs(lat - FALLBACK_COORDS[0]) <= 0.0001 and abs(lon - FALLBACK_COORDS[1]) <= 0.0001

    # Build variants from most-specific-clean to less-clean.
    # AI agent produces full Italian postal format:
    #   "Via X, Locality, City, TN, Italia"
    # Google prefers: "Via X, Locality, City" — strip province code + country.
    queries = [address]

    # Strip ", Italia/Italy" from the end
    no_country = re.sub(r',\s*(Italy|Italia)\s*$', '', address, flags=re.IGNORECASE).strip()
    if no_country != address:
        # Strip ", XX" province abbreviation (e.g. ", TN") now at the end
        no_province = re.sub(r',\s*[A-Z]{2}\s*$', '', no_country).strip()
        # Try with province code first (e.g. "Via Roma, Ospedaletto, TN") — keeps regional
        # context so Google doesn't pick a same-named street in another region.
        queries.insert(0, no_country)
        if no_province != no_country:
            queries.append(no_province)   # no-province variant as last resort

    for q in queries:
        lat, lon = geocoder.get_coordinates(q)
        if not is_fallback(lat, lon):
            return lat, lon, True

    # Phase 2: help Google with ambiguous locality names by adding region context
    clean_base = queries[0]  # already stripped province+country
    lat, lon = geocoder.get_coordinates(f"{clean_base}, Trentino, Italy")
    if not is_fallback(lat, lon):
        return lat, lon, True

    return FALLBACK_COORDS[0], FALLBACK_COORDS[1], False

def continue_file_task(task_id, original_schools, filepath, resolutions):
    """
    Background task: runs geocoding.

    resolutions: dict  key=school_id (str or int), value = {lat, lon, address, name} | 'keep'
      - pre-geocoded: resolution is a dict with lat/lon -> use coords directly
      - keep: geocode the original address as-is
      - not present: geocode the original address as-is
    """
    import math

    try:
        tasks[task_id].update({'status': 'processing', 'progress': 16, 'message': 'Classificazione fermate...'})

        # Normalise resolution keys to int (school ids are ints internally)
        norm_res = {}
        for k, v in resolutions.items():
            try:
                norm_res[int(k)] = v
            except (ValueError, TypeError):
                norm_res[k] = v

        pre_geocoded_ids = set()   # ids that already have lat/lon from DB
        keep_ids = set()           # ids to geocode directly

        for school in original_schools:
            sid = school['id']
            res = norm_res.get(sid)
            if isinstance(res, dict) and res.get('discard'):
                continue
            if res is None:
                keep_ids.add(sid)
            elif res == 'keep':
                keep_ids.add(sid)
            elif not isinstance(res, dict) or res.get('lat') is None or res.get('lon') is None:
                # DB entry saved without coordinates: geocode the original address instead
                keep_ids.add(sid)
            else:
                pre_geocoded_ids.add(sid)

        total_schools = len(original_schools)

        tasks[task_id].update({'progress': 20, 'message': f'Geocoding {total_schools} fermate...'})

        # Build merged school list preserving original order
        original_map = {s['id']: s for s in original_schools}
        address_corrections = []

        # Geocoding
        processed_schools = []
        used_coordinates = {}

        for i, orig_school in enumerate(original_schools):
            sid = orig_school['id']
            res = norm_res.get(sid)
            
            if isinstance(res, dict) and res.get('discard'):
                continue

            current_progress = 20 + int(((i + 1) / total_schools) * 70)
            tasks[task_id].update({
                'progress': current_progress,
                'message': f'Geocoding {i+1}/{total_schools}: {orig_school["name"]}',
            })

            if sid in pre_geocoded_ids:
                # Use coordinates from DB resolution directly
                school = copy.copy(orig_school)
                # Address shown in the UI and documents: the dataset's short street when
                # the stop was resolved against the dataset, else the Excel one
                school['display_address'] = res.get('display_address') or orig_school.get('display_address') or orig_school['address']
                if res.get('demand') is not None:
                    school['demand'] = int(res['demand'])
                school['address'] = res['address']
                school['lat'] = float(res['lat'])
                school['lon'] = float(res['lon'])
                school['geocoding_failed'] = False
                if school['address'] != orig_school['address']:
                    address_corrections.append({
                        'name': school['name'],
                        'original': orig_school['address'],
                        'corrected': school['address'],
                    })
                processed_schools.append(school)
                continue

            school = copy.copy(orig_school)

            # Preserve original Excel address for display purposes (Word docs, UI)
            if 'display_address' not in school or not school['display_address']:
                school['display_address'] = orig_school.get('display_address') or orig_school['address']

            raw_address = school['address']
            lat, lon, success = smart_geocode(raw_address, school_name=school['name'])

            if not success:
                orig_addr = orig_school.get('address', '')
                if orig_addr and orig_addr != raw_address:
                    lat, lon, success = smart_geocode(orig_addr, school_name=school['name'])

            if not success:
                print(f"Failed to geocode: {raw_address} - Marking as unresolved")
                school['lat'] = None
                school['lon'] = None
                school['geocoding_failed'] = True
                suggestion = _school_cache.find_suggestion(
                    school_name=school.get('name', ''),
                    raw_address=raw_address,
                )
                if suggestion:
                    school['cache_suggestion'] = suggestion
            else:
                coord_key = (round(lat, 6), round(lon, 6))
                count = used_coordinates.get(coord_key, 0)
                if count > 0:
                    angle = count * 2.4
                    radius = 0.0003 * math.sqrt(count)
                    lat += radius * math.sin(angle)
                    lon += radius * math.cos(angle)
                used_coordinates[coord_key] = count + 1
                school['lat'] = lat
                school['lon'] = lon

            processed_schools.append(school)

        tasks[task_id].update({'progress': 95, 'message': 'Finalizzazione dati...'})

        # Cleanup original file
        if filepath and os.path.exists(filepath):
            os.remove(filepath)

        # No AI correction in this version: there is no corrected file to download
        tasks[task_id] = {
            'status': 'completed',
            'progress': 100,
            'message': 'Completato!',
            'result': processed_schools,
            'corrected_file': None,
            'address_corrections': address_corrections,
            'correction_status': None,
            'unresolved_by_ai': [],
        }

    except Exception as e:
        tasks[task_id] = {
            'status': 'error',
            'progress': 0,
            'message': f'Errore: {str(e)}',
        }
        if filepath and os.path.exists(filepath):
            os.remove(filepath)

def _sheet_cell(value):
    """JSON-friendly cell value: empty for NaN, ints for whole numbers, text for dates."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ''
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, (int, float, str, bool)):
        return value
    if pd.isna(value):
        return ''
    return str(value)


@app.route('/api/sheet/read', methods=['POST'])
@rate_limit(30)
def read_sheet():
    """
    Returns the first sheet of an uploaded .xlsx as {columns, rows}, unchanged:
    the review window shows it as a spreadsheet and does every check client-side.
    Nothing is saved on the server.
    """
    file = request.files.get('file')
    if not file or not file.filename:
        return jsonify({'error': 'Nessun file inviato'}), 400
    if not file.filename.lower().endswith('.xlsx'):
        return jsonify({'error': 'Sono ammessi solo file .xlsx'}), 400
    try:
        df = pd.read_excel(file, sheet_name=0, dtype=object)
    except Exception as e:
        return jsonify({'error': f'File Excel non leggibile: {e}'}), 400

    df.columns = [str(c).strip() for c in df.columns]
    df = df.loc[:, [c for c in df.columns if not c.startswith('Unnamed')]]
    # Trailing empty rows go; empty rows inside the table stay, because a trip
    # sheet ends at its first empty row (as data_loader.py reads it)
    filled = df.notna().any(axis=1)
    df = df.loc[: filled[filled].index.max()] if filled.any() else df.iloc[0:0]
    if len(df) > 2000:
        return jsonify({'error': 'Il foglio ha troppe righe (massimo 2000)'}), 400

    rows = [{c: _sheet_cell(v) for c, v in zip(df.columns, r)} for r in df.itertuples(index=False, name=None)]
    return jsonify({'fileName': file.filename, 'columns': list(df.columns), 'rows': rows})


@app.route('/api/status/<task_id>', methods=['GET'])
def get_task_status(task_id):
    task = tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    return jsonify(task)


@app.route('/api/start-processing', methods=['POST'])
@rate_limit(30)
def start_processing():
    """
    Runs the reviewed stops: raw_schools + resolutions (coordinates from the
    stop dataset) straight from the review window, no uploaded file.
    Creates a new task and runs continue_file_task.
    """
    data = request.json or {}
    raw_schools = data.get('raw_schools', [])
    resolutions = data.get('resolutions', {})

    if not raw_schools:
        return jsonify({'error': 'raw_schools required'}), 400

    task_id = str(uuid.uuid4())
    tasks[task_id] = {'status': 'processing', 'progress': 16, 'message': 'Avvio elaborazione...'}

    thread = threading.Thread(
        target=continue_file_task,
        args=(task_id, raw_schools, None, resolutions),
    )
    thread.daemon = True
    thread.start()

    return jsonify({'task_id': task_id}), 202


@app.route('/api/geocode', methods=['POST'])
@rate_limit(60)
def geocode_single():
    """Geocode a single address. Used by the frontend address correction UI."""
    data = request.json or {}
    address = data.get('address', '').strip()
    if not address:
        return jsonify({'error': 'address required'}), 400
    lat, lon, success = smart_geocode(address)
    return jsonify({'lat': lat, 'lon': lon, 'success': success})

def _make_sub_route(school_nodes, original_route, time_matrix, demands, dest_idx, dummy_idx):
    """Create a route dict from a subset of school node indices."""
    stops = [{'node': dummy_idx, 'load': 0}]
    for node in school_nodes:
        stops.append({'node': node, 'load': demands[node]})
    stops.append({'node': dest_idx, 'load': 0})
    route_time = 0
    if school_nodes:
        for j in range(len(school_nodes) - 1):
            route_time += time_matrix[school_nodes[j]][school_nodes[j + 1]]
        route_time += time_matrix[school_nodes[-1]][dest_idx]
    return {
        'vehicle_id': original_route['vehicle_id'],
        'stops': stops,
        'distance': route_time,
        'load': sum(demands[n] for n in school_nodes),
    }


def _find_split_point(school_nodes, time_matrix, dest_idx, max_extra_sec):
    """Return largest k such that school_nodes[:k] satisfies the 20-min constraint."""
    for k in range(len(school_nodes) - 1, 0, -1):
        prefix = school_nodes[:k]
        if len(prefix) == 1:
            return k
        route_time = sum(time_matrix[prefix[j]][prefix[j + 1]] for j in range(len(prefix) - 1))
        route_time += time_matrix[prefix[-1]][dest_idx]
        direct_time = time_matrix[prefix[0]][dest_idx]
        if route_time - direct_time <= max_extra_sec:
            return k
    return 1  # fallback: split after first stop


def _validate_and_split_routes(solution_routes, time_matrix, dest_idx, dummy_idx, demands, max_extra_sec=1200):
    """
    For each route, check if the first stop has extra_time > 20 min (1200 s).
    If so, split at the best point. Recursive.
    """
    validated = []
    for route in solution_routes:
        school_nodes = [s['node'] for s in route['stops']
                        if s['node'] not in (dummy_idx, dest_idx)]
        
        # If there's 1 or 0 schools, automatically valid
        if len(school_nodes) <= 1:
            validated.append(route)
            continue
            
        # Requisito Committente:
        # Se 1 + somma(i=2, N) < 1 + 20min 
        # (ovvero: Tempo da 1 con N fermate <= Tempo 1 diretto + 20min)
        # Calcoliamo questo accumulando scuola per scuola
        
        valid = True
        direct_time = time_matrix[school_nodes[0]][dest_idx]
        cum_time = 0
        
        for i in range(1, len(school_nodes)):
            cum_time += time_matrix[school_nodes[i-1]][school_nodes[i]]
            total_time = cum_time + time_matrix[school_nodes[i]][dest_idx]
            diff_sec = total_time - direct_time
            if diff_sec > max_extra_sec:
                valid = False
                break
                
        if valid:
            validated.append(route)
        else:
            split_idx = _find_split_point(school_nodes, time_matrix, dest_idx, max_extra_sec)
            sub_routes = [
                _make_sub_route(school_nodes[:split_idx], route, time_matrix, demands, dest_idx, dummy_idx),
                _make_sub_route(school_nodes[split_idx:], route, time_matrix, demands, dest_idx, dummy_idx),
            ]
            validated.extend(_validate_and_split_routes(sub_routes, time_matrix, dest_idx, dummy_idx, demands, max_extra_sec))
    return validated
    return validated


@app.route('/api/optimize', methods=['POST'])
@rate_limit(60)
def optimize():
    data = request.json
    schools = data.get('schools', [])
    destination_address = data.get('destination', '')
    bus_capacity = int(data.get('capacity', 56))
    max_buses = data.get('max_buses', None)

    dest_lat_param = data.get('dest_lat')
    dest_lon_param = data.get('dest_lon')
    
    if not schools or not destination_address:
        return jsonify({'error': 'Scuole o destinazione mancanti'}), 400
    
    # PRE-GROUPING: Group schools by institute before optimization
    # This ensures schools from the same institute are on the same bus when feasible
    from collections import defaultdict
    import uuid
    
    # Step 1: Group schools by institute
    institute_groups = defaultdict(list)
    for school in schools:
        institute = school.get('institute')
        if not institute:
            # Schools without institute get unique singleton groups
            institute = f"SINGLETON_{uuid.uuid4()}"
            school['institute'] = institute
        institute_groups[institute].append(school)
    
    # Step 2: Create meta-nodes for each institute group
    processed_schools = []
    meta_node_mapping = {}  # Maps meta-node index to list of component schools
    
    for institute, group_schools in institute_groups.items():
        # Calculate total demand for this institute
        total_demand = sum(s['demand'] for s in group_schools)
        
        if total_demand > bus_capacity:
            # Institute group doesn't fit in one bus - must split
            # Strategy: Try to keep as many together as possible, split only when necessary
            
            # Sort by demand (largest first) for better bin packing
            sorted_schools = sorted(group_schools, key=lambda x: x['demand'], reverse=True)
            
            current_batch = []
            current_batch_demand = 0
            batch_idx = 1
            
            for school in sorted_schools:
                school_demand = school['demand']
                
                # Check if adding this school exceeds capacity
                if current_batch_demand + school_demand > bus_capacity:
                    # Save current batch as a meta-node (if not empty)
                    if current_batch:
                        meta_node = {
                            'id': f"{institute}_META_{batch_idx}",
                            'name': f"{institute} (Gruppo {batch_idx})",
                            'original_name': institute,
                            'address': current_batch[0]['address'],  # Use first school's address
                            'demand': current_batch_demand,
                            'lat': sum(s['lat'] for s in current_batch) / len(current_batch),  # Average coords
                            'lon': sum(s['lon'] for s in current_batch) / len(current_batch),
                            'institute': institute,
                            'is_meta': True,
                            'component_schools': current_batch.copy()
                        }
                        processed_schools.append(meta_node)
                        batch_idx += 1
                    
                    # Start new batch with current school
                    current_batch = [school]
                    current_batch_demand = school_demand
                else:
                    # Add to current batch
                    current_batch.append(school)
                    current_batch_demand += school_demand
            
            # Don't forget the last batch
            if current_batch:
                meta_node = {
                    'id': f"{institute}_META_{batch_idx}",
                    'name': f"{institute} (Gruppo {batch_idx})" if batch_idx > 1 else institute,
                    'original_name': institute,
                    'address': current_batch[0]['address'],
                    'demand': current_batch_demand,
                    'lat': sum(s['lat'] for s in current_batch) / len(current_batch),
                    'lon': sum(s['lon'] for s in current_batch) / len(current_batch),
                    'institute': institute,
                    'is_meta': True,
                    'component_schools': current_batch.copy()
                }
                processed_schools.append(meta_node)
        
        else:
            # Entire institute fits in one bus - create single meta-node
            meta_node = {
                'id': f"{institute}_META",
                'name': institute,
                'original_name': institute,
                'address': group_schools[0]['address'],  # Use first school's address
                'demand': total_demand,
                'lat': sum(s['lat'] for s in group_schools) / len(group_schools),  # Average coords
                'lon': sum(s['lon'] for s in group_schools) / len(group_schools),
                'institute': institute,
                'is_meta': True,
                'component_schools': group_schools.copy()
            }
            processed_schools.append(meta_node)
    
    schools = processed_schools

    try:
        # 1. Prepare Nodes
        if dest_lat_param and dest_lon_param:
            dest_lat, dest_lon = float(dest_lat_param), float(dest_lon_param)
        else:
            dest_lat, dest_lon = geocoder.get_coordinates(destination_address)
        
        all_nodes = []
        # Destination Node (Index 0)
        all_nodes.append({
            'id': 'DEST',
            'name': 'Destination',
            'address': destination_address,
            'participants': 0,
            'lat': dest_lat,
            'lon': dest_lon,
            'institute': 'UNIVERSAL' # Compatible with all
        })
        
        index_to_school = {} 
        for i, school in enumerate(schools):
            all_nodes.append({
                'id': school['id'],
                'name': school['name'],
                'address': school['address'],
                'participants': school['demand'],
                'lat': float(school.get('lat', 0)),
                'lon': float(school.get('lon', 0)),
                'institute': school['institute']
            })
            index_to_school[i + 1] = school 
        
        # Add DUMMY START NODE (Index = len(all_nodes))
        # This node represents an "Anywhere" start point with 0 cost to all other nodes.
        dummy_node_index = len(all_nodes)
        all_nodes.append({
            'id': 'DUMMY_START',
            'name': 'Start',
            'address': '',
            'participants': 0,
            'lat': 0,
            'lon': 0,
            'institute': 'UNIVERSAL'
        })
            
        # 2. Time Matrix (seconds) — primary optimization objective
        # We process N real nodes. The matrix needs to be (N+1)x(N+1)
        real_node_count = len(all_nodes) - 1
        locations = [(n['lat'], n['lon']) for n in all_nodes[:real_node_count]]
        real_matrix = geocoder.get_time_matrix(locations)
        
        # Extend matrix for Dummy Node
        # Rows: Real nodes -> Real nodes (Keep)
        # Row: Dummy -> Real nodes (0 distance)
        # Col: Real nodes -> Dummy (Infinity? Or 0? Usually maximize to prevent using as shortcut, but it's start node so it only has outgoing)
        
        full_matrix = []
        for row in real_matrix:
            row.append(0) 
            full_matrix.append(row)
            
        dummy_row = [0] * (real_node_count + 1)
        full_matrix.append(dummy_row)
        
        distance_matrix = full_matrix

        # 3. Demands & Solve
        demands = [n['participants'] for n in all_nodes]
        total_demand = sum(demands)

        # Calculate vehicles: use forced count if provided, otherwise estimate
        if max_buses is not None and int(max_buses) > 0:
            calculated_vehicles = int(max_buses)
            print(f"[DEBUG] Forcing {calculated_vehicles} buses (user specified)")
        else:
            min_needed = -(-total_demand // bus_capacity)  # Ceiling division
            calculated_vehicles = min_needed + 2  # Buffer for solver flexibility
            print(f"[DEBUG] Auto-calculated {calculated_vehicles} buses (min needed: {min_needed})")

        # Single mode: minimize travel time (primary) + minimize buses (secondary)
        # fixed_cost = 1 hour equivalent → solver merges routes when time savings > 1h overhead
        fixed_cost = 3600

        solver = VRPSolver(
            time_matrix=distance_matrix,
            demands=demands,
            vehicle_capacity=bus_capacity,
            num_vehicles=calculated_vehicles,
            depot_index=0,
            fixed_vehicle_cost=fixed_cost,
            starts=[dummy_node_index] * calculated_vehicles,
            ends=[0] * calculated_vehicles,  # 0 is Destination
            institutes=[n.get('institute') for n in all_nodes] + ['UNIVERSAL']  # +1 for Dummy Node
        )

        solution = solver.solve()

        if solution:
            # Post-VRP: validate 20-min extra-time constraint and split routes if needed
            validated_routes = _validate_and_split_routes(
                solution['routes'], distance_matrix, 0, dummy_node_index, demands
            )
            for i, r in enumerate(validated_routes):
                r['vehicle_id'] = i
            solution['routes'] = validated_routes
            solution['used_vehicles'] = len(validated_routes)
        
        if not solution:
             msg = "Nessuna soluzione trovata. Prova ad aumentare il numero di bus o la capacità, oppure verifica che la destinazione sia raggiungibile."
             if max_buses:
                 msg += f" (Hai forzato {max_buses} bus, forse non sono sufficienti per la capacità totale)"
             return jsonify({'error': msg}), 400

        # 4. Format Response (Outbound & Return)
        formatted_routes = []
        
        # Time estimation settings
        start_time_str = data.get('start_time', '08:00')  # Default 08:00
        try:
            start_hour, start_min = map(int, start_time_str.split(':'))
        except:
            start_hour, start_min = 8, 0
        AVERAGE_SPEED_KMH = 30  # Urban average speed
        STOP_DWELL_TIME_MIN = 3  # Minutes per pickup stop
        
        sorted_routes = sorted(solution['routes'], key=lambda x: x['vehicle_id'])
        
        for idx, route in enumerate(sorted_routes):
            current_vehicle_id = idx
            
            # Reconstruct stops with details
            stops_data = []
            for node_obj in route['stops']:
                node_idx = node_obj['node']
                
                # Skip Dummy Start Node in output
                if node_idx == dummy_node_index:
                    continue
                    
                if node_idx == 0:
                    stops_data.append({
                        'type': 'destination',
                        'name': destination_address,
                        'load_change': 0,
                        'lat': dest_lat, 
                        'lon': dest_lon
                    })
                else:
                    original_school = index_to_school[node_idx]
                    stops_data.append({
                        'type': 'pickup',
                        'name': original_school['name'],
                        'original_name': original_school.get('original_name', original_school['name']),
                        'address': original_school['address'],
                        'display_address': original_school.get('display_address') or original_school['address'],
                        'count': original_school['demand'],
                        'lat': original_school['lat'],
                        'lon': original_school['lon'],
                        'is_meta': original_school.get('is_meta', False),
                        'component_schools': original_school.get('component_schools', [])
                    })
            
            # Agglomerate: Merge consecutive stops from the same original school
            agglomerated_stops = []
            for stop in stops_data:
                if stop['type'] == 'destination':
                    agglomerated_stops.append(stop)
                elif agglomerated_stops and agglomerated_stops[-1]['type'] == 'pickup' and agglomerated_stops[-1].get('original_name') == stop.get('original_name'):
                    # Same school, merge
                    agglomerated_stops[-1]['count'] += stop['count']
                    agglomerated_stops[-1]['name'] = stop['original_name']  # Use clean name
                else:
                    # Different stop, add new
                    merged_stop = stop.copy()
                    merged_stop['name'] = stop['original_name']  # Use clean name without "Gruppo X"
                    agglomerated_stops.append(merged_stop)
            
            stops_data = agglomerated_stops
            
            # EXPAND META-NODES: Convert meta-nodes back to individual schools
            expanded_stops = []
            for stop in stops_data:
                if stop['type'] == 'pickup' and stop.get('is_meta'):
                    # This is a meta-node, expand it into component schools
                    component_schools = stop['component_schools']
                    for comp_school in component_schools:
                        expanded_stop = {
                            'type': 'pickup',
                            'name': comp_school['name'],
                            'original_name': comp_school.get('original_name', comp_school['name']),
                            'address': comp_school['address'],
                            'display_address': comp_school.get('display_address') or comp_school['address'],
                            'count': comp_school['demand'],
                            'lat': comp_school['lat'],
                            'lon': comp_school['lon'],
                            'from_meta': True  # Mark that this came from a meta-node
                        }
                        # Inherit timing from meta-node (all schools in meta-node share same time)
                        if 'departure_time' in stop:
                            expanded_stop['departure_time'] = stop['departure_time']
                        expanded_stops.append(expanded_stop)
                else:
                    # Regular stop (destination or non-meta school)
                    expanded_stops.append(stop)
            
            stops_data = expanded_stops
            
            # Pre-compute haversine segment distances (needed for time estimates and dist fallback)
            pickup_stops = [s for s in stops_data if s['type'] == 'pickup']
            seg_distances_m = []
            if pickup_stops:
                for i, stop in enumerate(pickup_stops):
                    ns = pickup_stops[i + 1] if i < len(pickup_stops) - 1 else {'lat': dest_lat, 'lon': dest_lon}
                    seg_distances_m.append(
                        geocoder.haversine_distance(stop['lat'], stop['lon'], ns['lat'], ns['lon'])
                    )

            # Fetch geometry for Outbound (includes real road leg distances + durations)
            geo_data = geocoder.get_route_geometry(stops_data)
            outbound_geometry = geo_data['geometry'] if geo_data else None
            outbound_dist = geo_data['distance'] if geo_data else int(sum(seg_distances_m))

            # Real per-leg distances from Google Directions (leg i = segment stop i → stop i+1)
            # Using these ensures sum(dist_to_next_km) == total bus distance in the header.
            leg_distances_m = geo_data.get('leg_distances') if geo_data else None
            leg_durations_s = geo_data.get('leg_durations') if geo_data else None

            # Calculate times FORWARD from first school departure
            # start_time = when bus departs from FIRST school
            if pickup_stops:
                total_haversine_m = sum(seg_distances_m) or 1

                # Use Google Directions total duration if available, else fall back to speed estimate
                total_drive_min = (geo_data['duration'] / 60) if geo_data and geo_data.get('duration') else None

                cumulative_minutes = start_hour * 60 + start_min

                for i, stop in enumerate(pickup_stops):
                    stop['departure_time'] = format_time_from_minutes(cumulative_minutes)

                    # Use real road leg distance/duration from OSRM when available (fallback: haversine)
                    if leg_distances_m and i < len(leg_distances_m):
                        seg_dist_m = leg_distances_m[i]
                        seg_drive_min = (leg_durations_s[i] / 60) if (leg_durations_s and i < len(leg_durations_s)) else (seg_dist_m / 1000 / AVERAGE_SPEED_KMH) * 60
                    else:
                        seg_dist_m = seg_distances_m[i]
                        if total_drive_min:
                            seg_drive_min = total_drive_min * (seg_dist_m / total_haversine_m)
                        else:
                            seg_drive_min = (seg_dist_m / 1000 / AVERAGE_SPEED_KMH) * 60

                    stop['dist_to_next_km'] = round(seg_dist_m / 1000, 2)
                    stop['time_to_next_min'] = round(seg_drive_min)
                    cumulative_minutes += STOP_DWELL_TIME_MIN + seg_drive_min

                # Destination arrival time
                for stop in stops_data:
                    if stop['type'] == 'destination':
                        stop['arrival_time'] = format_time_from_minutes(cumulative_minutes)

            formatted_routes.append({
                'vehicle_id': current_vehicle_id,
                'total_load': route['load'],
                'outbound': {
                    'stops': stops_data,
                    'geometry': outbound_geometry,
                    'distance': outbound_dist
                }
            })

        # POST-PROCESSING: Synchronize pickup times for schools split across buses
        # Find all schools and their departure times across all routes
        school_times = {}  # {original_name: [(route_idx, stop_idx, departure_time_minutes)]}
        
        for route_idx, route in enumerate(formatted_routes):
            for stop_idx, stop in enumerate(route['outbound']['stops']):
                if stop['type'] == 'pickup':
                    original_name = stop.get('original_name', stop['name'])
                    if original_name not in school_times:
                        school_times[original_name] = []
                    # Parse the departure time
                    if 'departure_time' in stop:
                        minutes = parse_time_to_minutes(stop['departure_time'])
                        school_times[original_name].append({
                            'route_idx': route_idx,
                            'stop_idx': stop_idx,
                            'minutes': minutes
                        })
        
        # For schools with multiple entries, synchronize to the LATEST time
        for school_name, times in school_times.items():
            if len(times) > 1:
                # Find the latest departure time
                latest_minutes = max(t['minutes'] for t in times)
                latest_time_str = format_time_from_minutes(latest_minutes)
                
                # Update all stops for this school to use synchronized time
                for t in times:
                    stop = formatted_routes[t['route_idx']]['outbound']['stops'][t['stop_idx']]
                    stop['departure_time'] = latest_time_str
                    stop['synchronized'] = True  # Mark as synchronized

        # POST-PROCESSING: Synchronize arrival times (ONLY in arrival mode)
        # Collect all arrival times
        time_mode = data.get('time_mode', 'arrival')  # 'departure' or 'arrival'
        arrival_times_minutes = []
        
        for route in formatted_routes:
            for stop in route['outbound']['stops']:
                if stop['type'] == 'destination' and 'arrival_time' in stop:
                    minutes = parse_time_to_minutes(stop['arrival_time'])
                    arrival_times_minutes.append(minutes)
        
        if arrival_times_minutes:
            earliest_arrival = min(arrival_times_minutes)
            latest_arrival = max(arrival_times_minutes)
            current_spread = latest_arrival - earliest_arrival
            
            # ONLY synchronize arrivals if in ARRIVAL mode
            if time_mode == 'arrival':
                # User specified ARRIVAL time - all buses should arrive at this time
                target_time_str = data.get('start_time', '08:00')
                try:
                    th, tm = map(int, target_time_str.split(':'))
                    target_arrival_minutes = th * 60 + tm
                except:
                    target_arrival_minutes = 8 * 60  # Default 08:00
                
                # Recalculate departure times to synchronize arrivals to target time
                for route in formatted_routes:
                    stops = route['outbound']['stops']
                    dest_stop = None
                    for stop in stops:
                        if stop['type'] == 'destination':
                            dest_stop = stop
                            break
                    
                    if dest_stop and 'arrival_time' in dest_stop:
                        current_arrival = parse_time_to_minutes(dest_stop['arrival_time'])
                        
                        # Calculate time shift needed to hit target arrival
                        # If Current is 08:15 and Target is 08:00 -> Shift is -15 (shift backwards)
                        # If Current is 07:45 and Target is 08:00 -> Shift is +15 (shift forwards)
                        delay_minutes = target_arrival_minutes - current_arrival
                        
                        # Shift all times for this route
                        for stop in stops:
                            if stop['type'] == 'pickup' and 'departure_time' in stop:
                                old_minutes = parse_time_to_minutes(stop['departure_time'])
                                new_minutes = old_minutes + delay_minutes
                                stop['departure_time'] = format_time_from_minutes(new_minutes)
                            elif stop['type'] == 'destination' and 'arrival_time' in stop:
                                old_minutes = parse_time_to_minutes(stop['arrival_time'])
                                new_minutes = old_minutes + delay_minutes
                                stop['arrival_time'] = format_time_from_minutes(new_minutes)
                
                # Recalculate arrival times after synchronization
                final_arrival_times = []
                for route in formatted_routes:
                    for stop in route['outbound']['stops']:
                        if stop['type'] == 'destination' and 'arrival_time' in stop:
                            minutes = parse_time_to_minutes(stop['arrival_time'])
                            final_arrival_times.append(minutes)
                
                final_earliest = min(final_arrival_times) if final_arrival_times else 0
                final_latest = max(final_arrival_times) if final_arrival_times else 0
                final_spread = final_latest - final_earliest
            else:
                # DEPARTURE mode: No arrival synchronization, buses arrive naturally
                final_earliest = earliest_arrival
                final_latest = latest_arrival
                final_spread = current_spread
            
            arrival_window = {
                'earliest': format_time_from_minutes(final_earliest),
                'latest': format_time_from_minutes(final_latest),
                'spread_minutes': final_spread
            }
        else:
            arrival_window = None

        # POST-PROCESSING: Return times (optional, when fine_manifestazione is provided)
        fine_manifestazione = data.get('fine_manifestazione', '').strip()
        calculate_return = data.get('calculate_return', True)
        if calculate_return and fine_manifestazione:
            calculate_return_times_for_routes(formatted_routes, fine_manifestazione)

        # Calculate Totals
        total_outbound = sum([r['outbound']['distance'] for r in formatted_routes])

        # Calculate Overlaps
        overlaps = find_bus_overlaps(formatted_routes, min_overlap_meters=30)

        return jsonify({
            'routes': formatted_routes,
            'overlaps': overlaps,
            'stats': {
                'total_buses': solution['used_vehicles'],
                'total_passengers': solution['total_load'],
                'outbound_distance': total_outbound,
                'total_distance': total_outbound,
                'arrival_window': arrival_window,
                'fine_manifestazione': fine_manifestazione if (calculate_return and fine_manifestazione) else None,
            }
        }), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/optimize_v2', methods=['POST'])
@rate_limit(60)
def optimize_v2():
    data = request.json
    cluster_threshold_minutes = int(data.get('cluster_threshold_minutes', 25))
    schools = data.get('schools', [])
    destination_address = data.get('destination', '')
    bus_capacity = int(data.get('capacity', 56))
    max_buses = data.get('max_buses', None)

    dest_lat_param = data.get('dest_lat')
    dest_lon_param = data.get('dest_lon')

    if not schools or not destination_address:
        return jsonify({'error': 'Scuole o destinazione mancanti'}), 400

    # PRE-GROUPING: Group schools by institute before optimization
    # This ensures schools from the same institute are on the same bus when feasible
    from collections import defaultdict
    import uuid

    # Step 1: Group schools by institute
    institute_groups = defaultdict(list)
    for school in schools:
        institute = school.get('institute')
        if not institute:
            # Schools without institute get unique singleton groups
            institute = f"SINGLETON_{uuid.uuid4()}"
            school['institute'] = institute
        institute_groups[institute].append(school)

    # Step 2: Create meta-nodes for each institute group
    processed_schools = []
    meta_node_mapping = {}  # Maps meta-node index to list of component schools

    for institute, group_schools in institute_groups.items():
        # Calculate total demand for this institute
        total_demand = sum(s['demand'] for s in group_schools)

        if total_demand > bus_capacity:
            # Institute group doesn't fit in one bus - must split
            # Strategy: Try to keep as many together as possible, split only when necessary

            # Sort by demand (largest first) for better bin packing
            sorted_schools = sorted(group_schools, key=lambda x: x['demand'], reverse=True)

            current_batch = []
            current_batch_demand = 0
            batch_idx = 1

            for school in sorted_schools:
                school_demand = school['demand']

                # Check if adding this school exceeds capacity
                if current_batch_demand + school_demand > bus_capacity:
                    # Save current batch as a meta-node (if not empty)
                    if current_batch:
                        meta_node = {
                            'id': f"{institute}_META_{batch_idx}",
                            'name': f"{institute} (Gruppo {batch_idx})",
                            'original_name': institute,
                            'address': current_batch[0]['address'],  # Use first school's address
                            'demand': current_batch_demand,
                            'lat': sum(s['lat'] for s in current_batch) / len(current_batch),  # Average coords
                            'lon': sum(s['lon'] for s in current_batch) / len(current_batch),
                            'institute': institute,
                            'is_meta': True,
                            'component_schools': current_batch.copy()
                        }
                        processed_schools.append(meta_node)
                        batch_idx += 1

                    # Start new batch with current school
                    current_batch = [school]
                    current_batch_demand = school_demand
                else:
                    # Add to current batch
                    current_batch.append(school)
                    current_batch_demand += school_demand

            # Don't forget the last batch
            if current_batch:
                meta_node = {
                    'id': f"{institute}_META_{batch_idx}",
                    'name': f"{institute} (Gruppo {batch_idx})" if batch_idx > 1 else institute,
                    'original_name': institute,
                    'address': current_batch[0]['address'],
                    'demand': current_batch_demand,
                    'lat': sum(s['lat'] for s in current_batch) / len(current_batch),
                    'lon': sum(s['lon'] for s in current_batch) / len(current_batch),
                    'institute': institute,
                    'is_meta': True,
                    'component_schools': current_batch.copy()
                }
                processed_schools.append(meta_node)

        else:
            # Entire institute fits in one bus - create single meta-node
            meta_node = {
                'id': f"{institute}_META",
                'name': institute,
                'original_name': institute,
                'address': group_schools[0]['address'],  # Use first school's address
                'demand': total_demand,
                'lat': sum(s['lat'] for s in group_schools) / len(group_schools),  # Average coords
                'lon': sum(s['lon'] for s in group_schools) / len(group_schools),
                'institute': institute,
                'is_meta': True,
                'component_schools': group_schools.copy()
            }
            processed_schools.append(meta_node)

    schools = processed_schools

    try:
        # 1. Prepare Nodes
        if dest_lat_param and dest_lon_param:
            dest_lat, dest_lon = float(dest_lat_param), float(dest_lon_param)
        else:
            dest_lat, dest_lon = geocoder.get_coordinates(destination_address)

        all_nodes = []
        # Destination Node (Index 0)
        all_nodes.append({
            'id': 'DEST',
            'name': 'Destination',
            'address': destination_address,
            'participants': 0,
            'lat': dest_lat,
            'lon': dest_lon,
            'institute': 'UNIVERSAL' # Compatible with all
        })

        index_to_school = {}
        for i, school in enumerate(schools):
            all_nodes.append({
                'id': school['id'],
                'name': school['name'],
                'address': school['address'],
                'participants': school['demand'],
                'lat': float(school.get('lat', 0)),
                'lon': float(school.get('lon', 0)),
                'institute': school['institute']
            })
            index_to_school[i + 1] = school

        # Add DUMMY START NODE (Index = len(all_nodes))
        # This node represents an "Anywhere" start point with 0 cost to all other nodes.
        dummy_node_index = len(all_nodes)
        all_nodes.append({
            'id': 'DUMMY_START',
            'name': 'Start',
            'address': '',
            'participants': 0,
            'lat': 0,
            'lon': 0,
            'institute': 'UNIVERSAL'
        })

        # 2. Time Matrix (seconds) — primary optimization objective
        # We process N real nodes. The matrix needs to be (N+1)x(N+1)
        real_node_count = len(all_nodes) - 1
        locations = [(n['lat'], n['lon']) for n in all_nodes[:real_node_count]]
        real_matrix = geocoder.get_time_matrix(locations)

        # Extend matrix for Dummy Node
        # Rows: Real nodes -> Real nodes (Keep)
        # Row: Dummy -> Real nodes (0 distance)
        # Col: Real nodes -> Dummy (Infinity? Or 0? Usually maximize to prevent using as shortcut, but it's start node so it only has outgoing)

        full_matrix = []
        for row in real_matrix:
            row.append(0)
            full_matrix.append(row)

        dummy_row = [0] * (real_node_count + 1)
        full_matrix.append(dummy_row)

        distance_matrix = full_matrix

        # 3. Demands & Solve
        demands = [n['participants'] for n in all_nodes]

        from optimizer_v2 import HumanStyleSolver
        solver = HumanStyleSolver(
            time_matrix=distance_matrix,
            demands=demands,
            vehicle_capacity=bus_capacity,
            cluster_threshold_minutes=cluster_threshold_minutes,
        )

        solution = solver.solve()

        if not solution:
             msg = "Nessuna soluzione trovata. Prova ad aumentare il numero di bus o la capacità, oppure verifica che la destinazione sia raggiungibile."
             if max_buses:
                 msg += f" (Hai forzato {max_buses} bus, forse non sono sufficienti per la capacità totale)"
             return jsonify({'error': msg}), 400

        # 4. Format Response (Outbound & Return)
        formatted_routes = []

        # Time estimation settings
        start_time_str = data.get('start_time', '08:00')  # Default 08:00
        try:
            start_hour, start_min = map(int, start_time_str.split(':'))
        except:
            start_hour, start_min = 8, 0
        AVERAGE_SPEED_KMH = 30  # Urban average speed
        STOP_DWELL_TIME_MIN = 3  # Minutes per pickup stop

        sorted_routes = sorted(solution['routes'], key=lambda x: x['vehicle_id'])

        for idx, route in enumerate(sorted_routes):
            current_vehicle_id = idx

            # Reconstruct stops with details
            stops_data = []
            for node_obj in route['stops']:
                node_idx = node_obj['node']

                # Skip Dummy Start Node in output
                if node_idx == dummy_node_index:
                    continue

                if node_idx == 0:
                    stops_data.append({
                        'type': 'destination',
                        'name': destination_address,
                        'load_change': 0,
                        'lat': dest_lat,
                        'lon': dest_lon
                    })
                else:
                    original_school = index_to_school[node_idx]
                    stops_data.append({
                        'type': 'pickup',
                        'name': original_school['name'],
                        'original_name': original_school.get('original_name', original_school['name']),
                        'address': original_school['address'],
                        'display_address': original_school.get('display_address') or original_school['address'],
                        'count': original_school['demand'],
                        'lat': original_school['lat'],
                        'lon': original_school['lon'],
                        'is_meta': original_school.get('is_meta', False),
                        'component_schools': original_school.get('component_schools', [])
                    })

            # Agglomerate: Merge consecutive stops from the same original school
            agglomerated_stops = []
            for stop in stops_data:
                if stop['type'] == 'destination':
                    agglomerated_stops.append(stop)
                elif agglomerated_stops and agglomerated_stops[-1]['type'] == 'pickup' and agglomerated_stops[-1].get('original_name') == stop.get('original_name'):
                    # Same school, merge
                    agglomerated_stops[-1]['count'] += stop['count']
                    agglomerated_stops[-1]['name'] = stop['original_name']  # Use clean name
                else:
                    # Different stop, add new
                    merged_stop = stop.copy()
                    merged_stop['name'] = stop['original_name']  # Use clean name without "Gruppo X"
                    agglomerated_stops.append(merged_stop)

            stops_data = agglomerated_stops

            # EXPAND META-NODES: Convert meta-nodes back to individual schools
            expanded_stops = []
            for stop in stops_data:
                if stop['type'] == 'pickup' and stop.get('is_meta'):
                    # This is a meta-node, expand it into component schools
                    component_schools = stop['component_schools']
                    for comp_school in component_schools:
                        expanded_stop = {
                            'type': 'pickup',
                            'name': comp_school['name'],
                            'original_name': comp_school.get('original_name', comp_school['name']),
                            'address': comp_school['address'],
                            'display_address': comp_school.get('display_address') or comp_school['address'],
                            'count': comp_school['demand'],
                            'lat': comp_school['lat'],
                            'lon': comp_school['lon'],
                            'from_meta': True  # Mark that this came from a meta-node
                        }
                        # Inherit timing from meta-node (all schools in meta-node share same time)
                        if 'departure_time' in stop:
                            expanded_stop['departure_time'] = stop['departure_time']
                        expanded_stops.append(expanded_stop)
                else:
                    # Regular stop (destination or non-meta school)
                    expanded_stops.append(stop)

            stops_data = expanded_stops

            # Pre-compute haversine segment distances (needed for time estimates and dist fallback)
            pickup_stops = [s for s in stops_data if s['type'] == 'pickup']
            seg_distances_m = []
            if pickup_stops:
                for i, stop in enumerate(pickup_stops):
                    ns = pickup_stops[i + 1] if i < len(pickup_stops) - 1 else {'lat': dest_lat, 'lon': dest_lon}
                    seg_distances_m.append(
                        geocoder.haversine_distance(stop['lat'], stop['lon'], ns['lat'], ns['lon'])
                    )

            # Fetch geometry for Outbound (includes real road leg distances + durations)
            geo_data = geocoder.get_route_geometry(stops_data)
            outbound_geometry = geo_data['geometry'] if geo_data else None
            outbound_dist = geo_data['distance'] if geo_data else int(sum(seg_distances_m))

            # Real per-leg distances from Google Directions (leg i = segment stop i → stop i+1)
            # Using these ensures sum(dist_to_next_km) == total bus distance in the header.
            leg_distances_m = geo_data.get('leg_distances') if geo_data else None
            leg_durations_s = geo_data.get('leg_durations') if geo_data else None

            # Calculate times FORWARD from first school departure
            # start_time = when bus departs from FIRST school
            if pickup_stops:
                total_haversine_m = sum(seg_distances_m) or 1

                # Use Google Directions total duration if available, else fall back to speed estimate
                total_drive_min = (geo_data['duration'] / 60) if geo_data and geo_data.get('duration') else None

                cumulative_minutes = start_hour * 60 + start_min

                for i, stop in enumerate(pickup_stops):
                    stop['departure_time'] = format_time_from_minutes(cumulative_minutes)

                    # Use real road leg distance/duration from Google when available (fallback: haversine)
                    if leg_distances_m and i < len(leg_distances_m):
                        seg_dist_m = leg_distances_m[i]
                        seg_drive_min = (leg_durations_s[i] / 60) if (leg_durations_s and i < len(leg_durations_s)) else (seg_dist_m / 1000 / AVERAGE_SPEED_KMH) * 60
                    else:
                        seg_dist_m = seg_distances_m[i]
                        if total_drive_min:
                            seg_drive_min = total_drive_min * (seg_dist_m / total_haversine_m)
                        else:
                            seg_drive_min = (seg_dist_m / 1000 / AVERAGE_SPEED_KMH) * 60

                    stop['dist_to_next_km'] = round(seg_dist_m / 1000, 2)
                    stop['time_to_next_min'] = round(seg_drive_min)
                    cumulative_minutes += STOP_DWELL_TIME_MIN + seg_drive_min

                # Destination arrival time
                for stop in stops_data:
                    if stop['type'] == 'destination':
                        stop['arrival_time'] = format_time_from_minutes(cumulative_minutes)

            formatted_routes.append({
                'vehicle_id': current_vehicle_id,
                'total_load': route['load'],
                'outbound': {
                    'stops': stops_data,
                    'geometry': outbound_geometry,
                    'distance': outbound_dist
                }
            })

        # POST-PROCESSING: Synchronize pickup times for schools split across buses
        # Find all schools and their departure times across all routes
        school_times = {}  # {original_name: [(route_idx, stop_idx, departure_time_minutes)]}

        for route_idx, route in enumerate(formatted_routes):
            for stop_idx, stop in enumerate(route['outbound']['stops']):
                if stop['type'] == 'pickup':
                    original_name = stop.get('original_name', stop['name'])
                    if original_name not in school_times:
                        school_times[original_name] = []
                    # Parse the departure time
                    if 'departure_time' in stop:
                        minutes = parse_time_to_minutes(stop['departure_time'])
                        school_times[original_name].append({
                            'route_idx': route_idx,
                            'stop_idx': stop_idx,
                            'minutes': minutes
                        })

        # For schools with multiple entries, synchronize to the LATEST time
        for school_name, times in school_times.items():
            if len(times) > 1:
                # Find the latest departure time
                latest_minutes = max(t['minutes'] for t in times)
                latest_time_str = format_time_from_minutes(latest_minutes)

                # Update all stops for this school to use synchronized time
                for t in times:
                    stop = formatted_routes[t['route_idx']]['outbound']['stops'][t['stop_idx']]
                    stop['departure_time'] = latest_time_str
                    stop['synchronized'] = True  # Mark as synchronized

        # POST-PROCESSING: Synchronize arrival times (ONLY in arrival mode)
        # Collect all arrival times
        time_mode = data.get('time_mode', 'arrival')  # 'departure' or 'arrival'
        arrival_times_minutes = []

        for route in formatted_routes:
            for stop in route['outbound']['stops']:
                if stop['type'] == 'destination' and 'arrival_time' in stop:
                    minutes = parse_time_to_minutes(stop['arrival_time'])
                    arrival_times_minutes.append(minutes)

        if arrival_times_minutes:
            earliest_arrival = min(arrival_times_minutes)
            latest_arrival = max(arrival_times_minutes)
            current_spread = latest_arrival - earliest_arrival

            # ONLY synchronize arrivals if in ARRIVAL mode
            if time_mode == 'arrival':
                # User specified ARRIVAL time - all buses should arrive at this time
                target_time_str = data.get('start_time', '08:00')
                try:
                    th, tm = map(int, target_time_str.split(':'))
                    target_arrival_minutes = th * 60 + tm
                except:
                    target_arrival_minutes = 8 * 60  # Default 08:00

                # Recalculate departure times to synchronize arrivals to target time
                for route in formatted_routes:
                    stops = route['outbound']['stops']
                    dest_stop = None
                    for stop in stops:
                        if stop['type'] == 'destination':
                            dest_stop = stop
                            break

                    if dest_stop and 'arrival_time' in dest_stop:
                        current_arrival = parse_time_to_minutes(dest_stop['arrival_time'])

                        # Calculate time shift needed to hit target arrival
                        # If Current is 08:15 and Target is 08:00 -> Shift is -15 (shift backwards)
                        # If Current is 07:45 and Target is 08:00 -> Shift is +15 (shift forwards)
                        delay_minutes = target_arrival_minutes - current_arrival

                        # Shift all times for this route
                        for stop in stops:
                            if stop['type'] == 'pickup' and 'departure_time' in stop:
                                old_minutes = parse_time_to_minutes(stop['departure_time'])
                                new_minutes = old_minutes + delay_minutes
                                stop['departure_time'] = format_time_from_minutes(new_minutes)
                            elif stop['type'] == 'destination' and 'arrival_time' in stop:
                                old_minutes = parse_time_to_minutes(stop['arrival_time'])
                                new_minutes = old_minutes + delay_minutes
                                stop['arrival_time'] = format_time_from_minutes(new_minutes)

                # Recalculate arrival times after synchronization
                final_arrival_times = []
                for route in formatted_routes:
                    for stop in route['outbound']['stops']:
                        if stop['type'] == 'destination' and 'arrival_time' in stop:
                            minutes = parse_time_to_minutes(stop['arrival_time'])
                            final_arrival_times.append(minutes)

                final_earliest = min(final_arrival_times) if final_arrival_times else 0
                final_latest = max(final_arrival_times) if final_arrival_times else 0
                final_spread = final_latest - final_earliest
            else:
                # DEPARTURE mode: No arrival synchronization, buses arrive naturally
                final_earliest = earliest_arrival
                final_latest = latest_arrival
                final_spread = current_spread

            arrival_window = {
                'earliest': format_time_from_minutes(final_earliest),
                'latest': format_time_from_minutes(final_latest),
                'spread_minutes': final_spread
            }
        else:
            arrival_window = None

        # POST-PROCESSING: Return times (optional, when fine_manifestazione is provided)
        fine_manifestazione = data.get('fine_manifestazione', '').strip()
        calculate_return = data.get('calculate_return', True)
        if calculate_return and fine_manifestazione:
            calculate_return_times_for_routes(formatted_routes, fine_manifestazione)

        # Calculate Totals
        total_outbound = sum([r['outbound']['distance'] for r in formatted_routes])

        # Calculate Overlaps
        overlaps = find_bus_overlaps(formatted_routes, min_overlap_meters=30)

        return jsonify({
            'routes': formatted_routes,
            'overlaps': overlaps,
            'stats': {
                'total_buses': solution['used_vehicles'],
                'total_passengers': solution['total_load'],
                'outbound_distance': total_outbound,
                'total_distance': total_outbound,
                'arrival_window': arrival_window,
                'fine_manifestazione': fine_manifestazione if (calculate_return and fine_manifestazione) else None,
            }
        }), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

# ── Fixture address tool ─────────────────────────────────────────────────────

REALSUITE_DIR = os.path.join(os.path.dirname(__file__), 'tests', 'realSuite')

# ─── In-memory institute index (name → {address → {lat, lon, count}}) ─────────

_institutes_index: dict | None = None


def _fixture_dir(fixture_name):
    """Resolve a fixture folder inside tests/realSuite, or None if the name escapes it."""
    if not fixture_name or fixture_name.startswith('.') or os.path.basename(fixture_name) != fixture_name:
        return None
    return os.path.join(REALSUITE_DIR, fixture_name)


def _build_institutes_index() -> dict:
    """Scan all realSuite fixtures once and build a name→address→{lat,lon,count} index."""
    import time as _time
    result: dict = {}
    try:
        dirs = sorted(os.listdir(REALSUITE_DIR))
    except OSError:
        return result
    for dir_name in dirs:
        if dir_name in ('archive', 'pending'):
            continue
        ev_dir_p   = os.path.join(REALSUITE_DIR, dir_name)
        input_p    = os.path.join(ev_dir_p, 'input.xlsx')
        coords_p   = os.path.join(ev_dir_p, 'coords.json')
        if not os.path.isdir(ev_dir_p) or not os.path.exists(input_p):
            continue
        coords: dict = {}
        if os.path.exists(coords_p):
            try:
                with open(coords_p, encoding='utf-8') as f:
                    coords = json.load(f)
            except Exception:
                pass
        # Retry reading Excel in case file is temporarily locked after a write
        df = None
        for attempt in range(3):
            try:
                df = pd.read_excel(input_p)
                df.columns = [c.strip() for c in df.columns]
                break
            except Exception as exc:
                if attempt < 2:
                    _time.sleep(0.15)
                else:
                    print(f'[institutes_index] Failed to read {input_p} after 3 attempts: {exc}')
        if df is None:
            continue
        seen: dict = {}
        for row_idx, row in df.iterrows():
            name    = str(row.get('Nome', '')).strip()
            address = str(row.get('Indirizzo', '')).strip()
            if not name or name.lower() == 'nan' or not address or address.lower() == 'nan':
                continue
            count = seen.get(name, 0)
            key   = name if count == 0 else f"{name}|{int(row_idx)}"
            seen[name] = count + 1
            entry = coords.get(key, {})
            lat = entry.get('lat')
            lon = entry.get('lon')
            if name not in result:
                result[name] = {}
            if address not in result[name]:
                result[name][address] = {'lat': lat, 'lon': lon, 'count': 0}
            elif lat is not None and result[name][address]['lat'] is None:
                result[name][address]['lat'] = lat
                result[name][address]['lon'] = lon
            result[name][address]['count'] += 1
    return result


def _get_institutes_index() -> dict:
    global _institutes_index
    if _institutes_index is None:
        _institutes_index = _build_institutes_index()
    return _institutes_index


def _invalidate_institutes_index() -> None:
    global _institutes_index
    _institutes_index = None


def _fixture_is_geocoded(ev_dir):
    """
    Returns True if every school in input.xlsx has coords in coords.json.
    """
    input_path  = os.path.join(ev_dir, 'input.xlsx')
    coords_path = os.path.join(ev_dir, 'coords.json')
    if not os.path.exists(coords_path):
        return False
    try:
        df = pd.read_excel(input_path)
        df.columns = [c.strip() for c in df.columns]
        coords = json.load(open(coords_path, encoding='utf-8'))
        seen = {}
        for row_idx, row in df.iterrows():
            name  = str(row['Nome']).strip()
            count = seen.get(name, 0)
            key   = name if count == 0 else f"{name}|{int(row_idx)}"
            seen[name] = count + 1
            entry = coords.get(key, {})
            if entry.get('lat') is None or entry.get('lon') is None:
                return False
        return True
    except Exception:
        return False


@app.route('/api/fixtures', methods=['GET'])
def list_fixtures():
    """Return sorted list of fixture directory names that have an input.xlsx,
    with a 'geocoded' flag indicating whether all stops have coordinates."""
    try:
        names = sorted(
            name for name in os.listdir(REALSUITE_DIR)
            if os.path.isdir(os.path.join(REALSUITE_DIR, name))
            and os.path.exists(os.path.join(REALSUITE_DIR, name, 'input.xlsx'))
            and name not in ('archive', 'pending')
        )
        fixtures = [
            {'name': name, 'geocoded': _fixture_is_geocoded(os.path.join(REALSUITE_DIR, name))}
            for name in names
        ]
        return jsonify({'fixtures': fixtures}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/fixtures/<fixture_name>', methods=['GET'])
def get_fixture(fixture_name):
    """
    Return config + stops list for one fixture.
    Each stop includes coords_key recomputed from row order using the same
    first-seen / compound-key logic as _build_coords_json in prepare_realSuite.py,
    so duplicate-Nome cases are handled correctly even on legacy files.
    """
    ev_dir      = _fixture_dir(fixture_name)
    if ev_dir is None:
        return jsonify({'error': 'Fixture not found'}), 404
    input_path  = os.path.join(ev_dir, 'input.xlsx')
    config_path = os.path.join(ev_dir, 'config.json')
    coords_path = os.path.join(ev_dir, 'coords.json')

    if not os.path.exists(input_path):
        return jsonify({'error': 'Fixture not found'}), 404

    try:
        df = pd.read_excel(input_path)
        df.columns = [c.strip() for c in df.columns]

        config = {}
        if os.path.exists(config_path):
            with open(config_path, encoding='utf-8') as f:
                config = json.load(f)

        coords = {}
        if os.path.exists(coords_path):
            with open(coords_path, encoding='utf-8') as f:
                coords = json.load(f)

        seen = {}
        stops = []
        for row_idx, row in df.iterrows():
            name    = str(row['Nome']).strip()
            address = str(row['Indirizzo']).strip()
            participants = int(row['Partecipanti']) if pd.notna(row.get('Partecipanti')) else 0
            institute = (
                str(row['Istituto']).strip()
                if 'Istituto' in df.columns and pd.notna(row.get('Istituto'))
                else None
            )
            count = seen.get(name, 0)
            coords_key = name if count == 0 else f"{name}|{int(row_idx)}"
            seen[name] = count + 1

            entry = coords.get(coords_key, {})
            stops.append({
                'idx':          int(row_idx),
                'name':         name,
                'address':      address,
                'lat':          entry.get('lat'),
                'lon':          entry.get('lon'),
                'participants': participants,
                'institute':    institute,
                'coords_key':   coords_key,
            })

        return jsonify({'config': config, 'stops': stops}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/fixtures/<fixture_name>/stops/<int:idx>', methods=['POST'])
def update_fixture_stop(fixture_name, idx):
    """
    Update a stop's address in input.xlsx and its coordinates in coords.json.
    Body: {"address": "...", "lat": float, "lon": float}
    """
    data        = request.get_json()
    new_address = data.get('address', '').strip()
    new_lat     = float(data['lat'])
    new_lon     = float(data['lon'])

    ev_dir      = _fixture_dir(fixture_name)
    if ev_dir is None:
        return jsonify({'error': 'Fixture not found'}), 404
    input_path  = os.path.join(ev_dir, 'input.xlsx')
    coords_path = os.path.join(ev_dir, 'coords.json')

    if not os.path.exists(input_path):
        return jsonify({'error': 'Fixture not found'}), 404

    try:
        # 1. Update input.xlsx
        df = pd.read_excel(input_path)
        df.columns = [c.strip() for c in df.columns]
        if idx not in df.index:
            return jsonify({'error': f'Row index {idx} not found'}), 404
        df.at[idx, 'Indirizzo'] = new_address
        df.to_excel(input_path, index=False)

        # 2. Recompute coords_key for the updated row
        seen = {}
        coords_key_for_idx = None
        for row_idx, row in df.iterrows():
            name  = str(row['Nome']).strip()
            count = seen.get(name, 0)
            key   = name if count == 0 else f"{name}|{int(row_idx)}"
            seen[name] = count + 1
            if row_idx == idx:
                coords_key_for_idx = key

        if coords_key_for_idx is None:
            return jsonify({'error': 'Could not determine coords_key'}), 500

        # 3. Update coords.json
        coords = {}
        if os.path.exists(coords_path):
            with open(coords_path, encoding='utf-8') as f:
                coords = json.load(f)
        coords[coords_key_for_idx] = {'lat': new_lat, 'lon': new_lon}
        with open(coords_path, 'w', encoding='utf-8') as f:
            json.dump(coords, f, ensure_ascii=False, indent=2)

        # Persist to school_address_cache so the corrected address appears in suggestions
        stop_name = str(df.at[idx, 'Nome']).strip()
        _school_cache.save(stop_name, new_address)
        _invalidate_institutes_index()

        return jsonify({'ok': True, 'coords_key': coords_key_for_idx}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/fixtures/<fixture_name>/rebuild_matrices', methods=['POST'])
def rebuild_fixture_matrices(fixture_name):
    """
    Rebuild time_matrix.json and distance_matrix.json for a fixture using
    the coordinates currently in coords.json (including any user edits).
    Schools without coords in coords.json are geocoded from their address.
    Also updates config.json with destination_lat/lon if missing.

    Returns: {"ok": True, "geocoded_new": N, "total": M}
    """
    ev_dir      = _fixture_dir(fixture_name)
    if ev_dir is None:
        return jsonify({'error': 'Fixture not found'}), 404
    input_path  = os.path.join(ev_dir, 'input.xlsx')
    config_path = os.path.join(ev_dir, 'config.json')
    coords_path = os.path.join(ev_dir, 'coords.json')
    matrix_path = os.path.join(ev_dir, 'time_matrix.json')
    dist_path   = os.path.join(ev_dir, 'distance_matrix.json')

    if not os.path.exists(input_path):
        return jsonify({'error': 'Fixture not found'}), 404

    try:
        df = pd.read_excel(input_path)
        df.columns = [c.strip() for c in df.columns]

        config = {}
        if os.path.exists(config_path):
            with open(config_path, encoding='utf-8') as f:
                config = json.load(f)

        # Load existing coords (may include user edits)
        existing_coords = {}
        if os.path.exists(coords_path):
            with open(coords_path, encoding='utf-8') as f:
                existing_coords = json.load(f)

        # Build school list with coords_keys (same logic as get_fixture)
        seen = {}
        schools = []
        for row_idx, row in df.iterrows():
            name    = str(row['Nome']).strip()
            address = str(row['Indirizzo']).strip()
            count   = seen.get(name, 0)
            key     = name if count == 0 else f"{name}|{int(row_idx)}"
            seen[name] = count + 1
            entry = existing_coords.get(key, {})
            schools.append({
                'name':      name,
                'address':   address,
                'coords_key': key,
                'lat':       entry.get('lat'),
                'lon':       entry.get('lon'),
            })

        # Geocode schools that still have no coords
        geocoded_new = 0
        for s in schools:
            if s['lat'] is None or s['lon'] is None:
                lat, lon = geocoder.get_coordinates(s['address'])
                s['lat'] = lat
                s['lon'] = lon
                existing_coords[s['coords_key']] = {'lat': lat, 'lon': lon}
                geocoded_new += 1

        # Persist updated coords.json
        with open(coords_path, 'w', encoding='utf-8') as f:
            json.dump(existing_coords, f, ensure_ascii=False, indent=2)

        # Geocode destination if missing
        dest_lat = config.get('destination_lat')
        dest_lon = config.get('destination_lon')
        if (dest_lat is None or dest_lon is None) and config.get('destination'):
            dest_lat, dest_lon = geocoder.get_coordinates(config['destination'])
            config['destination_lat'] = dest_lat
            config['destination_lon'] = dest_lon
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(config, f, ensure_ascii=False, indent=2)

        if dest_lat is None or dest_lon is None:
            return jsonify({'error': 'Destination coordinates not available — set destination in config first'}), 400

        # Build locations list: destination at index 0, schools at 1..N
        locations = [(dest_lat, dest_lon)] + [(s['lat'], s['lon']) for s in schools]

        # Rebuild time_matrix.json
        time_matrix = geocoder.get_time_matrix(locations)
        with open(matrix_path, 'w', encoding='utf-8') as f:
            json.dump(time_matrix, f, ensure_ascii=False)

        # Rebuild distance_matrix.json
        dist_matrix = geocoder.get_distance_matrix(locations)
        with open(dist_path, 'w', encoding='utf-8') as f:
            json.dump(dist_matrix, f, ensure_ascii=False)

        _invalidate_institutes_index()
        return jsonify({
            'ok': True,
            'geocoded_new': geocoded_new,
            'total': len(schools),
            'geocoded': _fixture_is_geocoded(ev_dir),
        }), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/fixtures/institutes', methods=['GET'])
def list_fixture_institutes():
    """
    Return all unique (school_name, address) pairs from all realSuite fixtures,
    grouped by school name, with coords and usage count.
    """
    try:
        idx = _get_institutes_index()
        result = []
        for name in sorted(idx.keys()):
            entries = []
            for address, meta in sorted(idx[name].items(), key=lambda x: -x[1]['count']):
                entries.append({
                    'address':       address,
                    'lat':           meta['lat'],
                    'lon':           meta['lon'],
                    'fixture_count': meta['count'],
                })
            result.append({'name': name, 'entries': entries})
        return jsonify({'institutes': result}), 200
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def _apply_update_to_fixture(ev_dir, old_name, old_address, new_name, new_address, new_lat, new_lon):
    """
    In a single fixture directory, rename all rows where Nome==old_name AND
    Indirizzo==old_address to (new_name, new_address), updating coords.json keys
    and optionally the stored coordinates. Returns True if anything was changed.
    """
    input_path  = os.path.join(ev_dir, 'input.xlsx')
    coords_path = os.path.join(ev_dir, 'coords.json')
    if not os.path.exists(input_path):
        return False

    df = pd.read_excel(input_path)
    df.columns = [c.strip() for c in df.columns]

    mask = (df['Nome'].astype(str).str.strip() == old_name) & \
           (df['Indirizzo'].astype(str).str.strip() == old_address)
    if not mask.any():
        return False

    # Compute OLD coords_keys (before update)
    old_keys = {}
    seen = {}
    for row_idx, row in df.iterrows():
        n = str(row['Nome']).strip()
        cnt = seen.get(n, 0)
        key = n if cnt == 0 else f"{n}|{int(row_idx)}"
        seen[n] = cnt + 1
        if mask.loc[row_idx]:
            old_keys[int(row_idx)] = key

    # Apply update
    df.loc[mask, 'Nome']      = new_name
    df.loc[mask, 'Indirizzo'] = new_address

    # Compute NEW coords_keys (after update)
    new_keys = {}
    seen = {}
    for row_idx, row in df.iterrows():
        n = str(row['Nome']).strip()
        cnt = seen.get(n, 0)
        key = n if cnt == 0 else f"{n}|{int(row_idx)}"
        seen[n] = cnt + 1
        if int(row_idx) in old_keys:
            new_keys[int(row_idx)] = key

    # Update coords.json
    coords = {}
    if os.path.exists(coords_path):
        with open(coords_path, encoding='utf-8') as f:
            coords = json.load(f)
    for row_idx, old_key in old_keys.items():
        new_key   = new_keys[row_idx]
        old_entry = coords.pop(old_key, {})
        if new_lat is not None and new_lon is not None:
            coords[new_key] = {'lat': new_lat, 'lon': new_lon}
        elif old_entry:
            coords[new_key] = old_entry

    df.to_excel(input_path, index=False)
    with open(coords_path, 'w', encoding='utf-8') as f:
        json.dump(coords, f, ensure_ascii=False, indent=2)
    return True


def _apply_delete_to_fixture(ev_dir, name, address):
    """
    Remove all rows where Nome==name AND Indirizzo==address from a fixture,
    cleaning up coords.json accordingly. Returns True if anything was removed.
    """
    input_path  = os.path.join(ev_dir, 'input.xlsx')
    coords_path = os.path.join(ev_dir, 'coords.json')
    if not os.path.exists(input_path):
        return False

    df = pd.read_excel(input_path)
    df.columns = [c.strip() for c in df.columns]

    mask = (df['Nome'].astype(str).str.strip() == name) & \
           (df['Indirizzo'].astype(str).str.strip() == address)
    if not mask.any():
        return False

    # Collect coords_keys for rows being removed
    seen = {}
    keys_to_remove = []
    for row_idx, row in df.iterrows():
        n = str(row['Nome']).strip()
        cnt = seen.get(n, 0)
        key = n if cnt == 0 else f"{n}|{int(row_idx)}"
        seen[n] = cnt + 1
        if mask.loc[row_idx]:
            keys_to_remove.append(key)

    df = df[~mask].reset_index(drop=True)

    coords = {}
    if os.path.exists(coords_path):
        with open(coords_path, encoding='utf-8') as f:
            coords = json.load(f)
    for key in keys_to_remove:
        coords.pop(key, None)

    df.to_excel(input_path, index=False)
    with open(coords_path, 'w', encoding='utf-8') as f:
        json.dump(coords, f, ensure_ascii=False, indent=2)
    return True


@app.route('/api/fixtures/institutes/update', methods=['POST'])
def update_institute_entry():
    """
    Rename a (name, address) entry across all fixture files.
    Body: {old_name, old_address, new_name, new_address, new_lat?, new_lon?, force_merge?}
    If (new_name, new_address) already exists in the index (under a different entry)
    and force_merge is False, returns {conflict: {name, address, fixture_count}}.
    """
    data        = request.get_json()
    old_name    = data.get('old_name', '').strip()
    old_address = data.get('old_address', '').strip()
    new_name    = data.get('new_name', '').strip()
    new_address = data.get('new_address', '').strip()
    new_lat     = data.get('new_lat')
    new_lon     = data.get('new_lon')
    force_merge = data.get('force_merge', False)

    if not (old_name and old_address and new_name and new_address):
        return jsonify({'error': 'Campi obbligatori mancanti'}), 400
    if old_name == new_name and old_address == new_address and new_lat is None:
        return jsonify({'ok': True, 'modified': []}), 200

    if not force_merge:
        idx = _get_institutes_index()
        # Check if target (new_name, new_address) already exists as a different entry
        target_exists = (
            new_name in idx and
            new_address in idx.get(new_name, {}) and
            not (old_name == new_name and old_address == new_address)
        )
        # Or: same address used by a different school name
        address_conflict = None
        if not target_exists and new_address.strip().lower() != old_address.strip().lower():
            for en, addr_map in idx.items():
                for ea in addr_map:
                    if ea.strip().lower() == new_address.strip().lower() and \
                       not (en == old_name and ea == old_address):
                        address_conflict = {'name': en, 'address': ea,
                                            'fixture_count': addr_map[ea]['count']}
                        break
                if address_conflict:
                    break
        if target_exists:
            m = idx[new_name][new_address]
            return jsonify({'conflict': {'name': new_name, 'address': new_address,
                                         'fixture_count': m['count']}}), 200
        if address_conflict:
            return jsonify({'conflict': address_conflict}), 200

    modified = []
    try:
        for dir_name in sorted(os.listdir(REALSUITE_DIR)):
            if dir_name in ('archive', 'pending'):
                continue
            ev_dir = os.path.join(REALSUITE_DIR, dir_name)
            if not os.path.isdir(ev_dir):
                continue
            if _apply_update_to_fixture(ev_dir, old_name, old_address, new_name, new_address,
                                         new_lat, new_lon):
                modified.append(dir_name)

        if new_lat is not None or new_name != old_name:
            _school_cache.save(new_name, new_address)
        _invalidate_institutes_index()
        return jsonify({'ok': True, 'modified': modified}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/fixtures/institutes', methods=['DELETE'])
def delete_institute_entry():
    """
    Remove a (name, address) entry from all fixture files.
    Body: {name, address}
    """
    data    = request.get_json()
    name    = data.get('name', '').strip()
    address = data.get('address', '').strip()
    if not (name and address):
        return jsonify({'error': 'Campi name e address obbligatori'}), 400

    modified = []
    try:
        for dir_name in sorted(os.listdir(REALSUITE_DIR)):
            if dir_name in ('archive', 'pending'):
                continue
            ev_dir = os.path.join(REALSUITE_DIR, dir_name)
            if not os.path.isdir(ev_dir):
                continue
            if _apply_delete_to_fixture(ev_dir, name, address):
                modified.append(dir_name)

        _invalidate_institutes_index()
        return jsonify({'ok': True, 'modified': modified}), 200
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/school_cache/suggest', methods=['GET'])
def suggest_school_address():
    """
    Return up to 5 address suggestions for a school name from the fixture index.
    Query params: name (required), address (optional, for scoring)
    """
    from difflib import SequenceMatcher

    name    = request.args.get('name', '').strip()
    address = request.args.get('address', '').strip()
    if not name:
        return jsonify({'suggestions': []}), 200

    name_lower = name.lower()
    idx = _get_institutes_index()
    candidates = []

    for cached_name, addr_map in idx.items():
        score = SequenceMatcher(None, name_lower, cached_name.lower()).ratio()
        if score < 0.55:
            continue
        for addr, meta in addr_map.items():
            if address and addr.strip().lower() == address.strip().lower():
                continue  # skip exact same address (not helpful)
            candidates.append({
                'name':          cached_name,
                'address':       addr,
                'lat':           meta['lat'],
                'lon':           meta['lon'],
                'fixture_count': meta['count'],
                '_score':        score,
            })

    candidates.sort(key=lambda c: (-c['_score'], -c['fixture_count']))
    for c in candidates:
        del c['_score']

    return jsonify({'suggestions': candidates[:5]}), 200


# Google Places API (New), used only when GOOGLE_PLACES_API_KEY is set (server-side only,
# never sent to the browser). Autocomplete + details share a session token so Google
# bills the pair as one session.
_PLACES_BIAS = {'rectangle': {'low': {'latitude': 45.6, 'longitude': 10.4}, 'high': {'latitude': 46.95, 'longitude': 12.2}}}


def _places_key():
    # GOOGLE_MAPS_API_KEY is the key already configured locally and on Cloud Run
    return os.environ.get('GOOGLE_PLACES_API_KEY') or os.environ.get('GOOGLE_MAPS_API_KEY')


# Recent Google predictions per query (in memory): repeated searches don't cost again
_PLACES_CACHE = {}
_PLACES_CACHE_MAX = 300
_PLACES_CACHE_TTL = 3600


def _google_autocomplete(query, session):
    """
    Predictions from Google Places Autocomplete, or None when Google must not or
    can't be used: no key, monthly cap reached, counter unreachable, error, 429,
    timeout. The caller then falls back to Nominatim.
    Only the typed destination / new-stop search reaches here; geocoding of
    uploads, imports and recalculations never uses Google.
    """
    key = _places_key()
    if not key:
        return None
    cache_key = query.lower()
    hit = _PLACES_CACHE.get(cache_key)
    if hit and hit[0] > time.time():
        return hit[1]
    import places_usage
    if not places_usage.allow('autocomplete'):
        return None
    import requests as req
    body = {'input': query, 'languageCode': 'it', 'includedRegionCodes': ['it'], 'locationBias': _PLACES_BIAS}
    if session:
        body['sessionToken'] = session
    try:
        resp = req.post('https://places.googleapis.com/v1/places:autocomplete', json=body,
                        headers={'X-Goog-Api-Key': key}, timeout=6)
        if resp.status_code != 200:
            print(f"[Autocomplete] Google HTTP {resp.status_code}: {resp.text[:200]}")
            return None
        out = []
        for sug in resp.json().get('suggestions', []):
            p = sug.get('placePrediction')
            if not p:
                continue
            fmt = p.get('structuredFormat', {})
            out.append({
                'place_id': f"g_{p['placeId']}",
                'description': p.get('text', {}).get('text', ''),
                'structured_formatting': {
                    'main_text': fmt.get('mainText', {}).get('text', ''),
                    'secondary_text': fmt.get('secondaryText', {}).get('text', ''),
                },
                'types': ['establishment' if 'establishment' in p.get('types', []) else 'geocode'],
                'source': 'google',
            })
        if len(_PLACES_CACHE) >= _PLACES_CACHE_MAX:
            _PLACES_CACHE.pop(next(iter(_PLACES_CACHE)))
        _PLACES_CACHE[cache_key] = (time.time() + _PLACES_CACHE_TTL, out)
        return out
    except Exception as e:
        print(f"[Autocomplete] Google error: {e}")
        return None


@app.route('/api/places/details', methods=['GET'])
@rate_limit(60)
def places_details():
    """Coordinates of a Google place picked from the suggestions."""
    place_id = request.args.get('place_id', '')
    session = request.args.get('session', '')
    key = _places_key()
    if not key or not place_id.startswith('g_'):
        return jsonify({'error': 'Dettagli non disponibili'}), 400
    import places_usage
    if not places_usage.allow('details'):
        return jsonify({'error': 'Limite mensile raggiunto'}), 429
    import requests as req
    params = {'languageCode': 'it'}
    if session:
        params['sessionToken'] = session
    try:
        resp = req.get(f"https://places.googleapis.com/v1/places/{place_id[2:]}", params=params,
                       headers={'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'location,formattedAddress,displayName'},
                       timeout=6)
        if resp.status_code != 200:
            print(f"[Places details] Google HTTP {resp.status_code}: {resp.text[:200]}")
            return jsonify({'error': 'Dettagli non disponibili'}), 502
        d = resp.json()
        loc = d.get('location', {})
        return jsonify({
            'lat': loc.get('latitude'), 'lon': loc.get('longitude'),
            'address': d.get('formattedAddress', ''), 'name': d.get('displayName', {}).get('text', ''),
        })
    except Exception as e:
        print(f"[Places details] Google error: {e}")
        return jsonify({'error': 'Dettagli non disponibili'}), 502


@app.route('/api/places/autocomplete', methods=['GET'])
@rate_limit(120)
def places_autocomplete():
    """Address autocomplete: Google Places when configured, else (or on failure) Nominatim (OSM)."""
    query = request.args.get('q', '').strip()
    if len(query) < 2:
        return jsonify({'predictions': [], 'status': 'OK'})

    google = _google_autocomplete(query, request.args.get('session', '').strip()) if len(query) >= 3 else None
    if google is not None:
        return jsonify({'predictions': google, 'status': 'OK', 'source': 'google'}), 200

    import requests as req
    import nominatim_cache as _nc
    search_status = 'OK'
    cached = _nc.get(query, 5)
    if cached:
        results = cached
    else:
        try:
            resp = req.get(
                'https://nominatim.openstreetmap.org/search',
                params={
                    'q': query,
                    'format': 'json',
                    'countrycodes': 'it',
                    'limit': 5,
                    'viewbox': '10.4,45.6,12.2,46.95',
                    'bounded': 0,
                    'addressdetails': 1,
                },
                headers={'User-Agent': 'BusPlan/1.0 (bus route optimizer for Trentino schools)'},
                timeout=8,
            )
            if resp.status_code == 200:
                results = resp.json()
            else:
                print(f"[Autocomplete] Nominatim HTTP {resp.status_code}")
                search_status = 'UNAVAILABLE'
                results = []
            if results:
                _nc.store(query, 5, results)
        except Exception as e:
            print(f"[Autocomplete] Nominatim error: {e}")
            search_status = 'UNAVAILABLE'
            results = []

    # Map OSM class/type to a simplified icon type the frontend understands
    def _osm_type(r):
        osm_class = r.get('class', '')
        osm_type = r.get('type', '')
        if osm_class == 'highway':
            return 'route'
        if osm_class in ('amenity', 'building', 'shop', 'tourism'):
            return 'establishment'
        return 'geocode'

    predictions = []
    for r in results:
        display = r.get('display_name', '')
        parts = [p.strip() for p in display.split(',')]
        main_text = ', '.join(parts[:2]) if len(parts) >= 2 else display
        secondary_text = ', '.join(parts[2:]) if len(parts) > 2 else ''
        predictions.append({
            'place_id': f"osm_{r.get('osm_type', 'node')}_{r.get('osm_id', '')}",
            'description': display,
            'structured_formatting': {
                'main_text': main_text,
                'secondary_text': secondary_text,
            },
            'types': [_osm_type(r)],
            'lat': float(r['lat']),
            'lon': float(r['lon']),
        })

    return jsonify({'predictions': predictions, 'status': search_status}), 200


TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), 'template_documents')
PIANO_VIAGGI_TEMPLATE   = os.path.join(TEMPLATES_DIR, 'Piano_Viaggi_TIPO.docx')
RICHIESTA_TEMPLATE      = os.path.join(TEMPLATES_DIR, 'Richiesta servizioTIPO_nome evento_data.docx')


@app.route('/api/export_document', methods=['POST'])
@rate_limit(30)
def export_document():
    """
    Generate a Word document from a template and return it as a download.

    Body (JSON):
      doc_type        : 'piano_viaggi' | 'richiesta_servizio'
      format          : 'docx'  (pdf not supported yet)
      event_name      : str
      date            : str (already formatted Italian date, e.g. "15 aprile 2026")
      destination     : str
      start_time      : str (HH:MM)
      end_time        : str (HH:MM)
      exclude_autonomia : bool
      routes          : list of route objects from /api/optimize
    """
    data = request.get_json()
    doc_type = data.get('doc_type', 'piano_viaggi')

    template_path = RICHIESTA_TEMPLATE if doc_type == 'richiesta_servizio' else PIANO_VIAGGI_TEMPLATE
    if not os.path.exists(template_path):
        return jsonify({'error': f'Template non trovato: {template_path}'}), 500

    try:
        tmp = tempfile.NamedTemporaryFile(suffix='.docx', delete=False)
        tmp.close()
        out_path = tmp.name

        generator = generate_richiesta_servizio if doc_type == 'richiesta_servizio' else generate_piano_viaggi
        generator(template_path, out_path, data)

        base_name = 'Richiesta_Servizio' if doc_type == 'richiesta_servizio' else 'Piano_Viaggi'
        event_slug = (data.get('event_name') or 'Evento').replace(' ', '_')
        download_name = f'{base_name}_{event_slug}.docx'

        response = send_file(out_path, as_attachment=True, download_name=download_name,
                             mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document')

        @response.call_on_close
        def _cleanup():
            try:
                os.remove(out_path)
            except OSError:
                pass

        return response
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/download/<path:filename>', methods=['GET'])
def download_corrected_file(filename):
    """Serves a corrected Excel file from the uploads folder, then deletes it."""
    from werkzeug.utils import safe_join
    # safe_join returns None for names that would leave uploads/ (e.g. '../app.py')
    safe_path = safe_join(UPLOAD_FOLDER, filename)
    if not safe_path or not os.path.isfile(safe_path):
        return jsonify({'error': 'File non trovato'}), 404
    response = send_from_directory(UPLOAD_FOLDER, filename, as_attachment=True)
    # Delete after sending so the folder stays clean
    @response.call_on_close
    def _cleanup():
        try:
            os.remove(safe_path)
        except OSError:
            pass
    return response


@app.route('/api/evaluate_plan', methods=['POST'])
@rate_limit(60)
def evaluate_plan():
    data = request.json
    custom_routes = data.get('routes', [])
    destination_address = data.get('destination', '')
    
    dest_lat = data.get('dest_lat')
    dest_lon = data.get('dest_lon')
    if (not dest_lat or not dest_lon) and destination_address:
        dest_lat, dest_lon = geocoder.get_coordinates(destination_address)

    try:
        formatted_routes = []
        start_time_str = data.get('start_time', '08:00')
        try:
            start_hour, start_min = map(int, start_time_str.split(':'))
        except:
            start_hour, start_min = 8, 0
        AVERAGE_SPEED_KMH = 30
        STOP_DWELL_TIME_MIN = 3
        
        for idx, custom_route in enumerate(custom_routes):
            current_vehicle_id = custom_route.get('vehicle_id', idx)
            original_stops = custom_route.get('outbound', {}).get('stops', [])
            
            stops_data = original_stops
            pickup_stops = [s for s in stops_data if s['type'] == 'pickup']
            
            # Recalculating everything based on the given pickup stops.
            seg_distances_m = []
            if pickup_stops:
                for i, stop in enumerate(pickup_stops):
                    ns = pickup_stops[i + 1] if i < len(pickup_stops) - 1 else {'lat': dest_lat, 'lon': dest_lon}
                    seg_distances_m.append(
                        geocoder.haversine_distance(float(stop.get('lat', 0)), float(stop.get('lon', 0)), float(ns.get('lat', dest_lat)), float(ns.get('lon', dest_lon)))
                    )
            
            geo_data = geocoder.get_route_geometry(stops_data)
            outbound_geometry = geo_data['geometry'] if geo_data else None
            outbound_dist = geo_data['distance'] if geo_data else int(sum(seg_distances_m))
            
            leg_distances_m = geo_data.get('leg_distances') if geo_data else None
            leg_durations_s = geo_data.get('leg_durations') if geo_data else None
            
            total_load = sum([s.get('count', 0) for s in pickup_stops])
            
            if pickup_stops:
                total_haversine_m = sum(seg_distances_m) or 1
                total_drive_min = (geo_data['duration'] / 60) if geo_data and geo_data.get('duration') else None
                cumulative_minutes = start_hour * 60 + start_min
                
                for i, stop in enumerate(pickup_stops):
                    stop['departure_time'] = format_time_from_minutes(cumulative_minutes)

                    if leg_distances_m and i < len(leg_distances_m):
                        seg_dist_m = leg_distances_m[i]
                        seg_drive_min = (leg_durations_s[i] / 60) if (leg_durations_s and i < len(leg_durations_s)) else (seg_dist_m / 1000 / AVERAGE_SPEED_KMH) * 60
                    else:
                        seg_dist_m = seg_distances_m[i]
                        if total_drive_min:
                            seg_drive_min = total_drive_min * (seg_dist_m / total_haversine_m)
                        else:
                            seg_drive_min = (seg_dist_m / 1000 / AVERAGE_SPEED_KMH) * 60

                    stop['dist_to_next_km'] = round(seg_dist_m / 1000, 2)
                    stop['time_to_next_min'] = round(seg_drive_min)
                    cumulative_minutes += STOP_DWELL_TIME_MIN + seg_drive_min

                # Destination arrival time
                for stop in stops_data:
                    if stop['type'] == 'destination':
                        stop['arrival_time'] = format_time_from_minutes(cumulative_minutes)
                        
            formatted_routes.append({
                'vehicle_id': current_vehicle_id,
                'total_load': total_load,
                'outbound': {
                    'stops': stops_data,
                    'geometry': outbound_geometry,
                    'distance': outbound_dist
                }
            })
            
        # POST-PROCESSING: Synchronize pickup times for schools split across buses
        school_times = {}
        for route_idx, route in enumerate(formatted_routes):
            for stop_idx, stop in enumerate(route['outbound']['stops']):
                if stop['type'] == 'pickup':
                    original_name = stop.get('original_name', stop.get('name'))
                    if original_name not in school_times:
                        school_times[original_name] = []
                    if 'departure_time' in stop:
                        minutes = parse_time_to_minutes(stop['departure_time'])
                        school_times[original_name].append({
                            'route_idx': route_idx, 'stop_idx': stop_idx, 'minutes': minutes
                        })

        for school_name, times in school_times.items():
            if len(times) > 1:
                latest_minutes = max(t['minutes'] for t in times)
                latest_time_str = format_time_from_minutes(latest_minutes)
                for t in times:
                    stop = formatted_routes[t['route_idx']]['outbound']['stops'][t['stop_idx']]
                    stop['departure_time'] = latest_time_str
                    stop['synchronized'] = True

        time_mode = data.get('time_mode', 'arrival')
        arrival_times_minutes = []
        for route in formatted_routes:
            for stop in route['outbound']['stops']:
                if stop['type'] == 'destination' and 'arrival_time' in stop:
                    minutes = parse_time_to_minutes(stop['arrival_time'])
                    arrival_times_minutes.append(minutes)

        if arrival_times_minutes:
            earliest_arrival = min(arrival_times_minutes)
            latest_arrival = max(arrival_times_minutes)
            current_spread = latest_arrival - earliest_arrival
            if time_mode == 'arrival':
                target_time_str = data.get('start_time', '08:00')
                try:
                    th, tm = map(int, target_time_str.split(':'))
                    target_arrival_minutes = th * 60 + tm
                except:
                    target_arrival_minutes = 8 * 60
                
                for route in formatted_routes:
                    stops = route['outbound']['stops']
                    dest_stop = None
                    for stop in stops:
                        if stop['type'] == 'destination': 
                            dest_stop = stop
                            break
                    if dest_stop and 'arrival_time' in dest_stop:
                        current_arrival = parse_time_to_minutes(dest_stop['arrival_time'])
                        delay_minutes = target_arrival_minutes - current_arrival
                        for stop in stops:
                            if stop['type'] == 'pickup' and 'departure_time' in stop:
                                old_minutes = parse_time_to_minutes(stop['departure_time'])
                                stop['departure_time'] = format_time_from_minutes(old_minutes + delay_minutes)
                            elif stop['type'] == 'destination' and 'arrival_time' in stop:
                                old_minutes = parse_time_to_minutes(stop['arrival_time'])
                                stop['arrival_time'] = format_time_from_minutes(old_minutes + delay_minutes)

                final_arrival_times = []
                for route in formatted_routes:
                    for stop in route['outbound']['stops']:
                        if stop['type'] == 'destination' and 'arrival_time' in stop:
                            final_arrival_times.append(parse_time_to_minutes(stop['arrival_time']))
                final_earliest = min(final_arrival_times) if final_arrival_times else 0
                final_latest = max(final_arrival_times) if final_arrival_times else 0
                final_spread = final_latest - final_earliest
            else:
                final_earliest = earliest_arrival
                final_latest = latest_arrival
                final_spread = current_spread
            
            arrival_window = {
                'earliest': format_time_from_minutes(final_earliest),
                'latest': format_time_from_minutes(final_latest),
                'spread_minutes': final_spread
            }
        else:
            arrival_window = None

        fine_manifestazione = data.get('fine_manifestazione', '').strip()
        calculate_return = data.get('calculate_return', True)
        if calculate_return and fine_manifestazione:
            calculate_return_times_for_routes(formatted_routes, fine_manifestazione)

        total_outbound = sum([r['outbound']['distance'] for r in formatted_routes])
        overlaps = find_bus_overlaps(formatted_routes, min_overlap_meters=30)
        total_passengers = sum([r['total_load'] for r in formatted_routes])

        return jsonify({
            'routes': formatted_routes,
            'overlaps': overlaps,
            'stats': {
                'total_buses': len([r for r in formatted_routes if r['outbound']['stops']]),
                'total_passengers': total_passengers,
                'outbound_distance': total_outbound,
                'total_distance': total_outbound,
                'arrival_window': arrival_window,
                'fine_manifestazione': fine_manifestazione if (calculate_return and fine_manifestazione) else None,
            }
        }), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/config')
def get_config():
    return jsonify({
        'firebase': {
            'apiKey':            os.environ.get('FIREBASE_API_KEY', ''),
            'authDomain':        os.environ.get('FIREBASE_AUTH_DOMAIN', ''),
            'projectId':         os.environ.get('FIREBASE_PROJECT_ID', ''),
            'storageBucket':     os.environ.get('FIREBASE_STORAGE_BUCKET', ''),
            'messagingSenderId': os.environ.get('FIREBASE_MESSAGING_SENDER_ID', ''),
            'appId':             os.environ.get('FIREBASE_APP_ID', ''),
        },
        # reCAPTCHA Enterprise site key for Firebase App Check; empty = App Check off
        'appCheckSiteKey': os.environ.get('FIREBASE_APPCHECK_SITE_KEY', ''),
    })


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve(path):
    if path != "" and os.path.exists(app.static_folder + '/' + path):
        return send_from_directory(app.static_folder, path)
    else:
        return send_from_directory(app.static_folder, 'index.html')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(debug=True, host='0.0.0.0', port=port)
