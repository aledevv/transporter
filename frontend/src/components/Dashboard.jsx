import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { serverTimestamp } from 'firebase/firestore';
import { Settings, Play, Users, Bus, Navigation, Edit, Download, Clock, Building2, PlusCircle, RotateCcw, FileText, X, CalendarDays, Bookmark, ChevronDown, MapPin, ArrowRight } from 'lucide-react';
import Map from './Map';
import AddressAutocomplete from './AddressAutocomplete';
import SchoolEditor from './SchoolEditor';
import API_BASE_URL from '../config';

// Route colors (must match Map.jsx COLORS array)
const ROUTE_COLORS = [
    '#3b82f6', '#ef4444', '#22c55e', '#eab308',
    '#a855f7', '#f97316', '#ec4899', '#14b8a6'
];

// ─── Dashboard ───
const Dashboard = ({ schools, setSchools, startInEditMode = false, instituteColorMap = {}, mapsKey = '', currentTripId, onTripSaved, onTripRenamed, onTripUpdated, tripToRestore }) => {
    const [destination, setDestination] = useState('');
    const [destCoords, setDestCoords] = useState(null);
    const [capacity, setCapacity] = useState(56);
    const [startTime, setStartTime] = useState('08:00');
    const [timeMode, setTimeMode] = useState('arrival');
    const [calculateReturn, setCalculateReturn] = useState(true);
    const [solver, setSolver] = useState('v2');
    const [fineManifestazione, setFineManifestazione] = useState('15:00');
    const [showEditor, setShowEditor] = useState(startInEditMode);
    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState(null);
    const [error, setError] = useState('');

    // Post-planning adjustments
    // routeShifts: { [vehicle_id]: number[] } — per-pickup-display-index extra minutes
    const [routeShifts, setRouteShifts] = useState({});
    // routeAdvances: { [vehicle_id]: number } — whole-bus departure advance in minutes (negative = earlier)
    const [routeAdvances, setRouteAdvances] = useState({});

    // Trip name for saving (editable by user)
    const [tripName, setTripName] = useState('');

    // Document generation settings (persisted fields)
    const [docDate, setDocDate] = useState('');
    const [docEventName, setDocEventName] = useState('');
    const [excludeAutonomia, setExcludeAutonomia] = useState(false);

    const resultsRef = useRef(null);
    const mapRef = useRef(null);

    useEffect(() => {
        if (results && resultsRef.current) {
            setTimeout(() => resultsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
        }
    }, [results]);


    useEffect(() => { setResults(null); setRouteShifts({}); setRouteAdvances({}); setTripName(''); }, [schools]);

    // Track when we're in the middle of restoring a trip (to suppress auto-save)
    const isRestoringRef = React.useRef(false);

    // Restore a saved trip
    useEffect(() => {
        if (!tripToRestore) return;
        isRestoringRef.current = true;
        setDestination(tripToRestore.destination || '');
        setDestCoords(tripToRestore.destCoords || null);
        setCapacity(tripToRestore.capacity);
        setStartTime(tripToRestore.startTime);
        setTimeMode(tripToRestore.timeMode);
        setResults(tripToRestore.results);
        setTripName(tripToRestore.label || '');
        
        // Restore document generation settings and advanced adjustments
        setDocEventName(tripToRestore.docEventName || '');
        setDocDate(tripToRestore.docDate || '');
        setExcludeAutonomia(tripToRestore.excludeAutonomia || false);
        setCalculateReturn(tripToRestore.calculateReturn ?? true);
        setFineManifestazione(tripToRestore.fineManifestazione || '15:00');
        setRouteShifts(tripToRestore.routeShifts || {});
        setRouteAdvances(tripToRestore.routeAdvances || {});
        
        setTimeout(() => { isRestoringRef.current = false; }, 1500);
    }, [tripToRestore]);

    // When user types an event name, use it as the trip name too
    useEffect(() => {
        if (docEventName) setTripName(docEventName);
    }, [docEventName]);

    // Debounce tripName changes → rename on Firestore
    useEffect(() => {
        if (!currentTripId || !tripName) return;
        const t = setTimeout(() => { onTripRenamed?.(currentTripId, tripName); }, 700);
        return () => clearTimeout(t);
    }, [tripName, currentTripId]);

    // Auto-save destination + destCoords to Firestore (debounced)
    useEffect(() => {
        if (!currentTripId || !destination || isRestoringRef.current) return;
        const t = setTimeout(() => {
            if (isRestoringRef.current) return;
            const fields = { destination, destCoords, stage: 'configured' };
            if (!tripName) {
                const dateStr = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
                fields.label = `${destination.split(',')[0]} - ${dateStr}`;
            }
            onTripUpdated?.(currentTripId, fields);
        }, 1000);
        return () => clearTimeout(t);
    }, [destination, destCoords, currentTripId]);

    // Auto-save capacity / startTime / timeMode to Firestore (debounced)
    useEffect(() => {
        if (!currentTripId || isRestoringRef.current) return;
        const t = setTimeout(() => {
            if (isRestoringRef.current) return;
            onTripUpdated?.(currentTripId, { capacity: parseInt(capacity), startTime, timeMode });
        }, 1000);
        return () => clearTimeout(t);
    }, [capacity, startTime, timeMode, currentTripId]);

    // Auto-save document generation settings to Firestore (debounced)
    useEffect(() => {
        if (!currentTripId || isRestoringRef.current) return;
        const t = setTimeout(() => {
            if (isRestoringRef.current) return;
            onTripUpdated?.(currentTripId, { docEventName, docDate, excludeAutonomia });
        }, 1000);
        return () => clearTimeout(t);
    }, [docEventName, docDate, excludeAutonomia, currentTripId]);

    // Auto-save adjustments and return settings to Firestore (debounced)
    useEffect(() => {
        if (!currentTripId || isRestoringRef.current) return;
        const t = setTimeout(() => {
            if (isRestoringRef.current) return;
            onTripUpdated?.(currentTripId, { routeShifts, routeAdvances, calculateReturn, fineManifestazione });
        }, 1000);
        return () => clearTimeout(t);
    }, [routeShifts, routeAdvances, calculateReturn, fineManifestazione, currentTripId]);

    // ── helpers ────────────────────────────────────────────────────────────────
    const shiftTime = (timeStr, deltaMin) => {
        if (!timeStr || !deltaMin) return timeStr;
        const clean = timeStr.split(' ')[0];
        const [h, m] = clean.split(':').map(Number);
        const total = h * 60 + m + deltaMin;
        const hh = Math.floor(Math.max(0, total) / 60) % 24;
        const mm = Math.max(0, total) % 60;
        return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };

    // Sum shifts from display index 0 up to (and including) upToIdx
    const getCumulativeShift = (vehicleId, upToIdx) => {
        const shifts = routeShifts[vehicleId] || [];
        let total = 0;
        for (let i = 0; i <= upToIdx; i++) total += (shifts[i] || 0);
        return total;
    };

    // Total shift for the route arrival = sum of all per-stop shifts
    const getTotalShift = (vehicleId, numPickups) =>
        getCumulativeShift(vehicleId, numPickups - 1);

    // Add buffer at a specific pickup display index
    const addStopShift = (vehicleId, displayIdx, prevDistKm) => {
        const increment = (prevDistKm == null || prevDistKm < 10) ? 5 : 10;
        setRouteShifts(prev => {
            const cur = [...(prev[vehicleId] || [])];
            cur[displayIdx] = (cur[displayIdx] || 0) + increment;
            return { ...prev, [vehicleId]: cur };
        });
    };

    const subStopShift = (vehicleId, displayIdx) => {
        setRouteShifts(prev => {
            const cur = [...(prev[vehicleId] || [])];
            cur[displayIdx] = (cur[displayIdx] || 0) - 5;
            return { ...prev, [vehicleId]: cur };
        });
    };
    const resetRouteShift = (vehicleId) =>
        setRouteShifts(prev => { const n = { ...prev }; delete n[vehicleId]; return n; });

    const resetStopShift = (vehicleId, displayIdx) => {
        setRouteShifts(prev => {
            const cur = [...(prev[vehicleId] || [])];
            cur[displayIdx] = 0;
            return { ...prev, [vehicleId]: cur };
        });
    };

    // Advance (negative shift) for whole bus departure
    const getRouteAdvance = (vehicleId) => routeAdvances[vehicleId] || 0;

    const addRouteAdvance = (vehicleId) =>
        setRouteAdvances(prev => ({ ...prev, [vehicleId]: (prev[vehicleId] || 0) - 5 }));

    const resetRouteAdvance = (vehicleId) =>
        setRouteAdvances(prev => { const n = { ...prev }; delete n[vehicleId]; return n; });

    // ── optimize ───────────────────────────────────────────────────────────────
    const handleOptimize = async () => {
        if (!destination) { setError("Inserisci un indirizzo di destinazione."); return; }
        setError(''); setLoading(true); setResults(null); setRouteShifts({}); setRouteAdvances({});
        try {
            const endpoint = solver === 'v1' ? '/api/optimize' : '/api/optimize_v2';
            const response = await axios.post(`${API_BASE_URL}${endpoint}`, {
                schools, destination, capacity: parseInt(capacity),
                dest_lat: destCoords?.lat, dest_lon: destCoords?.lon,
                start_time: startTime, time_mode: timeMode,
                fine_manifestazione: calculateReturn ? fineManifestazione : '',
                calculate_return: calculateReturn,
            });
            setResults(response.data);
            const defaultName = `${destination.split(',')[0]} · ${new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
            const resolvedName = tripName || defaultName;
            setTripName(resolvedName);
            if (onTripSaved) {
                await onTripSaved({
                    destination,
                    capacity: parseInt(capacity),
                    startTime,
                    timeMode,
                    schools,
                    calculateReturn,
                    fineManifestazione,
                    routeShifts: {},
                    routeAdvances: {},
                    results: response.data,
                    label: resolvedName,
                    savedAt: serverTimestamp(),
                });
            }
        } catch (err) {
            setError(err.response?.data?.error || "Ottimizzazione fallita.");
        } finally {
            setLoading(false);
        }
    };

    const handleDataSave = (updatedSchools) => { setSchools(updatedSchools); setShowEditor(false); };

    // ── build stop rows (shared between PDF and DOCX) ─────────────────────────
    const buildStopRows = (route) => {
        const stops = route.outbound.stops;
        const pickupStops = stops.filter(s => s.type === 'pickup');
        const numPickups = pickupStops.length;
        const totalShift = getTotalShift(route.vehicle_id, numPickups);
        const advance = getRouteAdvance(route.vehicle_id);
        let pickupIdx = 0;
        const rows = [];
        stops.forEach((stop, i) => {
            if (i === 0 && stop.type === 'destination') return;
            if (stop.type === 'destination') {
                rows.push({ label: '>>> ARRIVO', address: '', count: '-', time: shiftTime(stop.arrival_time, totalShift + advance) || '-', isDest: true });
            } else {
                const cumShift = getCumulativeShift(route.vehicle_id, pickupIdx) + advance;
                rows.push({
                    label: stop.name,
                    address: stop.address || '',
                    count: stop.count != null ? String(stop.count) : '-',
                    time: shiftTime(stop.departure_time, cumShift) || '-',
                    return_time: stop.return_time || '',
                    isDest: false
                });
                if (stop.dist_to_next_km != null) {
                    rows.push({
                        label: `   ↳ ${stop.dist_to_next_km} km (~${stop.time_to_next_min || 0} min)`,
                        address: '',
                        count: '',
                        time: '',
                        isDest: false
                    });
                }
                pickupIdx++;
            }
        });
        return rows;
    };

    // ── Document generation (Backend integration) ───────────────────────────────
    const downloadBackendDocument = async (docType, formatType) => {
        try {
            setLoading(true);
            
            // Format the pure YYYY-MM-DD string into an Italian localized verbage
            let formattedDate = docDate;
            if (docDate) {
                const d = new Date(docDate + 'T12:00:00');
                formattedDate = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
            }

            // Apply visual shifts and advances to the routes before sending to backend
            const shiftedRoutes = results.routes.map(r => {
                const newRoute = JSON.parse(JSON.stringify(r));
                const pickupStops = newRoute.outbound.stops.filter(s => s.type === 'pickup');
                const numPickups = pickupStops.length;
                const totalShift = getTotalShift(newRoute.vehicle_id, numPickups);
                const advance = getRouteAdvance(newRoute.vehicle_id);
                
                let pickupIdx = 0;
                newRoute.outbound.stops.forEach(stop => {
                    if (stop.type === 'destination') {
                        if (stop.arrival_time) {
                            stop.arrival_time = shiftTime(stop.arrival_time, totalShift + advance);
                        }
                    } else if (stop.type === 'pickup') {
                        const cumShift = getCumulativeShift(newRoute.vehicle_id, pickupIdx) + advance;
                        if (stop.departure_time) {
                            stop.departure_time = shiftTime(stop.departure_time, cumShift);
                        }
                        pickupIdx++;
                    }
                });
                return newRoute;
            });

            const response = await axios.post(`${API_BASE_URL}/api/export_document`, {
                doc_type: docType,
                format: formatType,
                event_name: docEventName,
                date: formattedDate,
                destination: destination,
                start_time: startTime,
                end_time: fineManifestazione,
                exclude_autonomia: excludeAutonomia,
                routes: shiftedRoutes
            }, { responseType: 'blob' });

            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            const ext = formatType === 'pdf' ? 'pdf' : 'docx';
            const baseName = docType === 'piano_viaggi' ? 'Piano_Viaggi' : 'Richiesta_Servizio';
            link.setAttribute('download', `${baseName}_${docEventName || 'Evento'}.${ext}`);
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (err) {
            console.error("Download failed", err);
            alert("Errore durante la generazione del documento backend.");
        } finally {
            setLoading(false);
        }
    };

    // ── map ────────────────────────────────────────────────────────────────────
    let mapRoutes = [];
    if (results) mapRoutes = results.routes.map(r => ({ ...r, stops: r.outbound.stops, geometry: r.outbound.geometry }));

    let mapDestination = null;
    if (destCoords && destination) mapDestination = { lat: destCoords.lat, lon: destCoords.lon, address: destination };

    const [focusBounds, setFocusBounds] = useState(null);
    const [highlightedRouteId, setHighlightedRouteId] = useState(null);

    const handleFocusSegment = (stop, nextStop, routeVehicleId) => {
        if (!stop || !nextStop) return;
        setFocusBounds([[stop.lat, stop.lon], [nextStop.lat, nextStop.lon]]);
        setHighlightedRouteId(routeVehicleId);
    };

    const handleResetFocus = () => { setFocusBounds(null); setHighlightedRouteId(null); };

    if (showEditor) return (
        <div className="h-[calc(100vh-100px)]">
            <SchoolEditor schools={schools} onSave={handleDataSave} instituteColorMap={instituteColorMap} />
        </div>
    );

    return (
        <div className="flex flex-col gap-6">
            {/* Top Row: Config (left, full height) | Map (right) */}
            <div className="flex flex-col lg:flex-row gap-6 lg:items-stretch">
                {/* Configuration box */}
                <div className="w-full lg:w-[25%] min-w-0 flex flex-col">
                    <div className="bg-gray-50 p-5 rounded-xl border border-gray-200 flex flex-col flex-1">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="flex items-center gap-2 font-semibold text-gray-700">
                                <Settings className="w-5 h-5" /> Configurazione
                            </h3>
                            <button onClick={() => setShowEditor(true)} className="text-xs flex items-center gap-0.5 text-blue-600 hover:text-blue-800 font-medium">
                                <Edit className="w-3 h-3" /> <span>Modifica ({schools.length})</span>
                            </button>
                        </div>

                        <div className="flex flex-col gap-4 flex-1">
                            <div>
                                <label className="block text-sm font-medium text-gray-600 mb-1">Indirizzo Destinazione</label>
                                <AddressAutocomplete
                                    value={destination}
                                    onChange={setDestination}
                                    onSelect={(data) => { setDestination(data.address); setDestCoords({ lat: data.lat, lon: data.lon }); }}
                                />
                                {destination && (
                                    <p className="text-xs text-gray-400 mt-1 break-words leading-snug">{destination}</p>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="col-span-2">
                                    <label className="block text-sm font-medium text-gray-600 mb-1">Capienza Bus</label>
                                    <div className="relative">
                                        <Users className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
                                        <input type="number" className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 outline-none transition-all" value={capacity} onChange={e => setCapacity(e.target.value)} min="1" />
                                    </div>
                                </div>
                                <div className="col-span-2">
                                    <label className="block text-sm font-medium text-gray-600 mb-1">Modalità Orario</label>
                                    <div className="flex bg-gray-200 p-1 rounded-lg mb-2">
                                        <button onClick={() => setTimeMode('departure')} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${timeMode === 'departure' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>Partenza</button>
                                        <button onClick={() => setTimeMode('arrival')} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${timeMode === 'arrival' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>Arrivo</button>
                                    </div>
                                    <div className="relative">
                                        <Clock className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
                                        <input type="time" className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 outline-none transition-all" value={startTime} onChange={e => setStartTime(e.target.value)} />
                                    </div>
                                    <p className="text-xs text-gray-400 mt-1">{timeMode === 'departure' ? "Orario in cui i bus partono dalla prima scuola." : "Orario in cui TUTTI i bus devono essere a destinazione."}</p>
                                    {/* Solver selector */}
                                    <div className="mt-4">
                                        <label className="block text-sm font-medium text-gray-600 mb-1">Algoritmo</label>
                                        <div className="flex bg-gray-200 p-1 rounded-lg">
                                            <button onClick={() => setSolver('v2')} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${solver === 'v2' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>V2 Human Style</button>
                                            <button onClick={() => setSolver('v1')} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${solver === 'v1' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>V1 OR-Tools</button>
                                        </div>
                                    </div>

                                    {/* Return Time Section */}
                                    <div className="mt-4 border-t pt-4">
                                        <div className="flex items-center gap-2 mb-2">
                                            <input
                                                type="checkbox"
                                                id="calculateReturn"
                                                checked={calculateReturn}
                                                onChange={e => setCalculateReturn(e.target.checked)}
                                                className="w-4 h-4"
                                            />
                                            <label htmlFor="calculateReturn" className="text-sm font-medium text-gray-700">
                                                Calcola orario di rientro
                                            </label>
                                        </div>
                                        {calculateReturn && (
                                            <div className="flex items-center gap-2">
                                                <label className="text-sm text-gray-600 w-40">Fine manifestazione:</label>
                                                <input
                                                    type="time"
                                                    value={fineManifestazione}
                                                    onChange={e => setFineManifestazione(e.target.value)}
                                                    className="border rounded px-2 py-1 text-sm"
                                                />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <button onClick={handleOptimize} disabled={loading || !destination} className={`w-full py-3 rounded-lg font-medium text-white flex items-center justify-center gap-2 transition-colors ${loading || !destination ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 shadow-md'}`}>
                                {loading ? 'Calcolo in corso...' : <><Play className="w-5 h-5" /> Calcola Percorsi</>}
                            </button>
                            {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
                        </div>
                    </div>
                </div>

                {/* Map */}
                <div className="w-full lg:w-[75%]">
                    <div className="relative h-[500px] lg:h-full min-h-[400px]">
                        <Map ref={mapRef} schools={schools} routes={mapRoutes} overlaps={results?.overlaps || []} destination={mapDestination} focusBounds={focusBounds} highlightedRouteId={highlightedRouteId} onResetFocus={handleResetFocus} instituteColorMap={instituteColorMap} />
                    </div>
                </div>
            </div>

            {/* Results Riepilogo — full width, below config+map */}
            {results && (
                <div ref={resultsRef} className="bg-white rounded-xl border border-gray-200 shadow-sm animate-fade-in overflow-hidden">
                    {/* Header */}
                    <div className="px-4 py-3 bg-gradient-to-r from-gray-50 to-white border-b border-gray-100 flex items-center gap-2">
                        <div className="w-1 h-4 rounded-full bg-indigo-500"></div>
                        <h3 className="font-semibold text-sm text-gray-700">Riepilogo</h3>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:divide-x sm:divide-gray-100">
                        {/* Bus + Passengers */}
                        <div className="flex divide-x divide-gray-100 flex-1">
                            <div className="flex-1 p-4 flex flex-col items-center justify-center gap-0.5">
                                <Bus className="w-5 h-5 text-blue-400 mb-1" />
                                <div className="text-2xl font-extrabold text-blue-600 leading-none">{results.stats.total_buses}</div>
                                <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">Bus attivi</div>
                            </div>
                            <div className="flex-1 p-4 flex flex-col items-center justify-center gap-0.5">
                                <Users className="w-5 h-5 text-purple-400 mb-1" />
                                <div className="text-2xl font-extrabold text-purple-600 leading-none">{results.stats.total_passengers}</div>
                                <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">Passeggeri</div>
                            </div>
                        </div>

                        {/* Distances */}
                        <div className="flex-1 border-t sm:border-t-0 px-5 py-4 flex flex-col justify-center gap-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-1.5 text-xs text-gray-500">
                                    <Navigation className="w-3.5 h-3.5 text-green-500" />
                                    <span>Distanza andata</span>
                                </div>
                                <span className="text-sm font-bold text-green-700">{(results.stats.total_distance / 1000).toFixed(1)} km</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-1.5 text-xs text-gray-500">
                                    <ArrowRight className="w-3.5 h-3.5 text-green-400" />
                                    <span>Andata + ritorno</span>
                                </div>
                                <span className="text-sm font-bold text-green-600">{(results.stats.total_distance / 1000 * 2).toFixed(1)} km</span>
                            </div>
                        </div>

                        {/* Arrival window */}
                        {results.stats.arrival_window && (
                            <div className="flex-1 border-t sm:border-t-0 bg-orange-50 px-5 py-4 flex flex-col justify-center">
                                <div className="flex items-center gap-1.5 mb-1.5">
                                    <Clock className="w-3.5 h-3.5 text-orange-500" />
                                    <span className="text-[10px] font-semibold text-orange-600 uppercase tracking-wide">Arrivo a destinazione</span>
                                </div>
                                {results.stats.arrival_window.spread_minutes === 0
                                    ? <div className="text-base font-bold text-orange-700">Tutti alle {results.stats.arrival_window.earliest}</div>
                                    : <div className="flex items-baseline gap-1 flex-wrap">
                                        <span className="text-base font-bold text-orange-700">{results.stats.arrival_window.earliest}</span>
                                        <span className="text-xs text-orange-400">→</span>
                                        <span className="text-base font-bold text-orange-700">{results.stats.arrival_window.latest}</span>
                                        <span className="text-[11px] text-orange-400 ml-1">({results.stats.arrival_window.spread_minutes} min di scarto)</span>
                                    </div>
                                }
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Route Details */}
            {results && (
                <div className="w-full mt-6">
                    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                        {/* Section header */}
                        <div className="px-5 py-4 border-b border-gray-100 flex justify-between items-center bg-gradient-to-r from-gray-50 to-white">
                            <div className="flex items-center gap-2.5">
                                <div className="w-1 h-5 rounded-full bg-blue-500"></div>
                                <Bus className="w-4 h-4 text-blue-500" />
                                <span className="text-sm font-semibold text-gray-700">Dettagli Percorsi</span>
                            </div>
                            <span className="text-xs font-medium text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full">{results.routes.length} bus attivi</span>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
                            {results.routes.map((route, idx) => {
                                const routeColor = ROUTE_COLORS[idx % ROUTE_COLORS.length];
                                const activeData = route.outbound;
                                const distKm = activeData.distance / 1000;
                                const pickupStops = activeData.stops.filter(s => s.type === 'pickup');
                                const destStop = activeData.stops.find(s => s.type === 'destination');
                                const totalShiftForBus = getTotalShift(route.vehicle_id, pickupStops.length);
                                const advance = getRouteAdvance(route.vehicle_id);
                                let pickupDisplayIdx = 0;

                                // Compute total trip duration as sum of segment drive times
                                // (matches the sum of ~Xmin pills shown between stops)
                                const tripDurationMin = (() => {
                                    const driveMin = pickupStops.reduce((sum, s) => sum + (s.time_to_next_min || 0), 0);
                                    const total = driveMin + totalShiftForBus;
                                    return total > 0 ? total : null;
                                })();

                                return (
                                    <div
                                        key={idx}
                                        className="bg-white rounded-xl border border-gray-150 shadow-sm overflow-hidden hover:shadow-md transition-all"
                                        style={{ borderLeft: `4px solid ${routeColor}` }}
                                    >
                                        {/* Bus header */}
                                        <div className="px-4 pt-4 pb-3" style={{ background: `linear-gradient(135deg, ${routeColor}0d 0%, transparent 60%)` }}>
                                            {/* Row 1: bus name + load */}
                                            <div className="flex items-center justify-between mb-2">
                                                <div className="flex items-center gap-2">
                                                    <Bus className="w-4 h-4" style={{ color: routeColor }} />
                                                    <span className="font-bold text-base" style={{ color: routeColor }}>Bus #{route.vehicle_id + 1}</span>
                                                </div>
                                                <div className="flex items-center gap-1.5">
                                                    <span className="flex items-center gap-1 text-xs font-semibold bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full border border-blue-100">
                                                        <Users className="w-3 h-3" />{route.total_load}/{capacity} pax
                                                    </span>
                                                </div>
                                            </div>
                                            {/* Row 2: stats + controls */}
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="flex items-center gap-1 text-[11px] text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                                                    <MapPin className="w-3 h-3" />{distKm.toFixed(1)} km
                                                </span>
                                                {tripDurationMin != null && (
                                                    <span className="flex items-center gap-1 text-[11px] text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full border border-purple-100">
                                                        <Clock className="w-3 h-3" />{tripDurationMin}′ totali
                                                    </span>
                                                )}
                                                {totalShiftForBus > 0 && (
                                                    <div className="flex items-center gap-1">
                                                        <span className="text-[11px] text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full border border-orange-100 font-medium">+{totalShiftForBus}′ ritardo</span>
                                                        <button onClick={() => resetRouteShift(route.vehicle_id)} title="Reset ritardi" className="p-0.5 rounded hover:bg-gray-100">
                                                            <RotateCcw className="w-3 h-3 text-gray-400 hover:text-gray-600" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Stops */}
                                        <div className="px-4 pb-4 pt-2">
                                            <div className="relative ml-2.5 pl-4 border-l-2 border-gray-200 space-y-0">
                                                {activeData.stops.map((stop, sIdx) => {
                                                    if (sIdx === 0 && stop.type === 'destination') return null;

                                                    if (stop.type === 'destination') {
                                                        return (
                                                            <div key={sIdx} className="relative -ml-4 pl-4 pt-3">
                                                                {/* Dot on the timeline */}
                                                                <div className="absolute left-0 top-3 -translate-x-[9px] w-4 h-4 rounded-full bg-green-500 border-2 border-white shadow-sm flex items-center justify-center">
                                                                    <Navigation className="w-2 h-2 text-white" />
                                                                </div>
                                                                <div className="ml-3 flex items-center justify-between bg-green-50 rounded-lg px-3 py-2 border border-green-100">
                                                                    <div className="flex items-center gap-2">
                                                                        <span className="text-sm font-semibold text-green-800">Arrivo a destinazione</span>
                                                                    </div>
                                                                    <span className="text-sm font-bold text-green-700 font-mono tabular-nums">
                                                                        {shiftTime(stop.arrival_time, totalShiftForBus + advance)}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        );
                                                    }

                                                    // Pickup stop
                                                    const curIdx = pickupDisplayIdx;
                                                    pickupDisplayIdx++;
                                                    const cumShift = getCumulativeShift(route.vehicle_id, curIdx) + advance;
                                                    const displayedTime = shiftTime(stop.departure_time, cumShift);
                                                    const prevStop = curIdx > 0 ? pickupStops[curIdx - 1] : null;
                                                    const prevDist = prevStop?.dist_to_next_km;
                                                    const bufIncrement = (prevDist == null || prevDist < 10) ? 5 : 10;
                                                    const stopShift = (routeShifts[route.vehicle_id] || [])[curIdx] || 0;

                                                    return (
                                                        <div key={sIdx} className="relative -ml-4 pl-4 pt-3">
                                                            {/* Dot on timeline */}
                                                            <div
                                                                className="absolute left-0 top-3 -translate-x-[9px] w-4 h-4 rounded-full border-2 border-white shadow-sm flex items-center justify-center text-white text-[8px] font-bold"
                                                                style={{ background: routeColor }}
                                                            >
                                                                {curIdx + 1}
                                                            </div>

                                                            {/* Stop card */}
                                                            <div className="ml-3 mb-0.5">
                                                                <div className="flex items-start justify-between gap-2">
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className="font-semibold text-sm text-gray-800 leading-tight break-words">{stop.name}</div>
                                                                        {stop.address && (
                                                                            <div className="text-[11px] text-gray-400 leading-tight mt-0.5 break-words">{stop.address}</div>
                                                                        )}
                                                                        {(() => {
                                                                            const school = schools.find(s => s.name === stop.name || s.address === stop.address);
                                                                            if (school?.institute) {
                                                                                const col = instituteColorMap[school.institute] || '#3b82f6';
                                                                                return (
                                                                                    <div className="flex items-center gap-1 mt-0.5">
                                                                                        <Building2 className="w-3 h-3 flex-shrink-0" style={{ color: col }} />
                                                                                        <span className="text-[10px] font-medium" style={{ color: col }}>{school.institute}</span>
                                                                                    </div>
                                                                                );
                                                                            }
                                                                            return null;
                                                                        })()}
                                                                    </div>
                                                                    {/* Right side: time + pax + delay btn */}
                                                                    <div className="flex-shrink-0 flex flex-col items-end gap-1">
                                                                        <div className="flex items-center gap-1.5">
                                                                            <span className={`text-xs font-mono tabular-nums font-semibold ${
                                                                                cumShift > 0 ? 'text-orange-500' : 'text-gray-600'
                                                                            }`}>
                                                                                {displayedTime}
                                                                            </span>
                                                                            <span className="flex items-center gap-0.5 text-[11px] font-semibold text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded-full">
                                                                                <Users className="w-2.5 h-2.5 text-gray-400" />{stop.count}
                                                                            </span>
                                                                        </div>
                                                                        {stop.return_time && (
                                                                            <span className="text-[10px] text-gray-400 font-mono">
                                                                                ↩ {stop.return_time}
                                                                            </span>
                                                                        )}
                                                                        <div className="flex items-center gap-1">
                                                                            <button
                                                                                onClick={() => subStopShift(route.vehicle_id, curIdx)}
                                                                                title="-5 min a questa e alle successive fermate"
                                                                                className="flex items-center gap-0.5 text-[10px] text-blue-500 hover:text-blue-700 font-medium px-1.5 py-0.5 rounded-full border border-blue-200 hover:bg-blue-50 transition-colors"
                                                                            >
                                                                                −5′
                                                                            </button>
                                                                            <button
                                                                                onClick={() => addStopShift(route.vehicle_id, curIdx, prevDist)}
                                                                                title={`+${bufIncrement} min a questa e alle successive fermate`}
                                                                                className="flex items-center gap-0.5 text-[10px] text-orange-500 hover:text-orange-700 font-medium px-1.5 py-0.5 rounded-full border border-orange-200 hover:bg-orange-50 transition-colors"
                                                                            >
                                                                                <PlusCircle className="w-2.5 h-2.5" />+{bufIncrement}′
                                                                            </button>
                                                                            {stopShift !== 0 && (
                                                                                <button
                                                                                    onClick={() => resetStopShift(route.vehicle_id, curIdx)}
                                                                                    title="Azzera ritardo di questa fermata"
                                                                                    className="flex items-center gap-0.5 text-[10px] text-gray-400 hover:text-red-500 font-medium px-1.5 py-0.5 rounded-full border border-gray-200 hover:border-red-300 hover:bg-red-50 transition-colors"
                                                                                >
                                                                                    ×
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>

                                                                {/* Segment connector pill */}
                                                                {stop.dist_to_next_km != null && (
                                                                    <div className="mt-2 mb-1 flex items-center gap-1.5">
                                                                        <div className="flex-1 h-px bg-gray-200"></div>
                                                                        <div className="flex items-center gap-1 text-[10px] text-gray-500 font-mono bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5">
                                                                            <span>{stop.dist_to_next_km} km</span>
                                                                            <span className="text-gray-300">·</span>
                                                                            <span>~{stop.time_to_next_min || 0} min</span>
                                                                        </div>
                                                                        <ChevronDown className="w-2.5 h-2.5 text-gray-300" />
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="border-t border-gray-100 p-4 bg-gray-50 flex flex-col md:flex-row gap-4">
                            {/* Naming + Event Section */}
                            <div className="flex-1 space-y-3">
                                <div>
                                    <label className="block text-xs font-medium text-gray-700 mb-1">Nome evento</label>
                                    <input
                                        type="text"
                                        value={docEventName}
                                        onChange={e => setDocEventName(e.target.value)}
                                        placeholder="es. Torneo Provinciale"
                                        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 bg-white focus:ring-2 focus:ring-blue-300 outline-none text-gray-700 placeholder:text-gray-400"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-gray-400 mb-1 flex items-center gap-1.5">
                                        <Bookmark className="w-3.5 h-3.5" />
                                        Nome nello storico
                                    </label>
                                    <input
                                        type="text"
                                        value={tripName}
                                        readOnly
                                        placeholder={`${destination.split(',')[0]} · ${new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                                        className="w-full text-sm px-3 py-2 rounded-lg border border-gray-100 bg-gray-100 outline-none text-gray-400 placeholder:text-gray-300 cursor-default"
                                    />
                                </div>
                            </div>

                            {/* Export Section */}
                            <div className="flex-[1.5] bg-white rounded-xl border border-blue-100 p-4 shadow-sm relative overflow-hidden">
                                <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
                                <h4 className="text-sm font-semibold text-blue-800 mb-3 flex items-center gap-1.5">
                                    <FileText className="w-4 h-4" />
                                    Documentazione (Word)
                                </h4>

                                <div className="grid grid-cols-2 gap-3 mb-4">
                                    <div>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">Data evento</label>
                                        <input
                                            type="date"
                                            value={docDate}
                                            onChange={e => setDocDate(e.target.value)}
                                            className="w-full px-2 py-1.5 text-sm rounded border border-gray-200 outline-none focus:border-blue-400"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-gray-400 mb-1">Nome evento</label>
                                        <input
                                            type="text"
                                            value={docEventName}
                                            readOnly
                                            className="w-full px-2 py-1.5 text-sm rounded border border-gray-100 bg-gray-100 text-gray-400 cursor-default outline-none"
                                        />
                                    </div>
                                    <div className="col-span-2 pt-1 border-t border-gray-100 mt-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input 
                                                type="checkbox" 
                                                className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                                                checked={excludeAutonomia}
                                                onChange={e => setExcludeAutonomia(e.target.checked)}
                                            />
                                            <span className="text-sm font-medium text-gray-700">Nascondi scuole in autonomia</span>
                                        </label>
                                    </div>
                                </div>

                                <div className="flex gap-2">
                                    <button
                                        onClick={() => downloadBackendDocument('piano_viaggi', 'docx')}
                                        className="flex-1 py-2 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 flex items-center justify-center gap-2 shadow-sm transition-colors text-sm"
                                    >
                                        <Download className="w-4 h-4" /> Piano Viaggi
                                    </button>
                                    <button
                                        onClick={() => downloadBackendDocument('richiesta_servizio', 'docx')}
                                        className="flex-1 py-2 rounded-lg font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 flex items-center justify-center gap-2 transition-colors text-sm"
                                    >
                                        <FileText className="w-4 h-4" /> Richiesta Preventivo
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Dashboard;
