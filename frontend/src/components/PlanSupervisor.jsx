import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { ArrowUp, ArrowDown, Users, Bus, PlusCircle, Save, X, Navigation, RefreshCw, Clock, RotateCcw, ChevronDown } from 'lucide-react';
import API_BASE_URL from '../config';

const ROUTE_COLORS = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231',
    '#911eb4', '#42d4f4', '#f032e6', '#bfef45',
    '#469990', '#9a6324', '#800000', '#aaffc3',
    '#808000', '#000075', '#a9a9a9', '#ffd700',
    '#00ced1', '#ff1493', '#ff6347', '#4169e1',
    '#2e8b57', '#daa520', '#6a0dad', '#ff7f50',
    '#40e0d0', '#b22222', '#228b22', '#c71585',
    '#1e90ff', '#8b008b',
];

const parseTimeToMinutes = (timeStr) => {
    if (!timeStr) return null;
    const clean = timeStr.replace(/\s*\(\+\d+[gGdD]\)/i, '').trim();
    const parts = clean.split(':');
    if (parts.length !== 2) return null;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
};

const formatDuration = (minutes) => {
    if (minutes == null || minutes < 0) return '--';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
    return `${m}m`;
};

const shiftTime = (timeStr, deltaMin) => {
    if (!timeStr || !deltaMin) return timeStr;
    const clean = timeStr.split(' ')[0];
    const [h, m] = clean.split(':').map(Number);
    const total = h * 60 + m + deltaMin;
    const hh = Math.floor(Math.max(0, total) / 60) % 24;
    const mm = Math.max(0, total) % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

export default function PlanSupervisor({
    initialResults,
    capacity,
    destination,
    destCoords,
    startTime,
    timeMode,
    calculateReturn,
    fineManifestazione,
    instituteColorMap,
    onSave,
    onCancel,
    onPreviewUpdate,
    schools
}) {
    const [editedRoutes, setEditedRoutes] = useState([]);
    const [stats, setStats] = useState(initialResults.stats);
    const [isEvaluating, setIsEvaluating] = useState(false);
    const [error, setError] = useState('');
    const [openDropdownKey, setOpenDropdownKey] = useState(null);
    const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 });
    const dropdownElRef = useRef(null);

    // Close dropdown on outside click or scroll outside the dropdown itself
    useEffect(() => {
        if (openDropdownKey === null) return;
        const close = () => setOpenDropdownKey(null);
        const handleScroll = (e) => {
            if (dropdownElRef.current && dropdownElRef.current.contains(e.target)) return;
            setOpenDropdownKey(null);
        };
        document.addEventListener('mousedown', close);
        window.addEventListener('scroll', handleScroll, true);
        return () => {
            document.removeEventListener('mousedown', close);
            window.removeEventListener('scroll', handleScroll, true);
        };
    }, [openDropdownKey]);

    // Per-stop time buffers: { [vehicle_id]: number[] } — same as Dashboard routeShifts
    const [routeShifts, setRouteShifts] = useState({});

    useEffect(() => {
        if (initialResults && initialResults.routes) {
            setEditedRoutes(JSON.parse(JSON.stringify(initialResults.routes)));
        }
    }, [initialResults]);

    // ── shift helpers (mirrors Dashboard) ────────────────────────────────────
    const getCumulativeShift = (vehicleId, upToIdx) => {
        const shifts = routeShifts[vehicleId] || [];
        let total = 0;
        for (let i = 0; i <= upToIdx; i++) total += (shifts[i] || 0);
        return total;
    };

    const getTotalShift = (vehicleId, numPickups) =>
        getCumulativeShift(vehicleId, numPickups - 1);

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

    const resetStopShift = (vehicleId, displayIdx) => {
        setRouteShifts(prev => {
            const cur = [...(prev[vehicleId] || [])];
            cur[displayIdx] = 0;
            return { ...prev, [vehicleId]: cur };
        });
    };

    const resetRouteShifts = (vehicleId) =>
        setRouteShifts(prev => { const n = { ...prev }; delete n[vehicleId]; return n; });

    // ── evaluate ─────────────────────────────────────────────────────────────
    const evaluationNonce = useRef(0);
    const evaluationTimeout = useRef(null);

    const evaluatePlan = (routesToEval) => {
        setIsEvaluating(true);
        setError('');

        if (evaluationTimeout.current) clearTimeout(evaluationTimeout.current);

        evaluationTimeout.current = setTimeout(async () => {
            const currentNonce = ++evaluationNonce.current;
            try {
                const response = await axios.post(`${API_BASE_URL}/api/evaluate_plan`, {
                    routes: routesToEval,
                    destination: destination,
                    dest_lat: destCoords?.lat,
                    dest_lon: destCoords?.lon,
                    start_time: startTime,
                    time_mode: timeMode,
                    capacity: capacity,
                    calculate_return: calculateReturn,
                    fine_manifestazione: fineManifestazione
                });

                if (evaluationNonce.current !== currentNonce) return;

                setEditedRoutes(response.data.routes);
                setStats(response.data.stats);
                // Fresh times from backend — reset all visual shifts
                setRouteShifts({});
                if (onPreviewUpdate) {
                    onPreviewUpdate({
                        routes: response.data.routes,
                        stats: response.data.stats,
                        overlaps: response.data.overlaps
                    });
                }
            } catch (err) {
                if (evaluationNonce.current !== currentNonce) return;
                console.error(err);
                setError("Errore durante l'aggiornamento del piano. Riprova.");
            } finally {
                if (evaluationNonce.current === currentNonce) {
                    setIsEvaluating(false);
                }
            }
        }, 500);
    };

    // ── stop move handlers ────────────────────────────────────────────────────
    const handleMoveStopUp = (busIndex, stopIndex) => {
        if (stopIndex === 0) return;
        const newRoutes = [...editedRoutes];
        const stops = newRoutes[busIndex].outbound.stops;
        const temp = stops[stopIndex];
        stops[stopIndex] = stops[stopIndex - 1];
        stops[stopIndex - 1] = temp;
        setEditedRoutes(newRoutes);
        evaluatePlan(newRoutes);
    };

    const handleMoveStopDown = (busIndex, stopIndex) => {
        const newRoutes = [...editedRoutes];
        const stops = newRoutes[busIndex].outbound.stops;
        const maxDraggableIdx = stops.length - 1 - (stops[stops.length - 1].type === 'destination' ? 1 : 0);
        if (stopIndex >= maxDraggableIdx) return;
        const temp = stops[stopIndex];
        stops[stopIndex] = stops[stopIndex + 1];
        stops[stopIndex + 1] = temp;
        setEditedRoutes(newRoutes);
        evaluatePlan(newRoutes);
    };

    const handleMoveStopToBus = (sourceBusIndex, stopIndex, targetBusId) => {
        if (targetBusId === editedRoutes[sourceBusIndex].vehicle_id) return;

        let newRoutes = [...editedRoutes];
        const sourceStops = newRoutes[sourceBusIndex].outbound.stops;
        const stopToMove = sourceStops.splice(stopIndex, 1)[0];

        const targetBusIndex = newRoutes.findIndex(r => r.vehicle_id === targetBusId);
        if (targetBusIndex !== -1) {
            const targetStops = newRoutes[targetBusIndex].outbound.stops;
            let insertPos = targetStops.length;
            if (targetStops.length > 0 && targetStops[targetStops.length - 1].type === 'destination') {
                insertPos = targetStops.length - 1;
            }
            targetStops.splice(insertPos, 0, stopToMove);
        }

        const pickupsLeft = sourceStops.filter(s => s.type === 'pickup').length;
        if (pickupsLeft === 0) {
            newRoutes.splice(sourceBusIndex, 1);
        }

        setOpenDropdownKey(null);
        setEditedRoutes(newRoutes);
        evaluatePlan(newRoutes);
    };

    const handleAddBus = () => {
        const maxVehicleId = editedRoutes.reduce((max, r) => Math.max(max, r.vehicle_id), -1);
        const newBus = {
            vehicle_id: maxVehicleId + 1,
            total_load: 0,
            outbound: {
                distance: 0,
                geometry: null,
                stops: [{
                    type: 'destination',
                    name: destination,
                    lat: destCoords?.lat,
                    lon: destCoords?.lon,
                    count: 0
                }]
            }
        };
        setEditedRoutes([...editedRoutes, newBus]);
    };

    // Apply current visual shifts to routes before saving
    const applyShiftsToRoutes = (routes) => {
        return routes.map(route => {
            const newRoute = JSON.parse(JSON.stringify(route));
            const pickups = newRoute.outbound.stops.filter(s => s.type === 'pickup');
            const shifts = routeShifts[route.vehicle_id] || [];
            const totalShift = shifts.reduce((s, v) => s + (v || 0), 0);
            let pickupIdx = 0;
            newRoute.outbound.stops = newRoute.outbound.stops.map(stop => {
                if (stop.type === 'destination') {
                    if (stop.arrival_time && totalShift) {
                        stop.arrival_time = shiftTime(stop.arrival_time, totalShift) || stop.arrival_time;
                    }
                } else {
                    const cumShift = shifts.slice(0, pickupIdx + 1).reduce((s, v) => s + (v || 0), 0);
                    if (stop.departure_time && cumShift) {
                        stop.departure_time = shiftTime(stop.departure_time, cumShift) || stop.departure_time;
                    }
                    pickupIdx++;
                }
                return stop;
            });
            return newRoute;
        });
    };

    const handleSave = () => {
        const finalRoutes = editedRoutes.filter(r => r.outbound.stops.some(s => s.type === 'pickup'));
        const shiftedRoutes = applyShiftsToRoutes(finalRoutes);
        onSave({
            routes: shiftedRoutes,
            stats: stats,
            overlaps: initialResults.overlaps || []
        });
    };

    // ── summary stats (shift-aware) ───────────────────────────────────────────
    const summaryStats = useMemo(() => {
        let earliestMin = null;
        let latestArrivalMin = null;

        for (const route of editedRoutes) {
            const stops = route.outbound?.stops || [];
            const shifts = routeShifts[route.vehicle_id] || [];
            const totalShift = shifts.reduce((s, v) => s + (v || 0), 0);
            let pickupIdx = 0;

            for (const stop of stops) {
                if (stop.type === 'pickup' && stop.departure_time) {
                    const cumShift = shifts.slice(0, pickupIdx + 1).reduce((s, v) => s + (v || 0), 0);
                    const m = parseTimeToMinutes(shiftTime(stop.departure_time, cumShift) || stop.departure_time);
                    if (m !== null && (earliestMin === null || m < earliestMin)) earliestMin = m;
                    pickupIdx++;
                }
                if (stop.type === 'destination' && stop.arrival_time) {
                    const m = parseTimeToMinutes(shiftTime(stop.arrival_time, totalShift) || stop.arrival_time);
                    if (m !== null && (latestArrivalMin === null || m > latestArrivalMin)) latestArrivalMin = m;
                }
            }
        }

        const earliestDeparture = earliestMin !== null
            ? `${Math.floor(earliestMin / 60).toString().padStart(2, '0')}:${(earliestMin % 60).toString().padStart(2, '0')}`
            : null;
        const duration = (earliestMin !== null && latestArrivalMin !== null)
            ? formatDuration(latestArrivalMin - earliestMin)
            : null;
        return { earliestDeparture, duration };
    }, [editedRoutes, routeShifts]);

    const computeBaseSummary = (routes) => {
        let earliestMin = null;
        let latestArrivalMin = null;
        for (const route of routes) {
            for (const stop of (route.outbound?.stops || [])) {
                if (stop.type === 'pickup' && stop.departure_time) {
                    const m = parseTimeToMinutes(stop.departure_time);
                    if (m !== null && (earliestMin === null || m < earliestMin)) earliestMin = m;
                }
                if (stop.type === 'destination' && stop.arrival_time) {
                    const m = parseTimeToMinutes(stop.arrival_time);
                    if (m !== null && (latestArrivalMin === null || m > latestArrivalMin)) latestArrivalMin = m;
                }
            }
        }
        const earliestDeparture = earliestMin !== null
            ? `${Math.floor(earliestMin / 60).toString().padStart(2, '0')}:${(earliestMin % 60).toString().padStart(2, '0')}`
            : null;
        const duration = (earliestMin !== null && latestArrivalMin !== null)
            ? formatDuration(latestArrivalMin - earliestMin) : null;
        return { earliestDeparture, duration };
    };

    const originalSummaryStats = useMemo(
        () => computeBaseSummary(initialResults.routes || []),
        [initialResults.routes]
    );

    const showReturnTimes = calculateReturn && fineManifestazione;

    const actionButtons = (
        <div className="flex items-center gap-2">
            <button
                onClick={onCancel}
                disabled={isEvaluating}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
            >
                <X className="w-4 h-4" /> Annulla
            </button>
            <button
                onClick={handleSave}
                disabled={isEvaluating}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-green-600 hover:bg-green-700 rounded-lg shadow-sm transition-colors disabled:opacity-50"
            >
                {isEvaluating
                    ? <><RefreshCw className="w-4 h-4 animate-spin" /> Ricalcolo...</>
                    : <><Save className="w-4 h-4" /> Salva e Applica</>
                }
            </button>
        </div>
    );

    return (
        <div className="bg-gray-50 p-4 lg:p-6 rounded-xl border border-blue-200 shadow-md flex flex-col gap-6 animate-fade-in">
            {/* Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-4 rounded-lg shadow-sm border border-gray-100">
                <div>
                    <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                        <RefreshCw className="w-5 h-5 text-blue-600" /> Modifica Manuale Piano
                    </h2>
                    <p className="text-sm text-gray-500 mt-1">Sposta le fermate o riordinale. I tempi e i chilometri si aggiorneranno automaticamente.</p>
                </div>
                {actionButtons}
            </div>

            {error && (
                <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
                    {error}
                </div>
            )}

            {/* Bus grid */}
            <div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {editedRoutes.map((route, busIndex) => {
                        const routeColor = ROUTE_COLORS[route.vehicle_id % ROUTE_COLORS.length] || ROUTE_COLORS[0];
                        const stops = route.outbound.stops;
                        const pickupStops = stops.filter(s => s.type === 'pickup');
                        const destStop = stops.find(s => s.type === 'destination');
                        const totalLoad = pickupStops.reduce((sum, s) => sum + (s.count || 0), 0);
                        const isOverCapacity = totalLoad > capacity;
                        const shifts = routeShifts[route.vehicle_id] || [];
                        const totalShift = shifts.reduce((s, v) => s + (v || 0), 0);
                        const hasAnyShift = totalShift !== 0;

                        // Pre-assign pickup display indices
                        let pickupCounter = 0;
                        const stopsWithIdx = stops.map(stop => ({
                            ...stop,
                            pickupIdx: stop.type === 'pickup' ? pickupCounter++ : null
                        }));

                        return (
                            <div
                                key={`bus-${route.vehicle_id}-${busIndex}`}
                                className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-visible"
                                style={{ borderLeft: `4px solid ${routeColor}` }}
                            >
                                {/* Bus header */}
                                <div className="px-4 py-3 flex items-center justify-between bg-gray-50 border-b border-gray-100 rounded-tr-xl">
                                    <div className="flex items-center gap-2">
                                        <Bus className="w-4 h-4" style={{ color: routeColor }} />
                                        <span className="font-bold" style={{ color: routeColor }}>Bus #{route.vehicle_id + 1}</span>
                                        {hasAnyShift && (
                                            <div className="flex items-center gap-1">
                                                <span className="text-[11px] text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full border border-orange-100 font-medium">
                                                    +{totalShift}′ ritardo
                                                </span>
                                                <button
                                                    onClick={() => resetRouteShifts(route.vehicle_id)}
                                                    title="Azzera tutti i ritardi"
                                                    className="p-0.5 rounded hover:bg-gray-100"
                                                >
                                                    <RotateCcw className="w-3 h-3 text-gray-400 hover:text-gray-600" />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    <span className={`text-xs font-bold px-2 py-1 rounded-full border ${isOverCapacity ? 'bg-red-50 text-red-700 border-red-200' : 'bg-blue-50 text-blue-700 border-blue-100'}`}>
                                        {totalLoad}/{capacity} pax
                                    </span>
                                </div>

                                <div className="p-3">
                                    {pickupStops.length === 0 ? (
                                        <div className="text-center py-6 text-sm text-gray-400 italic">
                                            Bus vuoto. Verrà eliminato al salvataggio.
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-2">
                                            {stopsWithIdx.map((stop, stopIndex) => {
                                                if (stop.type === 'destination') return null;

                                                const isFirst = stopIndex === 0;
                                                const isLastPickup = stop.pickupIdx === pickupStops.length - 1;
                                                const dropKey = `${busIndex}-${stopIndex}`;
                                                const isDropdownOpen = openDropdownKey === dropKey;
                                                const curIdx = stop.pickupIdx;

                                                // Cumulative shift up to this stop
                                                const cumShift = shifts.slice(0, curIdx + 1).reduce((s, v) => s + (v || 0), 0);
                                                const stopShift = shifts[curIdx] || 0;
                                                const displayedTime = isEvaluating ? null : (shiftTime(stop.departure_time, cumShift) || stop.departure_time || '--:--');
                                                const prevStop = curIdx > 0 ? pickupStops[curIdx - 1] : null;
                                                const prevDist = prevStop?.dist_to_next_km;
                                                const bufIncrement = (prevDist == null || prevDist < 10) ? 5 : 10;

                                                return (
                                                    <div key={`stop-${stopIndex}`} className="flex items-stretch gap-2 bg-white border border-gray-100 rounded-lg p-2 hover:border-gray-300 transition-colors shadow-sm">
                                                        {/* Reorder controls */}
                                                        {pickupStops.length > 1 && (
                                                            <div className="flex flex-col justify-between items-center bg-gray-50 rounded p-1 border border-gray-100 w-8 flex-shrink-0">
                                                                <button
                                                                    onClick={() => handleMoveStopUp(busIndex, stopIndex)}
                                                                    disabled={isFirst}
                                                                    className={`p-0.5 rounded ${isFirst ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 hover:bg-gray-200 hover:text-gray-800'}`}
                                                                >
                                                                    <ArrowUp className="w-4 h-4" />
                                                                </button>
                                                                <button
                                                                    onClick={() => handleMoveStopDown(busIndex, stopIndex)}
                                                                    disabled={isLastPickup}
                                                                    className={`p-0.5 rounded ${isLastPickup ? 'text-gray-300 cursor-not-allowed' : 'text-gray-500 hover:bg-gray-200 hover:text-gray-800'}`}
                                                                >
                                                                    <ArrowDown className="w-4 h-4" />
                                                                </button>
                                                            </div>
                                                        )}

                                                        {/* Stop content */}
                                                        <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
                                                            <div className="flex justify-between items-start gap-2">
                                                                <div className="truncate font-semibold text-sm text-gray-800">{stop.name}</div>
                                                                <div className="flex-shrink-0 flex items-center gap-1 bg-gray-100 px-1.5 py-0.5 rounded text-xs font-semibold text-gray-600">
                                                                    <Users className="w-3 h-3 text-gray-400" /> {stop.count}
                                                                </div>
                                                            </div>
                                                            {stop.address && (
                                                                <div className="truncate text-[11px] text-gray-400">{stop.address}</div>
                                                            )}

                                                            {/* Times + shift buttons row */}
                                                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                                <div className="flex items-center gap-1">
                                                                    <Clock className="w-3 h-3 text-blue-400 flex-shrink-0" />
                                                                    <span className="text-[11px] text-gray-500">Partenza:</span>
                                                                    {isEvaluating ? (
                                                                        <div className="w-10 h-3.5 bg-gray-200 animate-pulse rounded" />
                                                                    ) : (
                                                                        <span className={`text-[11px] font-bold ${cumShift > 0 ? 'text-orange-500' : 'text-blue-700'}`}>
                                                                            {displayedTime}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                {showReturnTimes && stop.return_time && (
                                                                    <div className="flex items-center gap-1">
                                                                        <RotateCcw className="w-3 h-3 text-orange-400 flex-shrink-0" />
                                                                        <span className="text-[11px] text-gray-500">Ritorno:</span>
                                                                        {isEvaluating ? (
                                                                            <div className="w-10 h-3.5 bg-gray-200 animate-pulse rounded" />
                                                                        ) : (
                                                                            <span className="text-[11px] font-bold text-orange-600">{stop.return_time}</span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </div>

                                                            {/* ±5' shift buttons */}
                                                            <div className="flex items-center gap-1 mt-0.5">
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
                                                                    +{bufIncrement}′
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

                                                        {/* Move to bus — custom popover dropdown */}
                                                        {editedRoutes.length > 1 && (
                                                            <div className="relative flex items-center border-l border-gray-100 pl-2 flex-shrink-0">
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        if (isDropdownOpen) { setOpenDropdownKey(null); return; }
                                                                        const rect = e.currentTarget.getBoundingClientRect();
                                                                        setDropdownPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                                                                        setOpenDropdownKey(dropKey);
                                                                    }}
                                                                    className="flex items-center gap-1 text-xs font-medium bg-gray-100 hover:bg-blue-50 hover:text-blue-700 border border-gray-200 hover:border-blue-300 text-gray-600 rounded-lg px-2.5 py-1.5 transition-colors whitespace-nowrap"
                                                                >
                                                                    <Bus className="w-3 h-3" />
                                                                    Sposta
                                                                    <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${isDropdownOpen ? 'rotate-180' : ''}`} />
                                                                </button>
                                                                {isDropdownOpen && createPortal(
                                                                    <div
                                                                        ref={dropdownElRef}
                                                                        style={{ position: 'fixed', top: dropdownPos.top, right: dropdownPos.right, zIndex: 9999, maxHeight: '60vh', overflowY: 'auto' }}
                                                                        className="bg-white rounded-xl shadow-2xl border border-gray-200 min-w-[180px]"
                                                                        onClick={e => e.stopPropagation()}
                                                                    >
                                                                        <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 sticky top-0">
                                                                            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Sposta su bus</p>
                                                                        </div>
                                                                        {editedRoutes.map(tr => {
                                                                            if (tr.vehicle_id === route.vehicle_id) return null;
                                                                            const tColor = ROUTE_COLORS[tr.vehicle_id % ROUTE_COLORS.length];
                                                                            const tLoad = tr.outbound.stops.filter(s => s.type === 'pickup').reduce((sum, s) => sum + (s.count || 0), 0);
                                                                            const wouldOverflow = tLoad + (stop.count || 0) > capacity;
                                                                            return (
                                                                                <button
                                                                                    key={tr.vehicle_id}
                                                                                    onClick={(e) => { e.stopPropagation(); handleMoveStopToBus(busIndex, stopIndex, tr.vehicle_id); }}
                                                                                    className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-gray-50 transition-colors text-left"
                                                                                >
                                                                                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tColor }} />
                                                                                    <div className="flex-1 min-w-0">
                                                                                        <div className="text-xs font-bold" style={{ color: tColor }}>Bus #{tr.vehicle_id + 1}</div>
                                                                                        <div className={`text-[10px] ${wouldOverflow ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>
                                                                                            {tLoad + (stop.count || 0)}/{capacity} pax{wouldOverflow ? ' ⚠️' : ''}
                                                                                        </div>
                                                                                    </div>
                                                                                </button>
                                                                            );
                                                                        })}
                                                                    </div>,
                                                                    document.body
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {/* Destination arrival */}
                                    {destStop && pickupStops.length > 0 && (
                                        <div className="mt-3 ml-2 pl-4 border-l-2 border-gray-200 pt-2 relative">
                                            <div className="absolute left-0 bottom-2.5 -translate-x-[9px] w-4 h-4 rounded-full bg-green-500 border-2 border-white flex items-center justify-center">
                                                <Navigation className="w-2 h-2 text-white" />
                                            </div>
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-[11px] text-gray-500">Arrivo:</span>
                                                {isEvaluating ? (
                                                    <div className="w-20 h-6 bg-gray-200 animate-pulse rounded inline-block"></div>
                                                ) : (
                                                    <div className={`text-xs border rounded px-2 py-1 inline-block font-bold shadow-sm ${totalShift > 0 ? 'bg-orange-50 text-orange-700 border-orange-200' : 'bg-green-50 text-green-800 border-green-100'}`}>
                                                        {shiftTime(destStop.arrival_time, totalShift) || destStop.arrival_time || '--:--'}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}

                    {/* Add Bus Button */}
                    <div
                        className="border-2 border-dashed border-gray-300 rounded-xl flex items-center justify-center p-6 bg-white hover:bg-gray-50 transition-colors cursor-pointer opacity-70 hover:opacity-100"
                        onClick={handleAddBus}
                    >
                        <div className="flex flex-col items-center gap-2 text-gray-500">
                            <PlusCircle className="w-8 h-8" />
                            <span className="font-semibold text-sm">Aggiungi Bus Vuoto</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Summary footer */}
            {stats && (
                <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-wrap gap-4 shadow-sm items-center justify-around">
                    <div className="flex flex-col items-center min-w-[80px]">
                        <span className="text-gray-500 text-xs font-semibold uppercase tracking-wide">Bus Attivi</span>
                        {isEvaluating ? (
                            <div className="w-12 h-7 bg-gray-200 animate-pulse rounded mt-1"></div>
                        ) : (
                            <div className="flex items-end gap-2 mt-1">
                                <span className="text-lg font-bold text-gray-800">{stats.total_buses}</span>
                                {stats.total_buses !== initialResults.stats.total_buses && (
                                    <span className="text-xs text-gray-400 line-through mb-1">({initialResults.stats.total_buses})</span>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="w-px h-8 bg-gray-200 hidden sm:block"></div>
                    <div className="flex flex-col items-center min-w-[80px]">
                        <span className="text-gray-500 text-xs font-semibold uppercase tracking-wide">Km Andata</span>
                        {isEvaluating ? (
                            <div className="w-16 h-7 bg-gray-200 animate-pulse rounded mt-1"></div>
                        ) : (
                            <div className="flex items-end gap-2 mt-1">
                                <span className="text-lg font-bold text-blue-600">{(stats.total_distance / 1000).toFixed(1)}</span>
                                {stats.total_distance !== initialResults.stats.total_distance && (
                                    <span className="text-xs text-gray-400 line-through mb-1">({(initialResults.stats.total_distance / 1000).toFixed(1)})</span>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="w-px h-8 bg-gray-200 hidden sm:block"></div>
                    <div className="flex flex-col items-center min-w-[80px]">
                        <span className="text-gray-500 text-xs font-semibold uppercase tracking-wide">Passeggeri</span>
                        {isEvaluating ? (
                            <div className="w-12 h-7 bg-gray-200 animate-pulse rounded mt-1"></div>
                        ) : (
                            <div className="flex items-end gap-2 mt-1">
                                <span className="text-lg font-bold text-purple-600">{stats.total_passengers}</span>
                                {stats.total_passengers !== initialResults.stats.total_passengers && (
                                    <span className="text-xs text-gray-400 line-through mb-1">({initialResults.stats.total_passengers})</span>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="w-px h-8 bg-gray-200 hidden sm:block"></div>
                    <div className="flex flex-col items-center min-w-[80px]">
                        <span className="text-gray-500 text-xs font-semibold uppercase tracking-wide">Prima Partenza</span>
                        {isEvaluating ? (
                            <div className="w-14 h-7 bg-gray-200 animate-pulse rounded mt-1"></div>
                        ) : (
                            <div className="flex items-end gap-2 mt-1">
                                <span className="text-lg font-bold text-teal-600">{summaryStats.earliestDeparture || '--:--'}</span>
                                {summaryStats.earliestDeparture !== originalSummaryStats.earliestDeparture && originalSummaryStats.earliestDeparture && (
                                    <span className="text-xs text-gray-400 line-through mb-1">({originalSummaryStats.earliestDeparture})</span>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="w-px h-8 bg-gray-200 hidden sm:block"></div>
                    <div className="flex flex-col items-center min-w-[80px]">
                        <span className="text-gray-500 text-xs font-semibold uppercase tracking-wide">Durata Massima</span>
                        {isEvaluating ? (
                            <div className="w-14 h-7 bg-gray-200 animate-pulse rounded mt-1"></div>
                        ) : (
                            <div className="flex items-end gap-2 mt-1">
                                <span className="text-lg font-bold text-orange-500">{summaryStats.duration || '--'}</span>
                                {summaryStats.duration !== originalSummaryStats.duration && originalSummaryStats.duration && (
                                    <span className="text-xs text-gray-400 line-through mb-1">({originalSummaryStats.duration})</span>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Bottom action buttons (redundant) */}
            <div className="flex justify-end gap-2 pt-2 border-t border-gray-200">
                {actionButtons}
            </div>
        </div>
    );
}
