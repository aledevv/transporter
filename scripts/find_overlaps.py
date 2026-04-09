import math
from difflib import SequenceMatcher

def calculate_distance(coord1, coord2):
    """Calcola la distanza in metri (Haversine) tra due coordinate (lon, lat)"""
    R = 6371000  # Raggio della Terra in metri
    lon1, lat1 = coord1
    lon2, lat2 = coord2
    
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    
    a = math.sin(delta_phi/2.0)**2 + \
        math.cos(phi1) * math.cos(phi2) * \
        math.sin(delta_lambda/2.0)**2
    
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def sequence_distance(coords):
    """Calcola la distanza totale di una sequenza di coordinate in metri"""
    if not coords or len(coords) < 2:
        return 0.0
    return sum(calculate_distance(coords[i], coords[i+1]) for i in range(len(coords)-1))

def round_coords(coords, decimals=5):
    """Arrotonda la precisione per facilitare i match esatti (5 decimali ~1.1 metri)"""
    return [(round(lon, decimals), round(lat, decimals)) for lon, lat in coords]

def find_bus_overlaps(routes, min_overlap_meters=50):
    """
    Analizza una lista di percorsi dei bus e trova le strade condivise.
    
    :param routes: lista di dizionari con formato [{'vehicle_id': ID, 'geometry': {'coordinates': [[lon, lat], ...]}}]
                   (Questo corrisponde alla parte 'outbound' generata dal backend BusPlan)
    :param min_overlap_meters: i segmenti sovrapposti più corti di questo valore verranno ignorati
    :return: lista di sovrapposizioni trovate con dettagli su chi condivide cosa e dove.
    """
    overlaps = []
    
    # Prepariamo i dati: ci serve solo la traccia GPS e un ID leggibile
    tracks = {}
    for route in routes:
        vid = route.get('vehicle_id')
        geometry = route.get('geometry')
        if geometry and 'coordinates' in geometry:
            tracks[vid] = {
                'forward': round_coords(geometry['coordinates']),
                # Creiamo anche la traccia invertita nel caso percorrano la stessa strada in direzioni opposte
                'backward': round_coords(list(reversed(geometry['coordinates'])))
            }
        elif 'outbound' in route and route['outbound'].get('geometry'):
            # Formato annidato se viene passato l'intero trip object
            tracks[vid] = {
                'forward': round_coords(route['outbound']['geometry']['coordinates']),
                'backward': round_coords(list(reversed(route['outbound']['geometry']['coordinates'])))
            }
            
    vehicle_ids = list(tracks.keys())
    
    # Confrontiamo ogni coppia di bus una sola volta
    for i in range(len(vehicle_ids)):
        for j in range(i + 1, len(vehicle_ids)):
            v1, v2 = vehicle_ids[i], vehicle_ids[j]
            t1 = tracks[v1]['forward']
            
            # Controlliamo la stessa direzione
            t2_fwd = tracks[v2]['forward']
            matcher_fwd = SequenceMatcher(None, t1, t2_fwd)
            for block in matcher_fwd.get_matching_blocks():
                match_coords = t1[block.a : block.a + block.size]
                dist = sequence_distance(match_coords)
                
                if dist >= min_overlap_meters:
                    overlaps.append({
                        'bus_1': v1,
                        'bus_2': v2,
                        'direction': 'same',
                        'distance_meters': round(dist, 2),
                        'start_point': match_coords[0],
                        'end_point': match_coords[-1],
                        'coordinates': match_coords  # L'intero segmento se serve disegnarlo sulla mappa
                    })
            
            # Controlliamo in direzione opposta
            t2_bwd = tracks[v2]['backward']
            matcher_bwd = SequenceMatcher(None, t1, t2_bwd)
            for block in matcher_bwd.get_matching_blocks():
                match_coords = t1[block.a : block.a + block.size]
                dist = sequence_distance(match_coords)
                
                if dist >= min_overlap_meters:
                    overlaps.append({
                        'bus_1': v1,
                        'bus_2': v2,
                        'direction': 'opposite',
                        'distance_meters': round(dist, 2),
                        'start_point': match_coords[0],
                        'end_point': match_coords[-1],
                        'coordinates': match_coords
                    })
                    
    # Ordiniamo per distanza decrescente (i segmenti più lunghi in cima)
    return sorted(overlaps, key=lambda x: x['distance_meters'], reverse=True)


if __name__ == "__main__":
    # Esempio di utilizzo:
    # 1. Recupera o estrai i "routes" (percorsi) dal JSON della tua API.
    # 2. Chiama find_bus_overlaps(routes)
    
    dummy_routes = [
        {
            "vehicle_id": 1,
            "geometry": {
                "coordinates": [
                    [11.12345, 46.12345], [11.12350, 46.12350], [11.12360, 46.12360], [11.12400, 46.12400]
                ]
            }
        },
        {
            "vehicle_id": 2,
            "geometry": {
                "coordinates": [
                    [11.99999, 46.99999], [11.12350, 46.12350], [11.12360, 46.12360], [11.11111, 46.11111]
                ]
            }
        }
    ]
    
    # Modifichiamo min_overlap a 0 per questo piccolo test:
    risultati = find_bus_overlaps(dummy_routes, min_overlap_meters=0.1)
    
    print("--- Sovrapposizioni trovate ---")
    for r in risultati:
        print(f"Bus {r['bus_1']} e Bus {r['bus_2']} condividono un tratto di strada!")
        print(f"Direzione: {'Stessa' if r['direction'] == 'same' else 'Opposta'}")
        print(f"Distanza: {r['distance_meters']} metri")
        print(f"Da coordinata {r['start_point']} a {r['end_point']}\n")
