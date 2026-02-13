import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { Settings, Play, Users, Bus, Navigation, Edit, Download, Clock, Building2 } from 'lucide-react';
import Map from './Map';
import AddressAutocomplete from './AddressAutocomplete';
import SchoolEditor from './SchoolEditor';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import API_BASE_URL from '../config';

// Route colors (must match Map.jsx COLORS array)
const ROUTE_COLORS = [
    '#3b82f6', '#ef4444', '#22c55e', '#eab308',
    '#a855f7', '#f97316', '#ec4899', '#14b8a6'
];

const Dashboard = ({ schools, setSchools, startInEditMode = false, instituteColorMap = {} }) => {
    const [destination, setDestination] = useState('');
    const [destCoords, setDestCoords] = useState(null);
    const [capacity, setCapacity] = useState(50);
    const [strategy, setStrategy] = useState('distance');

    const [startTime, setStartTime] = useState('08:00');
    // 'departure' implies startTime is when buses leave.
    // 'arrival' implies startTime is when buses must ARRIVE.
    const [timeMode, setTimeMode] = useState('departure');

    // UI State
    const [showEditor, setShowEditor] = useState(startInEditMode);

    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState(null);
    const [error, setError] = useState('');

    // Refs for Auto-scroll
    const resultsRef = useRef(null);

    // Scroll to results when available
    useEffect(() => {
        if (results && resultsRef.current) {
            setTimeout(() => {
                resultsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }
    }, [results]);

    // Reset results if schools change (new upload)
    useEffect(() => {
        setResults(null);
    }, [schools]);

    const handleOptimize = async () => {
        if (!destination) {
            setError("Inserisci un indirizzo di destinazione.");
            return;
        }
        setError('');
        setLoading(true);
        setResults(null);

        try {
            const payload = {
                schools: schools,
                destination: destination,
                capacity: parseInt(capacity),
                dest_lat: destCoords?.lat,
                dest_lon: destCoords?.lon,
                strategy: strategy,
                start_time: startTime,
                time_mode: timeMode // Send mode to backend
            };

            const response = await axios.post(`${API_BASE_URL}/api/optimize`, payload);
            setResults(response.data);

        } catch (err) {
            console.error(err);
            setError(err.response?.data?.error || "Ottimizzazione fallita.");
        } finally {
            setLoading(false);
        }
    };

    const handleDataSave = (updatedSchools) => {
        setSchools(updatedSchools);
        setShowEditor(false);
    };

    const handlePdfExport = () => {
        if (!results) return;
        const doc = new jsPDF();

        doc.setFontSize(20);
        doc.text("Pianificazione Viaggio - Transporter", 14, 22);

        doc.setFontSize(11);
        doc.text(`Destinazione: ${destination}`, 14, 32);
        doc.text(`Strategia: ${strategy === 'distance' ? 'Percorso più breve' : strategy === 'balanced' ? 'Bilanciato' : 'Minimo Veicoli'}`, 14, 38);

        // Overview Stats
        const stats = [
            ['Bus Totali', results.stats.total_buses],
            ['Passeggeri Totali', results.stats.total_passengers],
            ['Distanza Totale (solo andata)', `${(results.stats.total_distance / 1000).toFixed(1)} km`]
        ];

        autoTable(doc, {
            startY: 45,
            head: [['Metrica', 'Valore']],
            body: stats,
            theme: 'striped',
            headStyles: { fillColor: [41, 128, 185] }
        });

        let finalY = doc.lastAutoTable.finalY + 10;

        // Routes
        results.routes.forEach((route, idx) => {
            doc.text(`Bus #${route.vehicle_id + 1} - Carico: ${route.total_load}/${capacity}`, 14, finalY);

            // Build stop rows with times
            const rows = route.outbound.stops.map((stop, i) => {
                if (i === 0 && stop.type === 'destination') return null; // Skip start depot in PDF too
                const time = stop.type === 'destination' ? stop.arrival_time : stop.departure_time;
                return [
                    stop.type === 'destination' ? '>>> ARRIVO' : stop.name,
                    stop.count > 0 ? stop.count : '-',
                    time || '-'
                ];
            }).filter(Boolean);

            autoTable(doc, {
                startY: finalY + 5,
                head: [['Fermata', 'Passeggeri', 'Orario']],
                body: rows,
                theme: 'grid',
                headStyles: { fillColor: [52, 152, 219] }
            });

            finalY = doc.lastAutoTable.finalY + 15;

            // New page if needed
            if (finalY > 250) {
                doc.addPage();
                finalY = 20;
            }
        });

        doc.save('piano_trasporti.pdf');
    };

    // Calculate Map items
    let mapRoutes = [];
    if (results) {
        mapRoutes = results.routes.map(r => ({
            ...r,
            // Always outbound since Return tab is removed
            stops: r.outbound.stops,
            geometry: r.outbound.geometry
        }));
    }

    let mapDestination = null;
    if (destCoords && destination) {
        mapDestination = { lat: destCoords.lat, lon: destCoords.lon, address: destination };
    }

    // Map Focus State
    const [focusBounds, setFocusBounds] = useState(null);
    const [highlightedRouteId, setHighlightedRouteId] = useState(null); // vehicle_id to highlight

    const handleFocusSegment = (stop, nextStop, routeVehicleId) => {
        if (!stop || !nextStop) return;
        setFocusBounds([
            [stop.lat, stop.lon],
            [nextStop.lat, nextStop.lon]
        ]);
        setHighlightedRouteId(routeVehicleId);
    };

    const handleResetFocus = () => {
        setFocusBounds(null);
        setHighlightedRouteId(null);
    };

    if (showEditor) {
        return (
            <div className="h-[calc(100vh-100px)]">
                <SchoolEditor schools={schools} onSave={handleDataSave} instituteColorMap={instituteColorMap} />
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Top Row: Configuration + Map side by side */}
            <div className="flex flex-col lg:flex-row gap-6">
                {/* Configuration + Stats Column */}
                <div className="w-full lg:w-1/3 space-y-6">
                    {/* Configuration Card */}
                    <div className="bg-gray-50 p-5 rounded-xl border border-gray-200">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="flex items-center gap-2 font-semibold text-gray-700">
                                <Settings className="w-5 h-5" /> Configurazione
                            </h3>
                            <button
                                onClick={() => setShowEditor(true)}
                                className="text-xs flex items-center gap-1 text-blue-600 hover:text-blue-800 font-medium"
                            >
                                <Edit className="w-3 h-3" /> Modifica Dati ({schools.length})
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-600 mb-1">Indirizzo Destinazione</label>
                                <AddressAutocomplete
                                    value={destination}
                                    onChange={setDestination}
                                    onSelect={(data) => {
                                        setDestination(data.address);
                                        setDestCoords({ lat: data.lat, lon: data.lon });
                                    }}
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-600 mb-1">Capienza Bus</label>
                                    <div className="relative">
                                        <Users className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
                                        <input
                                            type="number"
                                            className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                                            value={capacity}
                                            onChange={(e) => setCapacity(e.target.value)}
                                            min="1"
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-gray-600 mb-1">Strategia</label>
                                    <select
                                        className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 outline-none bg-white"
                                        value={strategy}
                                        onChange={(e) => setStrategy(e.target.value)}
                                    >
                                        <option value="distance">Percorso Breve</option>
                                        <option value="balanced">Bilanciato</option>
                                        <option value="vehicles">Minimo Bus</option>
                                    </select>
                                </div>
                                <div className="col-span-2">
                                    {/* Time Mode Selection */}
                                    <label className="block text-sm font-medium text-gray-600 mb-1">Modalità Orario</label>
                                    <div className="flex bg-gray-200 p-1 rounded-lg mb-2">
                                        <button
                                            onClick={() => setTimeMode('departure')}
                                            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${timeMode === 'departure' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                                        >
                                            Partenza
                                        </button>
                                        <button
                                            onClick={() => setTimeMode('arrival')}
                                            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${timeMode === 'arrival' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                                        >
                                            Arrivo
                                        </button>
                                    </div>

                                    <div className="relative">
                                        <Clock className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
                                        <input
                                            type="time"
                                            className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                                            value={startTime}
                                            onChange={(e) => setStartTime(e.target.value)}
                                        />
                                    </div>
                                    <p className="text-xs text-gray-400 mt-1">
                                        {timeMode === 'departure'
                                            ? "Orario in cui i bus partono dalla prima scuola."
                                            : "Orario in cui TUTTI i bus devono essere a destinazione."
                                        }
                                    </p>
                                </div>
                            </div>

                            <button
                                onClick={handleOptimize}
                                disabled={loading || !destination}
                                className={`w-full py-3 rounded-lg font-medium text-white flex items-center justify-center gap-2 transition-colors
                            ${loading || !destination ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 shadow-md'}`}
                            >
                                {loading ? 'Calcolo in corso...' : <><Play className="w-5 h-5" /> Calcola Percorsi</>}
                            </button>

                            {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
                        </div>
                    </div>

                    {/* Results Stats */}
                    {results && (
                        <div ref={resultsRef} className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm animate-fade-in">
                            <h3 className="font-semibold text-gray-700 mb-4">Risultati</h3>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="bg-blue-50 p-3 rounded-lg">
                                    <div className="text-blue-500 text-xs font-medium uppercase">Bus Totali</div>
                                    <div className="text-xl font-bold text-gray-800">{results.stats.total_buses}</div>
                                </div>
                                <div className="bg-purple-50 p-3 rounded-lg">
                                    <div className="text-purple-600 text-xs font-medium uppercase">Passeggeri</div>
                                    <div className="text-xl font-bold text-gray-800">{results.stats.total_passengers}</div>
                                </div>
                                <div className="col-span-2 bg-green-50 p-3 rounded-lg">
                                    <div className="flex justify-between items-center mb-1">
                                        <div className="text-green-600 text-xs font-medium uppercase">Distanza Totale (solo andata)</div>
                                        <div className="text-lg font-bold text-green-700">{(results.stats.total_distance / 1000).toFixed(1)} km</div>
                                    </div>
                                </div>
                                {results.stats.arrival_window && (
                                    <div className="col-span-2 bg-orange-50 p-3 rounded-lg">
                                        <div className="flex justify-between items-center">
                                            <div className="text-orange-600 text-xs font-medium uppercase">Arrivo a Destinazione</div>
                                            <div className="text-sm font-bold text-orange-700">
                                                {results.stats.arrival_window.spread_minutes === 0 ? (
                                                    <span>Tutti i bus arrivano insieme alle {results.stats.arrival_window.earliest}</span>
                                                ) : (
                                                    <span>
                                                        Da {results.stats.arrival_window.earliest} a {results.stats.arrival_window.latest}
                                                        <span className="text-xs font-normal ml-2">({results.stats.arrival_window.spread_minutes} min)</span>
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Map Column */}
                <div className="w-full lg:w-2/3">
                    <div className="relative h-[500px] lg:h-full min-h-[400px]">
                        <Map
                            schools={schools}
                            routes={mapRoutes}
                            destination={mapDestination}
                            focusBounds={focusBounds}
                            highlightedRouteId={highlightedRouteId}
                            onResetFocus={handleResetFocus}
                            instituteColorMap={instituteColorMap}
                        />
                    </div>
                </div>
            </div>

            {/* Bottom Section: Route Details (Full Width) */}
            {results && (
                <div className="w-full mt-6">
                    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                        <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 flex justify-between items-center">
                            <span className="text-sm font-medium text-gray-600">Dettagli Percorsi</span>
                            <span className="text-xs text-gray-400">{results.routes.length} bus attivi</span>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
                            {results.routes.map((route, idx) => {
                                const activeData = route.outbound;
                                return (
                                    <div key={idx} className="bg-gray-50 rounded-lg p-5 border border-gray-100 hover:border-blue-200 hover:shadow-sm transition-all">
                                        <div className="flex items-center justify-between mb-3">
                                            <span className="font-bold text-gray-800 flex items-center gap-2">
                                                <Bus className="w-4 h-4" style={{ color: ROUTE_COLORS[idx % ROUTE_COLORS.length] }} />
                                                <span style={{ color: ROUTE_COLORS[idx % ROUTE_COLORS.length] }}>Bus #{route.vehicle_id + 1}</span>
                                            </span>
                                            <div className="flex flex-col items-end">
                                                <span className="text-xs font-mono bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                                                    {route.total_load}/{capacity} pax
                                                </span>
                                                <span className="text-[10px] text-gray-400 mt-1">
                                                    {(activeData.distance / 1000).toFixed(1)} km
                                                </span>
                                            </div>
                                        </div>
                                        <div className="ml-2 pl-3 border-l-2 border-gray-200 space-y-3">
                                            {activeData.stops.map((stop, sIdx) => {
                                                if (sIdx === 0 && stop.type === 'destination') {
                                                    return null;
                                                }

                                                const isDest = stop.type === 'destination';

                                                if (isDest) {
                                                    return (
                                                        <div key={sIdx} className="pt-2 border-t border-dashed border-gray-200 mt-2">
                                                            <div className="flex items-center justify-between">
                                                                <div className="flex items-center gap-2">
                                                                    <Navigation className="w-4 h-4 text-green-600" />
                                                                    <span className="font-bold text-sm text-gray-800">Arrivo</span>
                                                                </div>
                                                                <span className="text-xs text-green-600 font-mono font-bold">
                                                                    {stop.arrival_time || ''}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    )
                                                }

                                                return (
                                                    <div key={sIdx} className="flex items-center justify-between text-sm">
                                                        <div className="flex items-center gap-2">
                                                            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-xs font-bold font-mono">
                                                                {sIdx}
                                                            </span>
                                                            <div className="flex items-center gap-1.5">
                                                                <span className="font-medium text-gray-700 text-sm leading-tight" style={{ wordBreak: 'break-word' }}>{stop.name}</span>
                                                                {/* Institute indicator if school has institute */}
                                                                {(() => {
                                                                    const school = schools.find(s => s.name === stop.name || s.address === stop.address);
                                                                    if (school && school.institute) {
                                                                        const instituteColor = instituteColorMap[school.institute] || '#3b82f6';
                                                                        return (
                                                                            <div className="flex items-center gap-1" title={school.institute}>
                                                                                <Building2 className="w-3 h-3" style={{ color: instituteColor }} />
                                                                                <span className="text-[10px] font-medium" style={{ color: instituteColor }}>{school.institute}</span>
                                                                            </div>
                                                                        );
                                                                    }
                                                                    return null;
                                                                })()}
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-1">
                                                            <span className="text-[10px] text-gray-400 font-mono">
                                                                {stop.departure_time || ''}
                                                            </span>
                                                            <span className="font-bold text-gray-800 bg-white px-1.5 py-0.5 rounded text-xs border border-gray-100">
                                                                {stop.count}
                                                            </span>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Export Button */}
                        <div className="border-t border-gray-100 p-4 bg-gray-50">
                            <button
                                onClick={handlePdfExport}
                                className="w-full py-3 rounded-lg font-medium text-white bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 flex items-center justify-center gap-2 shadow-md transition-all"
                            >
                                <Download className="w-5 h-5" /> Esporta Percorso (PDF)
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Dashboard;
