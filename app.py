
from flask import Flask, request, jsonify
from flask_cors import CORS
import pandas as pd
import os
import uuid
import copy
from data_loader import DataLoader
from geocoder import GeocodingService
from optimizer import VRPSolver

app = Flask(__name__)
CORS(app)

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
        
        try:
            schools = DataLoader.load_data(filepath)
            # Add coordinates immediately (Nominatim)
            for school in schools:
                lat, lon = geocoder.get_coordinates(school['address'] + ", Trento") # Helper assumption for demo
                school['lat'] = lat
                school['lon'] = lon
                
            return jsonify({'message': 'File elaborato con successo', 'schools': schools}), 200
        except Exception as e:
            return jsonify({'error': str(e)}), 500

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
    
    # Split Delivery: Pre-split ALL schools into smaller chunks to allow
    # passengers from different schools to share a bus.
    SPLIT_CHUNK_SIZE = 15  # Max passengers per "node" for flexible assignment
    processed_schools = []
    for school in schools:
        demand = school['demand']
        if demand > SPLIT_CHUNK_SIZE:
            part_idx = 1
            while demand > 0:
                chunk = min(demand, SPLIT_CHUNK_SIZE)
                new_school = school.copy()
                new_school['demand'] = chunk
                new_school['name'] = f"{school['name']} (Gruppo {part_idx})"
                new_school['original_name'] = school['name']
                processed_schools.append(new_school)
                demand -= chunk
                part_idx += 1
        else:
            school['original_name'] = school['name']
            processed_schools.append(school)
    
    schools = processed_schools

    try:
        # 1. Prepare Nodes
        if dest_lat_param and dest_lon_param:
            dest_lat, dest_lon = float(dest_lat_param), float(dest_lon_param)
        else:
            dest_lat, dest_lon = geocoder.get_coordinates(destination_address)
        
        all_nodes = []
        all_nodes.append({
            'id': 'DEST',
            'name': 'Destination',
            'address': destination_address,
            'participants': 0,
            'lat': dest_lat,
            'lon': dest_lon
        })
        
        index_to_school = {} 
        for i, school in enumerate(schools):
            all_nodes.append({
                'id': school['id'],
                'name': school['name'],
                'address': school['address'],
                'participants': school['demand'],
                'lat': school.get('lat', 0),
                'lon': school.get('lon', 0)
            })
            index_to_school[i + 1] = school 
            
        # 2. Distance Matrix (Real OSRM)
        locations = [(n['lat'], n['lon']) for n in all_nodes]
        distance_matrix = geocoder.get_distance_matrix(locations)
        
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

        # Determine Fixed Cost based on Strategy
        fixed_cost = 0
        if strategy == 'vehicles':
            # High cost to penalize using a vehicle
            # Heuristic: Cost > max possible route distance ensures we prioritize saving a vehicle
            # Max possible dist approx: Total Distance. Let's say 1,000,000 (1000km)
            fixed_cost = 1000000 

        solver = VRPSolver(
            distance_matrix=distance_matrix,
            demands=demands,
            vehicle_capacity=bus_capacity,
            num_vehicles=calculated_vehicles,
            depot_index=0,
            fixed_vehicle_cost=fixed_cost
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
                        'lon': original_school['lon']
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
            if current_spread > MAX_ARRIVAL_SPREAD_MINUTES:
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
                    delay_minutes = target_arrival - current_arrival
                    
                    if delay_minutes > 0:
                        # Shift all times for this route forward
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

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5001)
