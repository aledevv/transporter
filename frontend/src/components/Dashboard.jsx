import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { serverTimestamp } from 'firebase/firestore';
import { Settings, Play, Users, Bus, Navigation, Edit, Download, Clock, Building2, PlusCircle, RotateCcw, FileText, X, CalendarDays, Bookmark, ChevronDown, MapPin, ArrowRight } from 'lucide-react';
import { Document, Paragraph, TextRun, Table, TableRow, TableCell, Packer, WidthType, AlignmentType, HeadingLevel, BorderStyle } from 'docx';
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

// ─── Download Dialog ──────────────────────────────────────────────────────────
const DownloadDialog = ({ type, docDate, docEventName, onDateChange, onEventNameChange, onConfirm, onCancel }) => (
    <div className="fixed inset-0 bg-black/40 z-[9999] flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm animate-fade-in">
            <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-800 text-base flex items-center gap-2">
                    {type === 'pdf' ? <Download className="w-4 h-4 text-green-600" /> : <FileText className="w-4 h-4 text-blue-600" />}
                    Dettagli documento
                </h3>
                <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3">
                <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Data evento</label>
                    <div className="relative">
                        <CalendarDays className="w-4 h-4 absolute left-3 top-2.5 text-gray-400" />
                        <input
                            type="date"
                            value={docDate}
                            onChange={e => onDateChange(e.target.value)}
                            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-400 outline-none"
                        />
                    </div>
                </div>
                <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Nome evento</label>
                    <input
                        type="text"
                        placeholder="es. Gita scolastica 2024"
                        value={docEventName}
                        onChange={e => onEventNameChange(e.target.value)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-400 outline-none"
                        onKeyDown={e => e.key === 'Enter' && onConfirm()}
                    />
                </div>
            </div>
            <div className="flex gap-2 mt-5">
                <button
                    onClick={onCancel}
                    className="flex-1 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                    Annulla
                </button>
                <button
                    onClick={onConfirm}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium text-white transition-colors flex items-center justify-center gap-1.5 ${type === 'pdf' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                >
                    {type === 'pdf' ? <Download className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                    Scarica {type === 'pdf' ? 'PDF' : 'Word'}
                </button>
            </div>
        </div>
    </div>
);

// ─── Dashboard ────────────────────────────────────────────────────────────────
const Dashboard = ({ schools, setSchools, startInEditMode = false, instituteColorMap = {}, mapsKey = '', currentTripId, onTripSaved, onTripRenamed, onTripUpdated, tripToRestore }) => {
    const [destination, setDestination] = useState('');
    const [destCoords, setDestCoords] = useState(null);
    const [capacity, setCapacity] = useState(56);
    const [startTime, setStartTime] = useState('08:00');
    const [timeMode, setTimeMode] = useState('arrival');
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

    // Download dialog (persisted fields)
    const [downloadDialog, setDownloadDialog] = useState(null); // null | 'pdf' | 'docx'
    const [docDate, setDocDate] = useState('');
    const [docEventName, setDocEventName] = useState('');

    const resultsRef = useRef(null);

    useEffect(() => {
        if (results && resultsRef.current) {
            setTimeout(() => resultsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
        }
    }, [results]);

    useEffect(() => { setResults(null); setRouteShifts({}); setRouteAdvances({}); setTripName(''); }, [schools]);
    useEffect(() => { setRouteShifts({}); setRouteAdvances({}); }, [results]);

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
        setTimeout(() => { isRestoringRef.current = false; }, 1500);
    }, [tripToRestore]);

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
            // Auto-update label only if user hasn't typed a custom name yet
            if (!tripName) {
                const dateStr = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
                fields.label = `${destination.split(',')[0]} - ${dateStr}`;
            }
            onTripUpdated?.(currentTripId, fields);
        }, 1000);
        return () => clearTimeout(t);
    }, [destination, destCoords, currentTripId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-save capacity / startTime / timeMode to Firestore (debounced)
    useEffect(() => {
        if (!currentTripId || isRestoringRef.current) return;
        const t = setTimeout(() => {
            if (isRestoringRef.current) return;
            onTripUpdated?.(currentTripId, { capacity: parseInt(capacity), startTime, timeMode });
        }, 1000);
        return () => clearTimeout(t);
    }, [capacity, startTime, timeMode, currentTripId]); // eslint-disable-line react-hooks/exhaustive-deps

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

    const resetRouteShift = (vehicleId) =>
        setRouteShifts(prev => { const n = { ...prev }; delete n[vehicleId]; return n; });

    // Advance (negative shift) for whole bus departure
    const getRouteAdvance = (vehicleId) => routeAdvances[vehicleId] || 0;

    const addRouteAdvance = (vehicleId) =>
        setRouteAdvances(prev => ({ ...prev, [vehicleId]: (prev[vehicleId] || 0) - 5 }));

    const resetRouteAdvance = (vehicleId) =>
        setRouteAdvances(prev => { const n = { ...prev }; delete n[vehicleId]; return n; });

    // ── optimize ───────────────────────────────────────────────────────────────
    const handleOptimize = async () => {
        if (!destination) { setError("Inserisci un indirizzo di destinazione."); return; }
        setError(''); setLoading(true); setResults(null);
        try {
            const response = await axios.post(`${API_BASE_URL}/api/optimize`, {
                schools, destination, capacity: parseInt(capacity),
                dest_lat: destCoords?.lat, dest_lon: destCoords?.lon,
                start_time: startTime, time_mode: timeMode
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

    // ── PDF generation ─────────────────────────────────────────────────────────
    const generatePdf = () => {
        const doc = new jsPDF();
        const totalKm = (results.stats.total_distance / 1000).toFixed(1);
        const totalKmRT = (results.stats.total_distance / 1000 * 2).toFixed(1);

        doc.setFontSize(20);
        doc.text("Pianificazione Viaggio", 14, 22);
        doc.setFontSize(11);
        if (docDate) doc.text(`Data: ${docDate}`, 14, 30);
        if (docEventName) doc.text(`Evento: ${docEventName}`, 14, docDate ? 36 : 30);
        const headerEnd = docDate && docEventName ? 42 : (docDate || docEventName ? 36 : 30);
        doc.text(`Destinazione: ${destination}`, 14, headerEnd);

        autoTable(doc, {
            startY: headerEnd + 6,
            head: [['Metrica', 'Valore']],
            body: [
                ['Bus Totali', results.stats.total_buses],
                ['Passeggeri Totali', results.stats.total_passengers],
                ['Distanza Totale (solo andata)', `${totalKm} km`],
                ['Distanza Totale (andata e ritorno)', `${totalKmRT} km`]
            ],
            theme: 'striped',
            headStyles: { fillColor: [41, 128, 185] }
        });

        let finalY = doc.lastAutoTable.finalY + 10;

        results.routes.forEach((route) => {
            const routeDistKm = (route.outbound.distance / 1000).toFixed(1);
            if (finalY > 250) { doc.addPage(); finalY = 20; }
            doc.setFontSize(11);
            doc.text(`Bus #${route.vehicle_id + 1} — ${route.total_load}/${capacity} pax — ${routeDistKm} km`, 14, finalY);

            const rows = buildStopRows(route).map(r => [
                r.label, r.address, r.count, r.time
            ]);

            autoTable(doc, {
                startY: finalY + 5,
                head: [['Fermata', 'Indirizzo', 'Pax', 'Orario']],
                body: rows,
                theme: 'grid',
                headStyles: { fillColor: [52, 152, 219] },
                columnStyles: { 1: { cellWidth: 70 } }
            });
            finalY = doc.lastAutoTable.finalY + 15;
        });

        doc.save('piano_trasporti.pdf');
    };

    // ── DOCX generation ────────────────────────────────────────────────────────
    const generateDocx = async () => {
        const totalKm = (results.stats.total_distance / 1000).toFixed(1);
        const totalKmRT = (results.stats.total_distance / 1000 * 2).toFixed(1);

        const noBorder = { top: { style: BorderStyle.NONE, size: 0 }, bottom: { style: BorderStyle.NONE, size: 0 }, left: { style: BorderStyle.NONE, size: 0 }, right: { style: BorderStyle.NONE, size: 0 } };

        const cell = (text, bold = false, shade = false) => new TableCell({
            borders: { top: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }, bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }, left: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' }, right: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' } },
            shading: shade ? { fill: 'EBF3FB' } : undefined,
            children: [new Paragraph({ children: [new TextRun({ text: String(text || ''), bold, size: 20 })] })],
        });

        const sections = [];

        // Header
        sections.push(new Paragraph({ text: 'Pianificazione Viaggio', heading: HeadingLevel.HEADING_1 }));
        if (docDate) sections.push(new Paragraph({ children: [new TextRun({ text: `Data: ${docDate}`, size: 22 })] }));
        if (docEventName) sections.push(new Paragraph({ children: [new TextRun({ text: `Evento: ${docEventName}`, size: 22 })] }));
        sections.push(new Paragraph({ children: [new TextRun({ text: `Destinazione: ${destination}`, size: 22 })] }));
        sections.push(new Paragraph({ children: [new TextRun({ text: `Bus totali: ${results.stats.total_buses} — Passeggeri: ${results.stats.total_passengers} — Distanza (andata): ${totalKm} km — Distanza (A/R): ${totalKmRT} km`, size: 22 })] }));
        sections.push(new Paragraph({ text: '' }));

        // Routes
        results.routes.forEach((route) => {
            const routeDistKm = (route.outbound.distance / 1000).toFixed(1);
            sections.push(new Paragraph({
                children: [new TextRun({ text: `Bus #${route.vehicle_id + 1} — ${route.total_load}/${capacity} pax — ${routeDistKm} km`, bold: true, size: 24 })]
            }));

            const headerRow = new TableRow({
                children: [cell('Fermata', true, true), cell('Indirizzo', true, true), cell('Pax', true, true), cell('Orario', true, true)]
            });

            const dataRows = buildStopRows(route).map(r =>
                new TableRow({ children: [cell(r.label), cell(r.address), cell(r.count), cell(r.time)] })
            );

            sections.push(new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: [headerRow, ...dataRows]
            }));
            sections.push(new Paragraph({ text: '' }));
        });

        const doc = new Document({ sections: [{ children: sections }] });
        const blob = await Packer.toBlob(doc);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'piano_trasporti.docx'; a.click();
        URL.revokeObjectURL(url);
    };

    const handleOpenDownload = (type) => setDownloadDialog(type);

    const handleConfirmDownload = async () => {
        if (downloadDialog === 'pdf') generatePdf();
        else await generateDocx();
        setDownloadDialog(null);
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
            {/* Download Dialog */}
            {downloadDialog && (
                <DownloadDialog
                    type={downloadDialog}
                    docDate={docDate}
                    docEventName={docEventName}
                    onDateChange={setDocDate}
                    onEventNameChange={setDocEventName}
                    onConfirm={handleConfirmDownload}
                    onCancel={() => setDownloadDialog(null)}
                />
            )}

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
                        <Map schools={schools} routes={mapRoutes} overlaps={results?.overlaps || []} destination={mapDestination} focusBounds={focusBounds} highlightedRouteId={highlightedRouteId} onResetFocus={handleResetFocus} instituteColorMap={instituteColorMap} />
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
                                                {/* Advance departure */}
                                                <div className="ml-auto flex items-center gap-1">
                                                    <button
                                                        onClick={() => addRouteAdvance(route.vehicle_id)}
                                                        title="Anticipa partenza del bus di 5 min"
                                                        className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 font-medium px-2 py-0.5 rounded-full border border-blue-200 hover:bg-blue-50 transition-colors"
                                                    >
                                                        <Clock className="w-3 h-3" />−5′
                                                    </button>
                                                    {advance < 0 && (
                                                        <div className="flex items-center gap-1">
                                                            <span className="text-[11px] text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full font-medium border border-blue-100">{advance}′</span>
                                                            <button onClick={() => resetRouteAdvance(route.vehicle_id)} title="Reset anticipo" className="p-0.5 rounded hover:bg-gray-100">
                                                                <RotateCcw className="w-3 h-3 text-blue-300 hover:text-blue-500" />
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
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
                                                                        <button
                                                                            onClick={() => addStopShift(route.vehicle_id, curIdx, prevDist)}
                                                                            title={`+${bufIncrement} min a questa e alle successive fermate`}
                                                                            className="flex items-center gap-0.5 text-[10px] text-orange-500 hover:text-orange-700 font-medium px-1.5 py-0.5 rounded-full border border-orange-200 hover:bg-orange-50 transition-colors"
                                                                        >
                                                                            <PlusCircle className="w-2.5 h-2.5" />+{bufIncrement}′
                                                                        </button>
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

                        {/* Trip name + Export */}
                        <div className="border-t border-gray-100 p-4 bg-gray-50 space-y-3">
                        <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1.5">
                                <Bookmark className="w-3.5 h-3.5 text-blue-400" />
                                Nome viaggio (salvato nello storico)
                            </label>
                            <input
                                type="text"
                                value={tripName}
                                onChange={e => setTripName(e.target.value)}
                                placeholder={`${destination.split(',')[0]} · ${new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                                className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-200 bg-white focus:ring-2 focus:ring-blue-300 outline-none text-gray-700 placeholder:text-gray-400"
                            />
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={() => handleOpenDownload('pdf')}
                                className="flex-1 py-3 rounded-lg font-medium text-white bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 flex items-center justify-center gap-2 shadow-md transition-all"
                            >
                                <Download className="w-5 h-5" /> Esporta PDF
                            </button>
                            <button
                                onClick={() => handleOpenDownload('docx')}
                                className="flex-1 py-3 rounded-lg font-medium text-white bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 flex items-center justify-center gap-2 shadow-md transition-all"
                            >
                                <FileText className="w-5 h-5" /> Esporta Word
                            </button>
                        </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Dashboard;
