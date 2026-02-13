
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import pandas as pd
import os
import uuid
import copy
from data_loader import DataLoader
from geocoder import GeocodingService
from optimizer import VRPSolver

# Setup static folder to point to frontend/dist
app = Flask(__name__, static_folder='frontend/dist', static_url_path='')
CORS(app)

tasks = {}

import random

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

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
    Attempts to geocode the address using multiple cleaning heuristics.
    Returns (lat, lon) and a boolean indicating if it was successful (True) or fallback (False).
    """
    # Determine Context
    city_context = default_city
    
    # 1. Try to extract city from School Name
    extracted_city = extract_city_context(school_name)
    if extracted_city:
        city_context = extracted_city
    
    # 2. Try to extract city from Address itself (last part usually)
    # If address contains "Rovereto", use it.
    extracted_from_addr = extract_city_context(address)
    if extracted_from_addr:
        city_context = extracted_from_addr

    # 1. Try Original
    queries = [address]
    
    # 2. Clean parentheses, hyphens, and common noise words
    # "Balbido 1 - 38071 Bleggio (Note)" -> "Balbido 1, 38071 Bleggio"
    cleaned = re.sub(r'\(.*?\)', '', address) # Remove (...)
    cleaned = cleaned.replace(' - ', ', ')
    # Remove "fermata bus", "presso", "scuola", etc. case insensitive
    cleaned = re.sub(r'(?i)\b(fermata bus|fermata|presso|scuola|elementare|media|superiore|istituto)\b', '', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    cleaned = cleaned.strip(', ') # Remove leading/trailing commas
    
    if cleaned and cleaned != address:
        queries.append(cleaned)
        
    # 2b. Try to just use the first part before a comma if it looks like a street
    # "Viale Trento, bivio Brione" -> "Viale Trento"
    if ',' in cleaned:
        first_part = cleaned.split(',')[0].strip()
        if first_part and first_part != cleaned:
             queries.append(first_part)
        
    # 3. Extract Street Address (heuristic for Italian addresses)
    # "Scuola Elem. Zivignago Via Spiazzi, 2" -> "Via Spiazzi, 2"
    match = re.search(r'(Via|Viale|Piazza|Corso|Largo|Vicolo|Strada|Frazione|Località)\s+.*', cleaned, re.IGNORECASE)
    if match:
        street_only = match.group(0)
        if street_only != cleaned:
            queries.append(street_only)

    for q in queries:
        full_query = f"{q}, {city_context}"
        # If the query already contains the city context, don't double add (simple check)
        if city_context.lower() in q.lower():
            full_query = q
            
        lat, lon = geocoder.get_coordinates(full_query)
        
        # Check if we got a real result (not the fallback)
        # Note: We rely on checking exact float equality with the fallback definition. 
        # Ideally geocoder should return None, but we work with what we have.
        if abs(lat - FALLBACK_COORDS[0]) > 0.0001 or abs(lon - FALLBACK_COORDS[1]) > 0.0001:
            return lat, lon, True
            
    return FALLBACK_COORDS[0], FALLBACK_COORDS[1], False

def process_file_task(task_id, filepath):
    """
    Background task to process the uploaded Excel file.
    Updates the tasks global dict with progress.
    """
    try:
        tasks[task_id] = {'status': 'processing', 'progress': 0, 'message': 'Inizializzazione...'}
        
        # 1. Load Data
        time.sleep(0.5) # UX Delay
        tasks[task_id].update({'progress': 10, 'message': 'Lettura file Excel...'})
        
        schools = DataLoader.load_data(filepath)
        total_schools = len(schools)
        
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
                print(f"Failed to geocode: {raw_address} - Using Fallback")
            
            # Deterministic Spiral Jitter for Overlapping Coordinates
            coord_key = (round(lat, 6), round(lon, 6))
            
            # Count how many times we've seen this exact coordinate
            count = used_coordinates.get(coord_key, 0)
            
            if count > 0:
                # Apply Spiral Jitter
                # angle = count * (Golden Angle ~ 2.4 radians)
                # radius = base_step * sqrt(count)
                import math
                angle = count * 2.4
                radius = 0.0003 * math.sqrt(count) # ~30-40 meters radius expansion
                
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
            'result': processed_schools
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
        thread = threading.Thread(target=process_file_task, args=(task_id, filepath))
        thread.daemon = True
        thread.start()
        
        return jsonify({'task_id': task_id, 'message': 'Elaborazione iniziata'}), 202

@app.route('/api/status/<task_id>', methods=['GET'])
def get_task_status(task_id):
    task = tasks.get(task_id)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    return jsonify(task)

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
                # First stop departs at start_time
                cumulative_minutes = start_hour * 60 + start_min
                
                for i, stop in enumerate(pickup_stops):
                    stop['departure_time'] = format_time_from_minutes(cumulative_minutes)
                    
                    # Calculate travel time to next stop (or destination)
                    if i < len(pickup_stops) - 1:
                        next_stop = pickup_stops[i + 1]
                    else:
                        # Last pickup -> destination
                        next_stop = {'lat': dest_lat, 'lon': dest_lon}
                    
                    dist_km = geocoder.haversine_distance(stop['lat'], stop['lon'], next_stop['lat'], next_stop['lon']) / 1000
                    travel_time_min = (dist_km / AVERAGE_SPEED_KMH) * 60
                    cumulative_minutes += STOP_DWELL_TIME_MIN + travel_time_min  # Dwell + travel
                
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

        # POST-PROCESSING: Synchronize arrival times (max 10 minute spread)
        # Collect all arrival times
        MAX_ARRIVAL_SPREAD_MINUTES = 10
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
            
            # Target arrival: all buses should arrive at the latest time (within 10 min window)
            # This means earlier buses need to delay their departure
            
            # --- NEW: Time Mode Logic ---
            time_mode = data.get('time_mode', 'departure') # 'departure' or 'arrival'
            target_arrival_minutes = None
            
            if time_mode == 'arrival':
                # User specified ARRIVAL time.
                # We want ALL buses to arrive at this time (or slightly before, but ideally AT this time for JIT)
                # Parse target time
                target_time_str = data.get('start_time', '08:00')
                try:
                    th, tm = map(int, target_time_str.split(':'))
                    target_arrival_minutes = th * 60 + tm
                except:
                    target_arrival_minutes = 8 * 60 # Default 08:00
                
                # In Arrival Mode, we force the target to be the user's time
                target_arrival = target_arrival_minutes
            elif current_spread > MAX_ARRIVAL_SPREAD_MINUTES:
                # Make all buses arrive at the latest_arrival time
                target_arrival = latest_arrival
            else:
                # Already within bounds, just track the window
                target_arrival = latest_arrival
            
            # Recalculate departure times to synchronize arrivals
            for route in formatted_routes:
                stops = route['outbound']['stops']
                dest_stop = None
                for stop in stops:
                    if stop['type'] == 'destination':
                        dest_stop = stop
                        break
                
                if dest_stop and 'arrival_time' in dest_stop:
                    current_arrival = parse_time_to_minutes(dest_stop['arrival_time'])
                    
                    if time_mode == 'arrival':
                         # Shift essential: Target - Current
                         # If Current is 08:15 and Target is 08:00 -> Delay is -15 (Shift backwards)
                         # If Current is 07:45 and Target is 08:00 -> Delay is +15 (Shift forwards)
                         delay_minutes = target_arrival - current_arrival
                    else:
                        # Departure mode: only shift forward (delay)
                        delay_minutes = target_arrival - current_arrival
                        if delay_minutes < 0: delay_minutes = 0 # Should not happen if target is max
                    
                    if delay_minutes != 0:
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
            
            # Recalculate spread after synchronization
            final_arrival_times = []
            for route in formatted_routes:
                for stop in route['outbound']['stops']:
                    if stop['type'] == 'destination' and 'arrival_time' in stop:
                        minutes = parse_time_to_minutes(stop['arrival_time'])
                        final_arrival_times.append(minutes)
            
            final_earliest = min(final_arrival_times) if final_arrival_times else 0
            final_latest = max(final_arrival_times) if final_arrival_times else 0
            final_spread = final_latest - final_earliest
            
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
