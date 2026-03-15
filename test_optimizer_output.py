import pandas as pd
import os
from dotenv import load_dotenv
load_dotenv()

from app import smart_geocode, app, geocoder

def test():
    df = pd.read_excel('esempioTest.xlsx')
    df = df.dropna(subset=['Nome', 'Soluzione'])
    
    schools_input = []
    for i, row in df.iterrows():
        lat, lon, _ = smart_geocode(row['Indirizzo'])
        schools_input.append({
            'name': row['Nome'],
            'address': row['Indirizzo'],
            'demand': int(row.get('Partecipanti', 0)),
            'institute': str(row['Nome']),
            'lat': lat,
            'lon': lon
        })
        
    payload = {
        'schools': schools_input,
        'destination': 'Trento Fiere, Trento',
        'capacity': 50,
        'time_mode': 'arrival',
        'start_time': '08:00'
    }
    
    with app.test_client() as client:
        response = client.post('/api/optimize', json=payload)
        data = response.get_json()
        
        if 'error' in data:
            print("ERRORE:", data['error'])
            return
            
        print(f"Buses usati: {data['stats']['total_buses']}")
        for i, route in enumerate(data['routes']):
            print(f"\n--- BUS {i+1} ---")
            for stop in route['outbound']['stops']:
                if stop['type'] == 'pickup':
                    print(f"  {stop['name']} (Pass: {stop['count']})")
                elif stop['type'] == 'destination':
                    print(f"  --> DESTINAZIONE")

if __name__ == '__main__':
    test()
