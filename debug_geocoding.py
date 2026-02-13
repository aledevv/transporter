
from geocoder import GeocodingService
import time

geocoder = GeocodingService()

addresses = [
    ("Grigno", "Grigno, Trento"), # Assuming Grigno was the one user complained about
    ("Rovereto", "Rovereto, fermata bus Viale Trento, bivio Brione, Trento"),
    ("Pergine", "Via Spiazzi, 2, Trento"), # Indirizzo from file + context
    ("Pergine Correct", "Via Spiazzi, 2, Pergine Valsugana"),
    ("Romagnano", "Piazza Condini, Trento"),
    ("Mezzolombardo", "Mezzolombardo Stazione FTM, Trento")
]

print("Testing Geocoding...\n")

for label, query in addresses:
    lat, lon = geocoder.get_coordinates(query)
    print(f"[{label}] Query: '{query}' -> ({lat}, {lon})")
    # Check if fallback
    if abs(lat - 46.0697) < 0.0001 and abs(lon - 11.1211) < 0.0001:
        print("  -> FALLBACK (Started Default Config)")
    else:
        print("  -> FOUND!")
    time.sleep(1)
