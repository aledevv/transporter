
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import pandas as pd
import os
import uuid
import copy
from data_loader import DataLoader
from geocoder import GeocodingService
from optimizer import VRPSolver
from address_corrector import AddressCorrector

address_corrector = AddressCorrector()

# Setup static folder to point to frontend/dist
app = Flask(__name__, static_folder='frontend/dist', static_url_path='')
CORS(app)

tasks = {}

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

def process_file_task(task_id, filepath, original_filename):
    """
    Background task to process the uploaded Excel file.
    Updates the tasks global dict with progress.
    """
    try:
        tasks[task_id] = {'status': 'processing', 'progress': 0, 'message': 'Inizializzazione...'}

        # 1. Load Data
        time.sleep(0.5) # UX Delay
        tasks[task_id].update({'progress': 5, 'message': 'Lettura file Excel...'})

        original_schools = DataLoader.load_data(filepath)
        total_schools = len(original_schools)

        # 2. Address correction via LLM
        base, ext = os.path.splitext(original_filename)
        corrected_filename = f"{base}_corretto{ext}"
        corrected_path = os.path.join(UPLOAD_FOLDER, corrected_filename)

        tasks[task_id].update({'progress': 10, 'message': 'Correzione indirizzi con AI...'})
        schools, correction_status = address_corrector.correct_addresses(original_schools, filepath, corrected_path)

        # Build a human-readable log of what changed
        original_map = {s['id']: s for s in original_schools}
        address_corrections = [
            {
                'name': s['name'],
                'original': original_map[s['id']]['address'],
                'corrected': s['address'],
            }
            for s in schools
            if s['address'] != original_map[s['id']]['address']
        ]

        tasks[task_id].update({'progress': 20, 'message': f'Trovate {total_schools} scuole. Inizio geocoding...'})
        
        # 2. Geocoding with progress tracking
        processed_schools = []
        used_coordinates = {} # Track used coordinates for jittering: {(lat, lon): count}
        
        for i, school in enumerate(schools):
            # Calculate progress from 20% to 90%
            current_progress = 20 + int((i / total_schools) * 70)
            tasks[task_id].update({
                'progress': current_progress, 
                'message': f'Geocoding {i+1}/{total_schools}: {school["name"]}'
            })
            
            raw_address = school['address']
            lat, lon, success = smart_geocode(raw_address, school_name=school['name'])

            if not success:
                print(f"Failed to geocode: {raw_address} - Marking as unresolved")
                school['lat'] = None
                school['lon'] = None
                school['geocoding_failed'] = True
            else:
                # Deterministic Spiral Jitter for Overlapping Coordinates
                coord_key = (round(lat, 6), round(lon, 6))
                count = used_coordinates.get(coord_key, 0)
                if count > 0:
                    import math
                    angle = count * 2.4
                    radius = 0.0003 * math.sqrt(count)
                    lat += radius * math.sin(angle)
                    lon += radius * math.cos(angle)
                used_coordinates[coord_key] = count + 1
                school['lat'] = lat
                school['lon'] = lon

            processed_schools.append(school)
            
        tasks[task_id].update({'progress': 95, 'message': 'Finalizzazione dati...'})
        
        # Cleanup
        if os.path.exists(filepath):
            os.remove(filepath)
            
        tasks[task_id] = {
            'status': 'completed',
            'progress': 100,
            'message': 'Completato!',
            'result': processed_schools,
            'corrected_file': corrected_filename if address_corrections else None,
            'address_corrections': address_corrections,  # [] if nothing changed or LLM disabled
            'correction_status': correction_status,
        }
        
    except Exception as e:
        tasks[task_id] = {
            'status': 'error', 
            'progress': 0, 
            'message': f'Errore: {str(e)}'
        }
        if os.path.exists(filepath):
            os.remove(filepath)

@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'Nessun file inviato'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Nessun file selezionato'}), 400
    
    if file:
        filename = str(uuid.uuid4()) + "_" + file.filename
        filepath = os.path.join(UPLOAD_FOLDER, filename)
        file.save(filepath)
        
        # Create Task ID
        task_id = str(uuid.uuid4())
        
        # Start background thread
        thread = threading.Thread(target=process_file_task, args=(task_id, filepath, file.filename))
        thread.daemon = True
        thread.start()
        
        return jsonify({'task_id': task_id, 'message': 'Elaborazione iniziata'}), 202

@app.route('/api/status/<task_id>', methods=['GET'])
def get_task_status(task_id):
    task = tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    return jsonify(task)

@app.route('/api/geocode', methods=['POST'])
def geocode_single():
    """Geocode a single address. Used by the frontend address correction UI."""
    data = request.json or {}
    address = data.get('address', '').strip()
    if not address:
        return jsonify({'error': 'address required'}), 400
    lat, lon, success = smart_geocode(address)
    return jsonify({'lat': lat, 'lon': lon, 'success': success})

@app.route('/api/optimize', methods=['POST'])
def optimize():
    data = request.json
    schools = data.get('schools', [])
    destination_address = data.get('destination', '')
    bus_capacity = int(data.get('capacity', 50))
    max_buses = data.get('max_buses', None) 
    
    dest_lat_param = data.get('dest_lat')
    dest_lon_param = data.get('dest_lon')
    strategy = data.get('strategy', 'distance') # 'distance' or 'vehicles'
    
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
            
        # 2. Distance Matrix (Real OSRM)
        # We process N real nodes. The matrix needs to be (N+1)x(N+1)
        real_node_count = len(all_nodes) - 1
        locations = [(n['lat'], n['lon']) for n in all_nodes[:real_node_count]]
        real_matrix = geocoder.get_distance_matrix(locations)
        
        # Extend matrix for Dummy Node
        # Rows: Real nodes -> Real nodes (Keep)
        # Row: Dummy -> Real nodes (0 distance)
        # Col: Real nodes -> Dummy (Infinity? Or 0? Usually maximize to prevent using as shortcut, but it's start node so it only has outgoing)
        
        full_matrix = []
        for row in real_matrix:
            # Add distance TO dummy (End -> Dummy). We don't want to go TO dummy.
            # Make it 0 or huge? If we use different start/end, we won't go back to start.
            row.append(0) 
            full_matrix.append(row)
            
        # Add Dummy Row (Dummy -> Others)
        # We want Dummy -> First School = 0 cost
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

        # Determine Fixed Cost & Strategy based on User Input
        fixed_cost = 0
        search_strategy = 'PATH_CHEAPEST_ARC'
        
        if strategy == 'vehicles':
            # "Minimize Buses"
            # High cost to penalize using a vehicle + SAVINGS heuristic
            fixed_cost = 1000000 
            search_strategy = 'SAVINGS'
            
            # If user didn't force a bus count, let's try to squeeze more
            # by not inflating the calculated_vehicles too much, but solver will decide usage.
            
        elif strategy == 'balanced':
            # "Balanced"
            # Medium cost (e.g., 20km) to discourage empty buses but not at all costs
            fixed_cost = 20000 # 20km equivalent
            search_strategy = 'PATH_CHEAPEST_ARC' 
            
        else: # 'distance' or default
            # "Shortest Path"
            # Low cost to just avoid completely empty buses if possible, but prioritization is distance
            fixed_cost = 1000 # 1km equivalent
            search_strategy = 'PATH_CHEAPEST_ARC'

        solver = VRPSolver(
            distance_matrix=distance_matrix,
            demands=demands,
            vehicle_capacity=bus_capacity,
            num_vehicles=calculated_vehicles,
            depot_index=0,
            fixed_vehicle_cost=fixed_cost,
            search_strategy=search_strategy,
            starts=[dummy_node_index] * calculated_vehicles,
            ends=[0] * calculated_vehicles, # 0 is Destination
            institutes=[n.get('institute') for n in all_nodes] + ['UNIVERSAL'] # +1 for Dummy Node
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
            
            # Fetch geometry for Outbound
            geo_data = geocoder.get_route_geometry(stops_data)
            outbound_geometry = geo_data['geometry'] if geo_data else None
            outbound_dist = geo_data['distance'] if geo_data else route['distance']
            
            # Calculate times FORWARD from first school departure
            # start_time = when bus departs from FIRST school
            pickup_stops = [s for s in stops_data if s['type'] == 'pickup']

            if pickup_stops:
                # Pre-compute haversine distance for each segment
                seg_distances_m = []
                for i, stop in enumerate(pickup_stops):
                    ns = pickup_stops[i + 1] if i < len(pickup_stops) - 1 else {'lat': dest_lat, 'lon': dest_lon}
                    seg_distances_m.append(
                        geocoder.haversine_distance(stop['lat'], stop['lon'], ns['lat'], ns['lon'])
                    )
                total_haversine_m = sum(seg_distances_m) or 1

                # Use Google Directions total duration if available, else fall back to speed estimate
                total_drive_min = (geo_data['duration'] / 60) if geo_data and geo_data.get('duration') else None

                cumulative_minutes = start_hour * 60 + start_min

                for i, stop in enumerate(pickup_stops):
                    stop['departure_time'] = format_time_from_minutes(cumulative_minutes)
                    stop['dist_to_next_km'] = round(seg_distances_m[i] / 1000, 2)

                    if total_drive_min:
                        seg_drive_min = total_drive_min * (seg_distances_m[i] / total_haversine_m)
                    else:
                        seg_drive_min = (seg_distances_m[i] / 1000 / AVERAGE_SPEED_KMH) * 60

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

        # Calculate Totals
        total_outbound = sum([r['outbound']['distance'] for r in formatted_routes])

        return jsonify({
            'routes': formatted_routes,
            'stats': {
                'total_buses': solution['used_vehicles'],
                'total_passengers': solution['total_load'],
                'outbound_distance': total_outbound,
                'total_distance': total_outbound,
                'arrival_window': arrival_window
            }
        }), 200
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/places/autocomplete', methods=['GET'])
def places_autocomplete():
    """Proxy to Google Places API autocomplete. Keeps the key server-side."""
    query = request.args.get('q', '').strip()
    if len(query) < 2:
        return jsonify({'predictions': [], 'status': 'OK'})

    api_key = os.environ.get('GOOGLE_MAPS_API_KEY')
    if not api_key:
        return jsonify({'error': 'GOOGLE_MAPS_API_KEY not configured'}), 500

    import requests as req
    resp = req.get(
        'https://maps.googleapis.com/maps/api/place/autocomplete/json',
        params={
            'input': query,
            'key': api_key,
            'language': 'it',
            'components': 'country:it',
            'location': '46.0697,11.1211',
            'radius': 80000,
        },
        timeout=5
    )
    data = resp.json()
    if data.get('status') not in ('OK', 'ZERO_RESULTS'):
        print(f"[Places Autocomplete] Google error: {data.get('status')} — {data.get('error_message', '')}")
    return jsonify(data), 200


@app.route('/api/places/details', methods=['GET'])
def places_details():
    """Proxy to Google Places API — fetch lat/lon for a place_id."""
    place_id = request.args.get('place_id', '').strip()
    if not place_id:
        return jsonify({'error': 'place_id required'}), 400

    api_key = os.environ.get('GOOGLE_MAPS_API_KEY')
    if not api_key:
        return jsonify({'error': 'GOOGLE_MAPS_API_KEY not configured'}), 500

    import requests as req
    resp = req.get(
        'https://maps.googleapis.com/maps/api/place/details/json',
        params={
            'place_id': place_id,
            'key': api_key,
            'fields': 'geometry,formatted_address,name',
            'language': 'it',
        },
        timeout=5
    )
    return jsonify(resp.json()), 200


@app.route('/api/download/<path:filename>', methods=['GET'])
def download_corrected_file(filename):
    """Serves a corrected Excel file from the uploads folder, then deletes it."""
    safe_path = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.exists(safe_path):
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


@app.route('/api/config')
def get_config():
    return jsonify({
        'maps_key': os.environ.get('GOOGLE_MAPS_API_KEY', ''),
        'firebase': {
            'apiKey':            os.environ.get('FIREBASE_API_KEY', ''),
            'authDomain':        os.environ.get('FIREBASE_AUTH_DOMAIN', ''),
            'projectId':         os.environ.get('FIREBASE_PROJECT_ID', ''),
            'storageBucket':     os.environ.get('FIREBASE_STORAGE_BUCKET', ''),
            'messagingSenderId': os.environ.get('FIREBASE_MESSAGING_SENDER_ID', ''),
            'appId':             os.environ.get('FIREBASE_APP_ID', ''),
        }
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
