
import time
import requests

NOMINATIM_BASE = 'https://nominatim.openstreetmap.org'
OSRM_BASE = 'http://router.project-osrm.org'
FALLBACK_COORDS = (46.0697, 11.1211)  # Trento center
_USER_AGENT = 'BusPlan/1.0 (bus route optimizer for Trentino schools)'


class GeocodingService:

    def get_coordinates(self, address):
        """Geocodes address using Nominatim (OSM). Returns (lat, lon)."""
        try:
            time.sleep(1)  # Nominatim rate limit: 1 req/s
            resp = requests.get(
                f'{NOMINATIM_BASE}/search',
                params={
                    'q': address,
                    'format': 'json',
                    'countrycodes': 'it',
                    'limit': 1,
                    'viewbox': '10.4,45.6,12.2,46.95',
                    'bounded': 0,
                },
                headers={'User-Agent': _USER_AGENT},
                timeout=6,
            )
            if resp.status_code == 200:
                data = resp.json()
                if data:
                    return float(data[0]['lat']), float(data[0]['lon'])
        except Exception as e:
            print(f"Nominatim geocoding error for '{address}': {e}")
        print(f"Warning: Address '{address}' not found. Using Trento fallback.")
        return FALLBACK_COORDS

    def get_distance_matrix(self, locations):
        """Returns distance matrix (meters) using OSRM Table API. Falls back to Euclidean."""
        if not locations:
            return []
        try:
            coords = ';'.join(f"{lon},{lat}" for lat, lon in locations)
            resp = requests.get(
                f'{OSRM_BASE}/table/v1/driving/{coords}',
                params={'annotations': 'distance'},
                timeout=15,
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get('code') == 'Ok':
                    matrix = data['distances']
                    n = len(locations)
                    for i in range(n):
                        for j in range(n):
                            if matrix[i][j] is None:
                                lat1, lon1 = locations[i]
                                lat2, lon2 = locations[j]
                                matrix[i][j] = int(((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2) ** 0.5 * 111000)
                            else:
                                matrix[i][j] = int(matrix[i][j])
                    return matrix
        except Exception as e:
            print(f"OSRM distance matrix error: {e}")
        return self._euclidean_matrix(locations)

    def get_time_matrix(self, locations):
        """Returns travel time matrix (seconds) using OSRM Table API. Falls back to Euclidean."""
        if not locations:
            return []
        try:
            coords = ';'.join(f"{lon},{lat}" for lat, lon in locations)
            resp = requests.get(
                f'{OSRM_BASE}/table/v1/driving/{coords}',
                params={'annotations': 'duration'},
                timeout=15,
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get('code') == 'Ok':
                    matrix = data['durations']
                    n = len(locations)
                    for i in range(n):
                        for j in range(n):
                            if matrix[i][j] is None:
                                lat1, lon1 = locations[i]
                                lat2, lon2 = locations[j]
                                dist_m = ((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2) ** 0.5 * 111000
                                matrix[i][j] = int(dist_m / (30 / 3.6))
                            else:
                                matrix[i][j] = int(matrix[i][j])
                    return matrix
        except Exception as e:
            print(f"OSRM time matrix error: {e}")
        return self._euclidean_time_matrix(locations)

    def get_route_geometry(self, stops):
        """Get real route geometry using OSRM Route API.
        Returns: { 'geometry': GeoJSON LineString, 'distance': meters, 'duration': seconds,
                   'leg_distances': [...], 'leg_durations': [...] }
        """
        if not stops or len(stops) < 2:
            return None
        try:
            coords = ';'.join(f"{s['lon']},{s['lat']}" for s in stops)
            resp = requests.get(
                f'{OSRM_BASE}/route/v1/driving/{coords}',
                params={'overview': 'full', 'geometries': 'geojson', 'steps': 'false'},
                timeout=15,
            )
            if resp.status_code == 200:
                data = resp.json()
                routes = data.get('routes', [])
                if routes:
                    route = routes[0]
                    legs = route['legs']
                    return {
                        'geometry': route['geometry'],
                        'distance': route['distance'],
                        'duration': route['duration'],
                        'leg_distances': [leg['distance'] for leg in legs],
                        'leg_durations': [leg['duration'] for leg in legs],
                    }
        except Exception as e:
            print(f"OSRM routing error: {e}")
        return None

    def haversine_distance(self, lat1, lon1, lat2, lon2):
        """Great-circle distance between two points (meters)."""
        from math import radians, cos, sin, asin, sqrt
        R = 6371000
        lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
        return R * 2 * asin(sqrt(a))

    def _euclidean_matrix(self, locations):
        n = len(locations)
        matrix = [[0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                lat1, lon1 = locations[i]
                lat2, lon2 = locations[j]
                matrix[i][j] = int(((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2) ** 0.5 * 111000)
        return matrix

    def _euclidean_time_matrix(self, locations):
        """Fallback time matrix using Euclidean distance / 30 km/h (seconds)."""
        n = len(locations)
        matrix = [[0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                lat1, lon1 = locations[i]
                lat2, lon2 = locations[j]
                dist_m = ((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2) ** 0.5 * 111000
                matrix[i][j] = int(dist_m / (30 / 3.6))
        return matrix
