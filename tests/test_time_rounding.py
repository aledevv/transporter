"""Tests for the 5-minute chained rounding of computed bus times."""
from unittest.mock import patch

import app as app_module
from app import round_up_to_5, calculate_return_times_for_routes


class TestRoundUpTo5:
    def test_rounds_up_to_next_multiple(self):
        assert round_up_to_5(9 * 60 + 3) == 9 * 60 + 5
        assert round_up_to_5(9 * 60 + 6) == 9 * 60 + 10

    def test_keeps_exact_multiples(self):
        assert round_up_to_5(9 * 60 + 5) == 9 * 60 + 5
        assert round_up_to_5(9 * 60 + 5.0000000001) == 9 * 60 + 5

    def test_fractional_minutes(self):
        assert round_up_to_5(540.2) == 545


class TestReturnTimesChain:
    def test_each_return_time_chains_from_rounded_previous(self):
        # Outbound order A -> B -> dest; return is dest -> B -> A
        routes = [{'outbound': {'stops': [
            {'type': 'pickup', 'name': 'A', 'time_to_next_min': 4},
            {'type': 'pickup', 'name': 'B', 'time_to_next_min': 7},
            {'type': 'destination', 'name': 'D'},
        ]}}]
        calculate_return_times_for_routes(routes, '16:00')
        stops = routes[0]['outbound']['stops']
        # B: 16:00 + 7 = 16:07 -> 16:10
        assert stops[1]['return_time'] == '16:10'
        # A: 16:10 + 3 dwell + 4 = 16:17 -> 16:20
        assert stops[0]['return_time'] == '16:20'


def _evaluate(client, time_mode, start_time):
    route = {'vehicle_id': 0, 'outbound': {'stops': [
        {'type': 'pickup', 'name': 'A', 'lat': 46.0, 'lon': 11.0, 'count': 10},
        {'type': 'pickup', 'name': 'B', 'lat': 46.01, 'lon': 11.01, 'demand': 10},
        {'type': 'destination', 'name': 'D', 'lat': 46.02, 'lon': 11.02},
    ]}}
    geo = {'geometry': None, 'distance': 5000, 'duration': 960,
           'leg_distances': [2000, 3000], 'leg_durations': [5 * 60 + 30, 10 * 60 + 30]}
    with patch.object(app_module.geocoder, 'get_route_geometry', return_value=geo), \
         patch.object(app_module, 'find_bus_overlaps', return_value=[]):
        resp = client.post('/api/evaluate_plan', json={
            'routes': [route], 'destination': 'D', 'dest_lat': 46.02, 'dest_lon': 11.02,
            'start_time': start_time, 'time_mode': time_mode,
            'fine_manifestazione': '', 'calculate_return': False,
        })
    assert resp.status_code == 200
    return resp.get_json()['routes'][0]['outbound']['stops']


class TestOutboundChain:
    def test_departure_mode_chains_rounded_times(self, app_client):
        stops = _evaluate(app_client, 'departure', '09:03')
        # A: 09:03 -> 09:05; B: 09:05 + 3 + 5.5 = 09:13.5 -> 09:15; D: 09:15 + 3 + 10.5 = 09:28.5 -> 09:30
        assert stops[0]['departure_time'] == '09:05'
        assert stops[1]['departure_time'] == '09:15'
        assert stops[2]['arrival_time'] == '09:30'

    def test_arrival_mode_stays_on_grid_and_not_late(self, app_client):
        stops = _evaluate(app_client, 'arrival', '08:03')
        times = [stops[0]['departure_time'], stops[1]['departure_time'], stops[2]['arrival_time']]
        for t in times:
            assert int(t.split(':')[1]) % 5 == 0
        assert stops[2]['arrival_time'] == '08:00'
        assert times == ['07:35', '07:45', '08:00']


class TestOptimizeEndpoint:
    def test_optimize_returns_rounded_chained_times(self, app_client):
        schools = [
            {'name': 'A', 'address': 'a', 'lat': 46.00, 'lon': 11.00, 'demand': 10},
            {'name': 'B', 'address': 'b', 'lat': 46.01, 'lon': 11.01, 'demand': 10},
        ]

        def time_matrix(locations):
            n = len(locations)
            return [[0 if i == j else 400 for j in range(n)] for i in range(n)]

        geo = {'geometry': None, 'distance': 5000, 'duration': 960,
               'leg_distances': [2000, 3000], 'leg_durations': [5 * 60 + 30, 10 * 60 + 30]}
        with patch.object(app_module.geocoder, 'get_time_matrix', side_effect=time_matrix), \
             patch.object(app_module.geocoder, 'get_route_geometry', return_value=geo), \
             patch.object(app_module, 'find_bus_overlaps', return_value=[]):
            resp = app_client.post('/api/optimize', json={
                'schools': schools, 'destination': 'D', 'capacity': 50,
                'dest_lat': 46.02, 'dest_lon': 11.02,
                'start_time': '09:03', 'time_mode': 'departure',
                'fine_manifestazione': '16:00', 'calculate_return': True,
            })
        assert resp.status_code == 200, resp.get_json()
        routes = resp.get_json()['routes']
        assert len(routes) == 1
        stops = routes[0]['outbound']['stops']
        pickups = [s for s in stops if s['type'] == 'pickup']
        dest = [s for s in stops if s['type'] == 'destination'][0]
        assert [s['departure_time'] for s in pickups] == ['09:05', '09:15']
        assert dest['arrival_time'] == '09:30'
        # return: 16:00 + 10 (rounded leg) -> 16:10; 16:10 + 3 + 6 -> 16:20
        assert [s['return_time'] for s in pickups] == ['16:20', '16:10']
