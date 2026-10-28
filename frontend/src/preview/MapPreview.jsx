import React, { useEffect, useState } from 'react';
import RouteMapGL, { ROUTE_COLORS } from '../components/RouteMapGL';

// Local-only comparison of map styles on a real trip (open with ?preview=map).
// Basemaps: OpenFreeMap vector styles (free, no key, OpenStreetMap data).
const STYLES = [
    ['Positron', 'Chiara, minimale: i percorsi risaltano', 'https://tiles.openfreemap.org/styles/positron'],
    ['Liberty', 'Più dettagli: strade, edifici, verde', 'https://tiles.openfreemap.org/styles/liberty'],
    ['Bright', 'Colori pieni, stile mappa stradale', 'https://tiles.openfreemap.org/styles/bright'],
];

export default function MapPreview() {
    const [trip, setTrip] = useState(null);
    useEffect(() => { fetch('/preview-data/trip-is.json').then(r => r.json()).then(setTrip); }, []);
    if (!trip) return <div className="p-10 text-slate-500">Caricamento…</div>;

    return (
        <div className="min-h-screen bg-slate-100 p-6">
            <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
                <h1 className="text-lg font-semibold text-slate-900">Anteprima mappe · Corsa Campestre IS ({trip.routes.length} bus)</h1>
                <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                    {trip.routes.map((r, i) => (
                        <span key={r.vehicle_id} className="inline-flex items-center gap-1.5">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: ROUTE_COLORS[i % ROUTE_COLORS.length] }} /> Bus #{r.vehicle_id + 1}
                        </span>
                    ))}
                </div>
                <span className="text-xs text-slate-400">Passa col mouse su un percorso per evidenziarlo · frecce dallo zoom 11</span>
            </div>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                {STYLES.map(([name, note, url]) => (
                    <div key={name} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                        <div className="flex items-baseline gap-2 border-b border-slate-100 px-4 py-2.5">
                            <span className="text-sm font-semibold text-slate-800">{name}</span>
                            <span className="text-xs text-slate-500">{note}</span>
                        </div>
                        <RouteMapGL routes={trip.routes} destCoords={trip.destCoords} styleUrl={url} className="h-[72vh] w-full" onReady={m => { (window.__maps ||= []).push(m); }} />
                    </div>
                ))}
            </div>
        </div>
    );
}
