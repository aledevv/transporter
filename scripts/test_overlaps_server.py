import sys
import os
from flask import Flask, jsonify

# Add parent directory to path so we can import project modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from geocoder import GeocodingService
from scripts.find_overlaps import find_bus_overlaps

app = Flask(__name__)
geocoder = GeocodingService()

@app.route('/')
def index():
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>BusPlan - Test Overlaps</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/leaflet-polylineoffset@1.1.1/leaflet.polylineoffset.min.js"></script>
        <style>
            body { margin: 0; padding: 0; font-family: sans-serif; }
            #map { height: 100vh; width: 100%; }
            #info { position: absolute; top: 10px; right: 10px; z-index: 1000; background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.2); max-width: 300px; }
        </style>
    </head>
    <body>
        <div id="info">Caricamento in corso...</div>
        <div id="map"></div>
        <script>
            var map = L.map('map').setView([46.0697, 11.1211], 14);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

            fetch('/api/data').then(r => r.json()).then(data => {
                // Colori molto accesi e contrastanti
                const colors = {
                    1: '#FF00FF', // Magenta brillante
                    2: '#00FFFF', // Ciano brillante
                    3: '#FFEA00'  // Giallo brillante
                }; 
                
                // Disegna le route base
                data.routes.forEach((route) => {
                    const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
                    L.polyline(coords, {color: colors[route.vehicle_id] || '#ffffff', weight: 4, opacity: 0.3, dashArray: '5,5'}).addTo(map)
                     .bindPopup(`Bus ${route.vehicle_id} (percorso completo)`);
                });

                let html = `<b>Sovrapposizioni: ${data.overlaps.length}</b><br><ul style="padding-left: 20px; font-size:14px;">`;
                
                const lineWidth = 6;
                
                // Disegna le sovrapposizioni offsettate
                data.overlaps.forEach((overlap, i) => {
                    const coords = overlap.coordinates.map(c => [c[1], c[0]]);
                    
                    // Linea per Bus 1 (offset: -lineWidth/2)
                    L.polyline(coords, {
                        color: colors[overlap.bus_1], 
                        weight: lineWidth, 
                        opacity: 1,
                        offset: -(lineWidth / 2)
                    }).addTo(map)
                    .bindPopup(`Overlap tra Bus ${overlap.bus_1} e Bus ${overlap.bus_2} - Bus ${overlap.bus_1}`);

                    // Linea per Bus 2 (offset: +lineWidth/2)
                    L.polyline(coords, {
                        color: colors[overlap.bus_2], 
                        weight: lineWidth, 
                        opacity: 1,
                        offset: (lineWidth / 2)
                    }).addTo(map)
                    .bindPopup(`Overlap tra Bus ${overlap.bus_1} e Bus ${overlap.bus_2} - Bus ${overlap.bus_2}`);
                    
                    // Marker inizio (Messo al centro, tra le due linee)
                    L.circleMarker(coords[0], {color: '#ffffff', fillColor: '#000000', fillOpacity: 1, radius: 5, weight: 2}).addTo(map)
                     .bindPopup(`Inizio Overlap (${i+1})`);
                     
                    // Marker fine
                    L.circleMarker(coords[coords.length-1], {color: '#ffffff', fillColor: '#ff0000', fillOpacity: 1, radius: 5, weight: 2}).addTo(map)
                     .bindPopup(`Fine Overlap (${i+1})`);
                     
                    html += `<li>${overlap.distance_meters}m <i>(Direzione: ${overlap.direction})</i></li>`;
                });
                
                html += "</ul><p style='font-size:12px;color:gray;'>Le linee intere sono tratteggiate. I tratti pieni accostati sono i segmenti condivisi estratti.</p>";
                document.getElementById('info').innerHTML = html;
            });
        </script>
    </body>
    </html>
    """

@app.route('/api/data')
def get_data():
    # 3 percorsi inventati su strade di Trento per causare overlap "veri" lungo i viali principali
    
    # Bus 1: Da nord (Gardolo) verso sud (Stadio), asse via Brennero
    stops1 = [
        {'lat': 46.1030, 'lon': 11.1160},
        {'lat': 46.0697, 'lon': 11.1211}, # centro
        {'lat': 46.0550, 'lon': 11.1180}
    ]
    
    # Bus 2: Da Povo verso Ovest, passa per via s. pietro e poi attraversa a sud l'adige
    stops2 = [
        {'lat': 46.0680, 'lon': 11.1500}, # Povo
        {'lat': 46.0697, 'lon': 11.1211}, # incrocia il centro
        {'lat': 46.0550, 'lon': 11.1180}, # condivede la tratta a sud col bus 1
        {'lat': 46.0600, 'lon': 11.1000}
    ]
    
    # Bus 3: Verso nord percorrendo l'Asse sud-nord al contrario (stessa strada opposta direzione)
    stops3 = [
        {'lat': 46.0570, 'lon': 11.1180}, 
        {'lat': 46.0820, 'lon': 11.1200}
    ]

    r1_data = geocoder.get_route_geometry(stops1)
    r2_data = geocoder.get_route_geometry(stops2)
    r3_data = geocoder.get_route_geometry(stops3)
    
    routes = []
    if r1_data:
        routes.append({'vehicle_id': 1, 'geometry': r1_data['geometry']})
    if r2_data:
        routes.append({'vehicle_id': 2, 'geometry': r2_data['geometry']})
    if r3_data:
         routes.append({'vehicle_id': 3, 'geometry': r3_data['geometry']})
         
    # Trova gli overlaps ignorando robette sotto i 30 metri
    overlaps = find_bus_overlaps(routes, min_overlap_meters=30)
    
    return jsonify({
        'routes': routes,
        'overlaps': overlaps
    })

if __name__ == '__main__':
    print("Avvio mini-server test su http://127.0.0.1:5001")
    app.run(port=5001, debug=True)
