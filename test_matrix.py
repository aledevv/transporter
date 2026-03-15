from app import app
import json

payload = {
    'schools': [{'name': 'Test', 'address': 'Via', 'demand': 10, 'lat': 46.0, 'lon': 11.0, 'institute': 'Inst'}],
    'destination': 'Trento',
    'capacity': 50
}

import sys, traceback
try:
    with app.test_client() as client:
        resp = client.post('/api/optimize', json=payload)
        data = resp.get_json()
        if 'error' in data:
            print("ERROR:", data['error'])
        else:
            print(data['routes'][0]['outbound']['stops'])
except Exception as e:
    traceback.print_exc()
