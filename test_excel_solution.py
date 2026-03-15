from app import smart_geocode
import pandas as pd
import math
from app import geocoder

def test_excel(filepath):
    df = pd.read_excel(filepath)
    df = df.dropna(subset=['Nome', 'Soluzione'])
    
    # Raggruppa per Soluzione
    groups = df.groupby('Soluzione')
    
    print(f"Trovati {len(groups)} bus/soluzioni in {filepath}")
    
    dest_address = "Trento Fiere, Trento"
    dest_lat, dest_lon = geocoder.get_coordinates(dest_address)
    
    for sol, group in groups:
        print(f"\n=======================")
        print(f"--- Soluzione {sol} ---")
        stazioni = group.to_dict('records')
        
        nodi = []
        for i, row in enumerate(stazioni):
            # mock lat/lon finding
            lat, lon, success = smart_geocode(row['Indirizzo'])
            if not success:
                print(f"FALLITO Geocoding per {row['Indirizzo']}")
            nodi.append({
                'id': i+1,
                'name': row['Nome'],
                'address': row['Indirizzo'],
                'lat': lat,
                'lon': lon,
                'demand': row.get('Partecipanti', 0)
            })
            print(f"  Fermata {i+1}: {row['Nome']} - {row['Indirizzo']}")
            
        if not nodi:
            continue
            
        print("\n  [Simulazione Calcolo Tempi]")
        
        # Estrai locations [ (lat, lon) ]
        locations = [(n['lat'], n['lon']) for n in nodi]
        
        # Calcola matrice tempi di tutti i nodi tra loro
        time_matrix_nodes = geocoder.get_time_matrix(locations)
        
        # Calcola distanza diretta nodi -> destinazione
        direct_to_dest = []
        for loc in locations:
             # get_time_matrix per 2 punti restiuisce matrice [[0, dist], [dist, 0]]
             dist_to_dest = geocoder.get_time_matrix([loc, (dest_lat, dest_lon)])[0][1]
             direct_to_dest.append(dist_to_dest)
             
        # Simula il nuovo vincolo per ogni step (da 1 a N)
        # Requisito: Tempo(1 -> 2 -> ... -> N -> Dest) - Tempo(1 -> Dest) <= 20 min
        # Questo per la "Soluzione Ideale" DOVREBBE essere sempre VERO
        
        print(f"  Distanza DIRETTA (Fermata 1 -> Destinazione): {direct_to_dest[0]} sec ({direct_to_dest[0]/60:.1f} min)")
        
        cum_time = 0
        for i in range(len(nodi)):
            if i == 0:
                # Se è l'unica scuola, la differenza è ovviamene 0
                diff_sec = 0
                total_time = direct_to_dest[0]
            else:
                # Aggiungiamo il tempo dalla scuola i-1 alla scuola i
                cum_time += time_matrix_nodes[i-1][i]
                # Tempo totale = tempo accumulato per arrivare a i + tempo da i a destinazione
                total_time = cum_time + direct_to_dest[i]
                
                # Differenza rispetto al tempo diretto dalla scuola 1
                diff_sec = total_time - direct_to_dest[0]
                
            status = "OK" if diff_sec <= 1200 else ("VIOLATO" if diff_sec > 1200 else "?")
            
            print(f"  +Aggiunta Fermata {i+1}. Tempo tot: {total_time} sec ({total_time/60:.1f} min). "
                  f"Differenza da diretta F1: +{diff_sec} sec (+{diff_sec/60:.1f} min) -> [{status}]")

if __name__ == "__main__":
    test_excel('esempioTest.xlsx')
