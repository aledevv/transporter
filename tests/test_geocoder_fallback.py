"""Distance/time fallbacks of GeocodingService when no OSRM server answers."""
from unittest.mock import patch

import geocoder as geo
from geocoder import GeocodingService

TRENTO = (46.0679, 11.1211)
ROVERETO = (45.8906, 11.0400)


class _Resp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


def test_estimates_match_trentino_roads():
    # Trento -> Rovereto: ~20.8 km straight, ~25-26 km by road, ~25 min by car
    road_km = geo.estimate_road_m(*TRENTO, *ROVERETO) / 1000
    assert 25 < road_km < 35
    assert 20 < geo.estimate_drive_s(road_km * 1000) / 60 < 40
    assert geo.estimate_drive_s(0) == 0


def test_matrix_falls_back_to_estimates_and_flags_it():
    g = GeocodingService()
    with patch.object(geo.requests, 'get', side_effect=OSError('down')), patch.object(geo.time, 'sleep'):
        tm = g.get_time_matrix([TRENTO, ROVERETO])
        dm = g.get_distance_matrix([TRENTO, ROVERETO])
    assert g.last_matrix_estimated
    assert dm[0][0] == 0 and dm[0][1] == dm[1][0] > 25000
    assert tm[0][1] > 20 * 60


def test_second_server_used_and_one_table_call_for_both_matrices():
    g = GeocodingService()
    ok = {'code': 'Ok', 'durations': [[0, 1500], [1510, 0]], 'distances': [[0, 26000], [26100, 0]]}
    calls = []

    def fake_get(url, **kwargs):
        calls.append(url)
        if url.startswith(geo.OSRM_SERVERS[0]):
            return _Resp(429, {})
        return _Resp(200, ok)

    with patch.object(geo.requests, 'get', side_effect=fake_get), patch.object(geo.time, 'sleep'):
        tm = g.get_time_matrix([TRENTO, ROVERETO])
        dm = g.get_distance_matrix([TRENTO, ROVERETO])
    assert not g.last_matrix_estimated
    assert tm[0][1] == 1500 and dm[1][0] == 26100
    assert sum(u.startswith(geo.OSRM_SERVERS[1]) for u in calls) == 1


def test_missing_cells_are_estimated():
    g = GeocodingService()
    holes = {'code': 'Ok', 'durations': [[0, None], [1510, 0]], 'distances': [[0, None], [26100, 0]]}
    with patch.object(geo.requests, 'get', return_value=_Resp(200, holes)):
        dm = g.get_distance_matrix([TRENTO, ROVERETO])
    assert g.last_matrix_estimated
    assert dm[0][1] > 25000
