
import pandas as pd
import requests
import time
import os
import math

# Configuration
BASE_URL = "http://localhost:5001"
TEST_FILE = "test_overlap_gen.xlsx"

def create_overlap_file():
    """Creates an Excel file with 22 schools at the same address"""
    data = []
    for i in range(22):
        data.append({
            'Nome': f'Scuola {i+1}',
            'Indirizzo': 'Piazza Dante, Trento', # Central Trento
            'Partecipanti': 10,
            'Istituto': f'Istituto {i+1}'
        })
    
    df = pd.DataFrame(data)
    df.to_excel(TEST_FILE, index=False)
    print(f"Created {TEST_FILE} with 22 overlapping schools.")

def test_upload_and_verify():
    # 1. Upload
    with open(TEST_FILE, 'rb') as f:
        files = {'file': f}
        print("Uploading file...")
        res = requests.post(f"{BASE_URL}/api/upload", files=files)
        
    if res.status_code != 202:
        print(f"Upload failed: {res.text}")
        return
    
    task_id = res.json()['task_id']
    print(f"Task ID: {task_id}")
    
    # 2. Poll
    while True:
        res = requests.get(f"{BASE_URL}/api/status/{task_id}")
        data = res.json()
        print(f"Status: {data['status']} - {data.get('progress')}%")
        
        if data['status'] == 'completed':
            result = data['result']
            break
        elif data['status'] == 'error':
            print(f"Task Error: {data.get('message')}")
            return
        time.sleep(1)
        
    # 3. Verify Coordinates
    coords = [(s['lat'], s['lon']) for s in result]
    unique_coords = set(coords)
    
    print(f"Total Schools: {len(result)}")
    print(f"Unique Coordinates: {len(unique_coords)}")
    
    if len(result) == len(unique_coords):
        print("PASS: All coordinates are unique!")
    else:
        print(f"FAIL: Only {len(unique_coords)} unique coordinates out of {len(result)}")
        
    # 4. Check Minimum Separation
    min_dist = 1000
    for i in range(len(coords)):
        for j in range(i + 1, len(coords)):
            lat1, lon1 = coords[i]
            lat2, lon2 = coords[j]
            dist = math.sqrt((lat1-lat2)**2 + (lon1-lon2)**2)
            if dist < min_dist:
                min_dist = dist
                
    print(f"Minimum Distance: {min_dist:.6f} degrees")
    if min_dist > 0.0001:
        print("PASS: Minimum separation is sufficient.")
    else:
        print("FAIL: Points are too close.")

if __name__ == "__main__":
    create_overlap_file()
    try:
        test_upload_and_verify()
    finally:
        if os.path.exists(TEST_FILE):
             os.remove(TEST_FILE)
