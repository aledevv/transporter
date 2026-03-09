
import requests
import json
import time

class GeocodingService:
    def __init__(self):
        self.osrm_base_url = "http://router.project-osrm.org"
        self.nominatim_base_url = "https://nominatim.openstreetmap.org/search"
        self.headers = {
            'User-Agent': 'TransporterApp/1.0 (edu-demo)'
        }

    # Trentino-Alto Adige bounding box for Nominatim viewbox bias.
    # Format: lon_min, lat_max, lon_max, lat_min  (Nominatim convention)
    # Not used with bounded=1 so destinations outside the region still resolve.
    _TRENTINO_VIEWBOX = "10.4,46.95,12.2,45.6"

    def get_coordinates(self, address):
        """
        Geocodes address using OpenStreetMap Nominatim API.
        Returns (lat, lon)
        """
        try:
            # Respect Nominatim usage policy (1 sec delay between requests)
            time.sleep(1)
            params = {
                'q': address,
                'format': 'json',
                'limit': 1,
                'countrycodes': 'it',          # Italy only — avoids false matches abroad
                'viewbox': self._TRENTINO_VIEWBOX,  # Bias results toward Trentino
                # bounded=0 (default): viewbox is a preference, not a hard constraint,
                # so destinations outside Trentino still resolve correctly.
            }
            response = requests.get(self.nominatim_base_url, params=params, headers=self.headers)
            if response.status_code == 200 and response.json():
                data = response.json()[0]
                return float(data['lat']), float(data['lon'])
            else:
                print(f"Warning: Address '{address}' not found. Using Trento fallback.")
                return 46.0697, 11.1211 # Fallback Trento
        except Exception as e:
            print(f"Geocoding error for '{address}': {e}")
            return 46.0697, 11.1211

    def get_distance_matrix(self, locations):
        """
        Returns distance matrix (meters) using OSRM Table API.
        locations: list of (lat, lon) tuples.
        """
        # OSRM format: lon,lat;lon,lat;...
        coords_str = ";".join([f"{lon},{lat}" for lat, lon in locations])
        url = f"{self.osrm_base_url}/table/v1/driving/{coords_str}"
        
        try:
            params = {'annotations': 'distance'}
            response = requests.get(url, params=params)
            
            if response.status_code == 200:
                data = response.json()
                if 'distances' in data:
                    # OSRM returns floats, cast to int
                    return [[int(d) for d in row] for row in data['distances']]
            
            print("OSRM Table failed, falling back to Euclidean.")
            return self._euclidean_matrix(locations)
            
        except Exception as e:
            print(f"OSRM Error: {e}")
            return self._euclidean_matrix(locations)

    def get_route_geometry(self, stops):
        """
        Get real route geometry visiting stops in order.
        Returns: { 'geometry': 'polyline_string', 'distance': meters, 'duration': seconds }
        """
        if not stops or len(stops) < 2:
            return None
            
        coords_str = ";".join([f"{stop['lon']},{stop['lat']}" for stop in stops])
        url = f"{self.osrm_base_url}/route/v1/driving/{coords_str}"
        
        try:
            params = {
                'overview': 'full',
                'geometries': 'geojson'
            }
            response = requests.get(url, params=params)
            if response.status_code == 200:
                routes = response.json().get('routes', [])
                if routes:
                    return routes[0] # Best route
            return None
        except Exception as e:
            print(f"Routing error: {e}")
            return None

    def haversine_distance(self, lat1, lon1, lat2, lon2):
        """
        Calculate the great circle distance between two points on earth (in meters).
        """
        from math import radians, cos, sin, asin, sqrt
        R = 6371000  # Earth radius in meters
        
        lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        
        a = sin(dlat/2)**2 + cos(lat1) * cos(lat2) * sin(dlon/2)**2
        c = 2 * asin(sqrt(a))
        
        return R * c

    def _euclidean_matrix(self, locations):
        n = len(locations)
        matrix = [[0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i == j: continue
                lat1, lon1 = locations[i]
                lat2, lon2 = locations[j]
                # Approx conversion
                dist = ((lat1 - lat2)**2 + (lon1 - lon2)**2)**0.5 * 111000
                matrix[i][j] = int(dist)
        return matrix
