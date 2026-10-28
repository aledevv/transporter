
import math
import threading
import time
import requests
import nominatim_cache
import nominatim_rate_limiter

NOMINATIM_BASE = 'https://nominatim.openstreetmap.org'
# Public OSRM servers (car profile), tried in order. The FOSSGIS one is a mirror
# of the same OSM data, used when the demo server is down or rate-limits us.
OSRM_SERVERS = (
    'https://router.project-osrm.org',
    'https://routing.openstreetmap.de/routed-car',
)
OSRM_BASE = OSRM_SERVERS[0]
FALLBACK_COORDS = (46.0697, 11.1211)  # Trento center

# Used only when no OSRM server answers. Fitted on ~27k OSRM pairs of the
# Trentino fixtures (tests/realSuite): road km are a median 1.58x the straight
# line, and car minutes are about 4 + 0.94 per road km.
ROAD_DETOUR_FACTOR = 1.55
FALLBACK_MIN_BASE = 4.0
FALLBACK_MIN_PER_KM = 0.94
_USER_AGENT = 'BusPlan/1.0 (bus route optimizer for Trentino schools)'


def estimate_road_m(lat1, lon1, lat2, lon2):
    """Road distance estimate (meters) from the straight line, for when OSRM is unreachable."""
    return haversine_m(lat1, lon1, lat2, lon2) * ROAD_DETOUR_FACTOR


def estimate_drive_s(road_m):
    """Car travel time estimate (seconds) for a road distance, for when OSRM is unreachable."""
    if road_m <= 0:
        return 0
    return (FALLBACK_MIN_BASE + FALLBACK_MIN_PER_KM * road_m / 1000) * 60


def haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance between two points (meters)."""
    R = 6371000
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _osrm_get(service, coords, params, timeout=15):
    """GET an OSRM service on the first server that answers 'Ok'; None if none does."""
    for base in OSRM_SERVERS:
        for attempt in range(2):
            try:
                resp = requests.get(f'{base}/{service}/v1/driving/{coords}', params=params,
                                    headers={'User-Agent': _USER_AGENT}, timeout=timeout)
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get('code') == 'Ok':
                        return data
                    print(f"OSRM {service} on {base}: {data.get('code')} {data.get('message', '')}")
                    break  # a bad request will not get better on retry
                print(f"OSRM {service} on {base}: HTTP {resp.status_code}")
            except Exception as e:
                print(f"OSRM {service} on {base} error: {e}")
            if attempt == 0:
                time.sleep(1)
    return None


class GeocodingService:

    def __init__(self):
        self._local = threading.local()

    @property
    def last_matrix_estimated(self):
        """True if the last matrix built on this thread used straight-line estimates."""
        return getattr(self._local, 'estimated', False)

    def get_coordinates(self, address):
        """Geocodes address using Nominatim (OSM). Returns (lat, lon)."""
        try:
            cached = nominatim_cache.get(address, 1)
            if cached is not None:
                if cached:
                    return float(cached[0]['lat']), float(cached[0]['lon'])
                raise ValueError("cached empty")  # skip sleep, fall through to fallback
            nominatim_rate_limiter.wait()
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
                nominatim_cache.store(address, 1, data)  # cache even if empty
                if data:
                    return float(data[0]['lat']), float(data[0]['lon'])
        except Exception as e:
            print(f"Nominatim geocoding error for '{address}': {e}")
        print(f"Warning: Address '{address}' not found. Using Trento fallback.")
        return FALLBACK_COORDS

    def _table(self, locations):
        """(durations s, distances m) from the OSRM Table API, holes filled with estimates.
        Falls back to straight-line estimates if no server answers. Cached per thread
        for the last set of locations, since callers often ask for both matrices."""
        key = tuple((round(lat, 6), round(lon, 6)) for lat, lon in locations)
        cached = getattr(self._local, 'table', None)
        if cached and cached[0] == key:
            self._local.estimated = cached[3]
            return cached[1], cached[2]
        n = len(locations)
        coords = ';'.join(f"{lon},{lat}" for lat, lon in locations)
        data = _osrm_get('table', coords, {'annotations': 'duration,distance'})
        estimated = data is None
        if estimated:
            print(f"Warning: no OSRM server answered, using straight-line estimates for {n} points")
        durations = [[0] * n for _ in range(n)]
        distances = [[0] * n for _ in range(n)]
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                d = data['distances'][i][j] if data else None
                t = data['durations'][i][j] if data else None
                if d is None or t is None:
                    estimated = True
                    d = estimate_road_m(*locations[i], *locations[j])
                    t = estimate_drive_s(d)
                distances[i][j] = int(d)
                durations[i][j] = int(t)
        self._local.table = (key, durations, distances, estimated)
        self._local.estimated = estimated
        return durations, distances

    def get_distance_matrix(self, locations):
        """Returns road distance matrix (meters) using OSRM Table API."""
        if not locations:
            return []
        return self._table(locations)[1]

    def get_time_matrix(self, locations):
        """Returns car travel time matrix (seconds) using OSRM Table API."""
        if not locations:
            return []
        return self._table(locations)[0]

    def get_route_geometry(self, stops):
        """Get real route geometry using OSRM Route API.
        Returns: { 'geometry': GeoJSON LineString, 'distance': meters, 'duration': seconds,
                   'leg_distances': [...], 'leg_durations': [...] }
        """
        if not stops or len(stops) < 2:
            return None
        try:
            coords = ';'.join(f"{s['lon']},{s['lat']}" for s in stops)
            data = _osrm_get('route', coords, {'overview': 'full', 'geometries': 'geojson', 'steps': 'false'})
            if data:
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
        return haversine_m(lat1, lon1, lat2, lon2)
