
from app import smart_geocode

def test_geocoding():
    tests = [
        {
            "school": "IC Pergine 1", 
            "address": "Via Spiazzi, 2", 
            "expected_city": "Pergine",
            "desc": "Pergine School with generic address"
        },
        {
            "school": "IC Rovereto Nord", 
            "address": "fermata bus Viale Trento, bivio Brione", 
            "expected_city": "Rovereto",
            "desc": "Rovereto School with 'Trento' in address"
        },
        {
            "school": "Scuola Elementare Grigno", 
            "address": "Via Vittorio Emanuele", 
            "expected_city": "Grigno",
            "desc": "Grigno School"
        },
        {
            "school": "Liceo Galileo Galilei", 
            "address": "Piazza Venezia, 41", 
            "expected_city": "Trento", # Default
            "desc": "Trento School (Default)"
        }
    ]
    
    print("Running Geocoding Tests...\n")
    
    passes = 0
    for t in tests:
        print(f"--- Test: {t['desc']} ---")
        print(f"School: {t['school']}")
        print(f"Address: {t['address']}")
        
        # Test 1: Without School Name (Old Behavior expectation - might fail or default to Trento)
        # lat, lon, success = smart_geocode(t['address'])
        # print(f"  [Old] Coords: ({lat}, {lon})")
        
        # Test 2: With School Name (New Behavior)
        lat, lon, success = smart_geocode(t['address'], school_name=t['school'])
        print(f"  [New] Coords: ({lat}, {lon}) Success: {success}")
        
        # Verification Logic (Approximate Bounds)
        # Trento: ~46.06, 11.12
        # Pergine: ~46.06, 11.23
        # Rovereto: ~45.89, 11.04
        # Grigno: ~46.01, 11.63
        
        is_correct = False
        if t['expected_city'] == "Pergine":
            if 11.20 < lon < 11.28: is_correct = True
        elif t['expected_city'] == "Rovereto":
            if 45.80 < lat < 45.95: is_correct = True
        elif t['expected_city'] == "Grigno":
            if 11.60 < lon < 11.70: is_correct = True
        elif t['expected_city'] == "Trento":
             if 46.02 < lat < 46.12 and 11.05 < lon < 11.18: is_correct = True

        if is_correct:
            print("  -> PASS: Location seems correct for " + t['expected_city'])
            passes += 1
        else:
             print("  -> FAIL: Location mismatch for " + t['expected_city'])
             
        print("")
        
    print(f"Passed {passes}/{len(tests)} tests.")

if __name__ == "__main__":
    test_geocoding()
