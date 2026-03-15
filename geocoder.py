
import requests
import os

class GeocodingService:
    def __init__(self):
        self.api_key = os.environ.get('GOOGLE_MAPS_API_KEY')

    def get_coordinates(self, address):
        """
        Geocodes address using Google Geocoding API.
        Returns (lat, lon)
        """
        if not self.api_key:
            print("Warning: GOOGLE_MAPS_API_KEY not set. Using Trento fallback.")
            return 46.0697, 11.1211

        try:
            params = {
                'address': address,
                'key': self.api_key,
                'language': 'it',
                'region': 'it',
                'bounds': '45.6,10.4|46.95,12.2',
            }
            response = requests.get(
                'https://maps.googleapis.com/maps/api/geocode/json',
                params=params,
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                status = data.get('status')
                if data.get('results'):
                    loc = data['results'][0]['geometry']['location']
                    return float(loc['lat']), float(loc['lng'])
                if status not in ('ZERO_RESULTS', 'OK'):
                    print(f"Geocoding API error for '{address}': status={status}, msg={data.get('error_message', '')}")

            print(f"Warning: Address '{address}' not found. Using Trento fallback.")
            return 46.0697, 11.1211
        except Exception as e:
            print(f"Geocoding error for '{address}': {e}")
            return 46.0697, 11.1211

    def get_distance_matrix(self, locations):
        """
        Returns distance matrix (meters) using Google Distance Matrix API.
        locations: list of (lat, lon) tuples.
        Batches requests in chunks of 25 (Google limit: 25x25 per request).
        """
        if not self.api_key:
            return self._euclidean_matrix(locations)

        n = len(locations)
        matrix = [[0] * n for _ in range(n)]
        chunk_size = 25

        try:
            for i_start in range(0, n, chunk_size):
                i_end = min(i_start + chunk_size, n)
                origins = '|'.join(f"{lat},{lon}" for lat, lon in locations[i_start:i_end])

                for j_start in range(0, n, chunk_size):
                    j_end = min(j_start + chunk_size, n)
                    destinations = '|'.join(f"{lat},{lon}" for lat, lon in locations[j_start:j_end])

                    params = {
                        'origins': origins,
                        'destinations': destinations,
                        'key': self.api_key,
                        'mode': 'driving',
                        'language': 'it',
                    }
                    response = requests.get(
                        'https://maps.googleapis.com/maps/api/distancematrix/json',
                        params=params,
                        timeout=15
                    )

                    if response.status_code == 200:
                        data = response.json()
                        rows = data.get('rows', [])
                        for ri, row in enumerate(rows):
                            for rj, element in enumerate(row.get('elements', [])):
                                if element.get('status') == 'OK':
                                    matrix[i_start + ri][j_start + rj] = element['distance']['value']
                                else:
                                    # Fallback for this element
                                    lat1, lon1 = locations[i_start + ri]
                                    lat2, lon2 = locations[j_start + rj]
                                    matrix[i_start + ri][j_start + rj] = int(
                                        ((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2) ** 0.5 * 111000
                                    )
                    else:
                        print(f"Google Distance Matrix HTTP error: {response.status_code}")
                        return self._euclidean_matrix(locations)

            return matrix

        except Exception as e:
            print(f"Google Distance Matrix error: {e}")
            return self._euclidean_matrix(locations)

    def get_time_matrix(self, locations):
        """
        Returns travel time matrix (seconds) using Google Distance Matrix API.
        Same structure as get_distance_matrix() but returns durations instead of distances.
        """
        if not self.api_key:
            return self._euclidean_time_matrix(locations)

        n = len(locations)
        matrix = [[0] * n for _ in range(n)]
        chunk_size = 10  # Max 10 origins x 10 dests = 100 elements to avoid MAX_ELEMENTS_EXCEEDED

        try:
            for i_start in range(0, n, chunk_size):
                i_end = min(i_start + chunk_size, n)
                origins = '|'.join(f"{lat},{lon}" for lat, lon in locations[i_start:i_end])

                for j_start in range(0, n, chunk_size):
                    j_end = min(j_start + chunk_size, n)
                    destinations = '|'.join(f"{lat},{lon}" for lat, lon in locations[j_start:j_end])

                    params = {
                        'origins': origins,
                        'destinations': destinations,
                        'key': self.api_key,
                        'mode': 'driving',
                        'language': 'it',
                    }
                    response = requests.get(
                        'https://maps.googleapis.com/maps/api/distancematrix/json',
                        params=params,
                        timeout=15
                    )

                    if response.status_code == 200:
                        data = response.json()
                        api_status = data.get('status', 'OK')
                        
                        if api_status != 'OK':
                            print(f"[ERROR] API Google Maps restituisce status: {api_status}. Uso fallback parziale.")
                            # Fallback geometrico per questa porzione
                            for ri in range(i_end - i_start):
                                for rj in range(j_end - j_start):
                                    lat1, lon1 = locations[i_start + ri]
                                    lat2, lon2 = locations[j_start + rj]
                                    dist_m = ((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2) ** 0.5 * 111000
                                    matrix[i_start + ri][j_start + rj] = int(dist_m / (30 / 3.6))
                            continue

                        rows = data.get('rows', [])
                        for ri, row in enumerate(rows):
                            for rj, element in enumerate(row.get('elements', [])):
                                if element.get('status') == 'OK':
                                    matrix[i_start + ri][j_start + rj] = element['duration']['value']
                                else:
                                    # Fallback: haversine / 30 km/h
                                    lat1, lon1 = locations[i_start + ri]
                                    lat2, lon2 = locations[j_start + rj]
                                    dist_m = ((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2) ** 0.5 * 111000
                                    matrix[i_start + ri][j_start + rj] = int(dist_m / (30 / 3.6))
                    else:
                        print(f"Google Distance Matrix HTTP error: {response.status_code}")
                        return self._euclidean_time_matrix(locations)

            return matrix

        except Exception as e:
            print(f"Google Distance Matrix error: {e}")
            return self._euclidean_time_matrix(locations)

    def get_route_geometry(self, stops):
        """
        Get real route geometry visiting stops in order using Google Directions API.
        Returns: { 'geometry': {'type': 'LineString', 'coordinates': [[lon,lat],...]},
                   'distance': meters, 'duration': seconds }
        """
        if not stops or len(stops) < 2:
            return None
        if not self.api_key:
            return None

        origin = f"{stops[0]['lat']},{stops[0]['lon']}"
        destination = f"{stops[-1]['lat']},{stops[-1]['lon']}"

        params = {
            'origin': origin,
            'destination': destination,
            'key': self.api_key,
            'mode': 'driving',
            'language': 'it',
        }

        if len(stops) > 2:
            waypoints = '|'.join(f"{s['lat']},{s['lon']}" for s in stops[1:-1])
            params['waypoints'] = waypoints

        try:
            response = requests.get(
                'https://maps.googleapis.com/maps/api/directions/json',
                params=params,
                timeout=15
            )
            if response.status_code == 200:
                data = response.json()
                routes = data.get('routes', [])
                if routes:
                    route = routes[0]
                    encoded = route['overview_polyline']['points']
                    coords = self._decode_polyline(encoded)
                    distance = sum(leg['distance']['value'] for leg in route['legs'])
                    duration = sum(leg['duration']['value'] for leg in route['legs'])
                    return {
                        'geometry': {'type': 'LineString', 'coordinates': coords},
                        'distance': distance,
                        'duration': duration,
                    }
            return None
        except Exception as e:
            print(f"Routing error: {e}")
            return None

    def _decode_polyline(self, encoded):
        """Decode a Google encoded polyline string to [[lon, lat], ...] for GeoJSON."""
        coords, index, lat, lng = [], 0, 0, 0
        while index < len(encoded):
            for is_lat in (True, False):
                result, shift, b = 0, 0, 0x20
                while b >= 0x20:
                    b = ord(encoded[index]) - 63
                    index += 1
                    result |= (b & 0x1F) << shift
                    shift += 5
                delta = ~(result >> 1) if result & 1 else result >> 1
                if is_lat:
                    lat += delta
                else:
                    lng += delta
            coords.append([lng / 1e5, lat / 1e5])  # GeoJSON: [lon, lat]
        return coords

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

    def _euclidean_time_matrix(self, locations):
        """Fallback time matrix using haversine distance / 30 km/h (seconds)."""
        n = len(locations)
        matrix = [[0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i == j: continue
                lat1, lon1 = locations[i]
                lat2, lon2 = locations[j]
                dist_m = ((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2) ** 0.5 * 111000
                matrix[i][j] = int(dist_m / (30 / 3.6))  # 30 km/h → m/s = 8.333
        return matrix
