import React, { useEffect, useState, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-polylineoffset';
import { X, Maximize2, Minimize2, Bus, Users, UserX } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Flag, GraduationCap } from 'lucide-react';

const ANIM_MS = 420;
const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

const iconCache = new Map();

const getStopIcon = (color, demand) => {
    const cacheKey = `stop-${color}-${demand}`;
    if (iconCache.has(cacheKey)) return iconCache.get(cacheKey);

    const fontSize = demand >= 100 ? '9px' : demand >= 10 ? '11px' : '13px';
    const html = `
        <div class="pin-inner" style="position:relative;width:28px;height:34px;">
            <div style="
                width:28px;height:28px;
                border-radius:50% 50% 50% 0;
                transform:rotate(-45deg);
                background:${color};
                border:2px solid white;
                box-shadow:0 2px 8px rgba(0,0,0,0.25);
                display:flex;align-items:center;justify-content:center;
            "><span class="stop-demand" style="transform:rotate(45deg);color:white;font-size:${fontSize};font-weight:800;line-height:1;font-family:sans-serif;">${demand}</span></div>
            <div style="
                position:absolute;bottom:0;left:50%;
                transform:translateX(-50%);
                width:8px;height:4px;
                background:rgba(0,0,0,0.15);
                border-radius:50%;
                filter:blur(2px);
            "></div>
        </div>`;
    const icon = L.divIcon({
        html,
        className: 'custom-marker-icon',
        iconSize: [28, 34],
        iconAnchor: [14, 34],
        popupAnchor: [0, -34],
    });
    iconCache.set(cacheKey, icon);
    return icon;
};

const getInstituteIcon = (color) => {
    const cacheKey = `inst-${color}`;
    if (iconCache.has(cacheKey)) return iconCache.get(cacheKey);

    const iconHtml = renderToStaticMarkup(
        <GraduationCap style={{ width: 22, height: 22, color: 'white', strokeWidth: 2 }} />
    );
    const html = `
        <div class="pin-inner" style="
            width:40px;height:40px;
            border-radius:50%;
            background:${color};
            border:3px solid white;
            box-shadow:0 3px 10px rgba(0,0,0,0.25);
            display:flex;align-items:center;justify-content:center;
        ">${iconHtml}</div>`;
    const icon = L.divIcon({
        html,
        className: 'custom-marker-icon',
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40],
    });
    iconCache.set(cacheKey, icon);
    return icon;
};

const createCustomIcon = (color, IconComponent) => {
    const iconHtml = renderToStaticMarkup(
        <div className="relative flex items-center justify-center w-full h-full">
            <IconComponent
                className="w-8 h-8 drop-shadow-md filter"
                style={{ fill: color, color: 'white', strokeWidth: 1.5 }}
            />
            <div className="absolute -bottom-1 w-2 h-2 bg-black opacity-20 rounded-full blur-[1px]" />
        </div>
    );
    return L.divIcon({
        html: iconHtml,
        className: 'custom-marker-icon',
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
    });
};

const destinationIcon = createCustomIcon('#ef4444', Flag);

const MapController = ({ schools, destination, focusBounds }) => {
    const map = useMap();

    useEffect(() => {
        if (focusBounds && focusBounds.length === 2) {
            const bounds = L.latLngBounds(focusBounds);
            map.fitBounds(bounds, { padding: [100, 100], maxZoom: 15, animate: true });
        }
    }, [focusBounds, map]);

    useEffect(() => {
        if (!focusBounds && schools.length > 0) {
            const geocoded = schools.filter(s => s.lat != null && s.lon != null);
            if (geocoded.length === 0 && !destination) return;
            const bounds = L.latLngBounds(geocoded.map(s => [s.lat, s.lon]));
            if (destination) bounds.extend([destination.lat, destination.lon]);
            if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50] });
        }
    }, [schools, destination, map, focusBounds]);

    return null;
};

// Forces Leaflet to recalculate tile grid after resize/animation
const MapResizer = ({ trigger }) => {
    const map = useMap();
    useEffect(() => {
        const t = setTimeout(() => map.invalidateSize({ animate: false }), ANIM_MS + 50);
        return () => clearTimeout(t);
    }, [trigger, map]);
    return null;
};

const MapEventTracker = ({ onZoomChange }) => {
    const map = useMap();
    useEffect(() => {
        onZoomChange(map.getZoom());
        const handleZoom = () => onZoomChange(map.getZoom());
        map.on('zoomend', handleZoom);
        return () => map.off('zoomend', handleZoom);
    }, [map, onZoomChange]);
    return null;
};

const COLORS = [
    '#3b82f6', '#ef4444', '#22c55e', '#eab308',
    '#a855f7', '#f97316', '#ec4899', '#14b8a6'
];


const BusMap = ({ schools, routes, overlaps = [], destination, focusBounds, highlightedRouteId, onResetFocus, instituteColorMap = {} }) => {
    const defaultCenter = [46.0697, 11.1211];
    const placeholderRef = useRef(null); // the div that holds the natural-flow space
    const containerRef = useRef(null);   // the actual map div we animate
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [resizerTick, setResizerTick] = useState(0);
    const [hiddenRouteIds, setHiddenRouteIds] = useState(new Set());
    const [showDemand, setShowDemand] = useState(true);
    const [currentZoom, setCurrentZoom] = useState(14);

    // Compute segment clusters to draw perfectly offset parallel polylines
    // when any N routes share exactly the same road segments.
    const segmentGroups = React.useMemo(() => {
        if (!routes) return {};
        const segmentMap = new globalThis.Map();
        
        const getSegKey = (c1, c2) => {
            const h1 = `${c1[0].toFixed(5)},${c1[1].toFixed(5)}`;
            const h2 = `${c2[0].toFixed(5)},${c2[1].toFixed(5)}`;
            return h1 < h2 ? `${h1}|${h2}` : `${h2}|${h1}`;
        };
        
        routes.forEach(route => {
            const geom = (route.outbound || route).geometry;
            if (!geom || !geom.coordinates) return;
            const coords = geom.coordinates;
            for (let i = 0; i < coords.length - 1; i++) {
                const c1 = coords[i];
                const c2 = coords[i+1];
                const key = getSegKey(c1, c2);
                if (!segmentMap.has(key)) {
                    // Convert [lon, lat] object into Leaflet [lat, lon] array
                    segmentMap.set(key, { coords: [[c1[1], c1[0]], [c2[1], c2[0]]], vehicles: new Set() });
                }
                segmentMap.get(key).vehicles.add(route.vehicle_id);
            }
        });
        
        const groupsByCombo = {}; 
        segmentMap.forEach((val) => {
            const combo = Array.from(val.vehicles).sort((a,b)=>a-b).join(',');
            if (!groupsByCombo[combo]) groupsByCombo[combo] = [];
            groupsByCombo[combo].push(val.coords);
        });
        
        // Merge disconnected 2-point segments into continuous paths
        const mergedPathsByCombo = {};
        const pointsEqual = (p1, p2) => Math.abs(p1[0] - p2[0]) < 1e-5 && Math.abs(p1[1] - p2[1]) < 1e-5;

        for (const [combo, segments] of Object.entries(groupsByCombo)) {
            const paths = [];
            let unvisited = [...segments];

            while (unvisited.length > 0) {
                let currentPath = [...unvisited.shift()];
                let added = true;

                while (added) {
                    added = false;
                    for (let i = 0; i < unvisited.length; i++) {
                        const seg = unvisited[i];
                        const start = currentPath[0];
                        const end = currentPath[currentPath.length - 1];

                        if (pointsEqual(end, seg[0])) {
                            currentPath.push(seg[1]);
                            unvisited.splice(i, 1);
                            added = true; break;
                        } else if (pointsEqual(end, seg[1])) {
                            currentPath.push(seg[0]);
                            unvisited.splice(i, 1);
                            added = true; break;
                        } else if (pointsEqual(start, seg[1])) {
                            currentPath.unshift(seg[0]);
                            unvisited.splice(i, 1);
                            added = true; break;
                        } else if (pointsEqual(start, seg[0])) {
                            currentPath.unshift(seg[1]);
                            unvisited.splice(i, 1);
                            added = true; break;
                        }
                    }
                }
                
                // Filter out points that are too close to avoid mega-spirals (swallowtails) on large offsets
                if (currentPath.length > 2) {
                    const simplifiedPath = [currentPath[0]];
                    let lastAdded = currentPath[0];
                    for (let j = 1; j < currentPath.length - 1; j++) {
                         const p2 = currentPath[j];
                         const dLat = lastAdded[0] - p2[0];
                         const dLon = lastAdded[1] - p2[1];
                         if ((dLat*dLat + dLon*dLon) > 1e-8) { // ~11 meters squared
                             simplifiedPath.push(p2);
                             lastAdded = p2;
                         }
                    }
                    const lastPt = currentPath[currentPath.length - 1];
                    const dLat = lastAdded[0] - lastPt[0];
                    const dLon = lastAdded[1] - lastPt[1];
                    if ((dLat*dLat + dLon*dLon) > 1e-8 || simplifiedPath.length === 1) {
                         simplifiedPath.push(lastPt);
                    } else {
                         simplifiedPath[simplifiedPath.length - 1] = lastPt;
                    }
                    currentPath = simplifiedPath;
                }

                paths.push(currentPath);
            }
            mergedPathsByCombo[combo] = paths;
        }
        
        return mergedPathsByCombo;
    }, [routes]);

    const [highlight, setHighlight] = useState(null); // { vehicleId, animKey } — active CSS animation
    const [topRouteId, setTopRouteId] = useState(null); // permanent front route after animation
    const highlightTimerRef = useRef(null);

    useEffect(() => { setHiddenRouteIds(new Set()); }, [routes]);
    useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); }, []);

    const handlePolylineClick = useCallback((vehicleId) => {
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        setTopRouteId(vehicleId);
        setHighlight({ vehicleId, animKey: Date.now() });
        highlightTimerRef.current = setTimeout(() => setHighlight(null), 5000);
    }, []);

    // --- FLIP animation helpers ---
    const enterFullscreen = useCallback(() => {
        const placeholder = placeholderRef.current;
        const container = containerRef.current;
        if (!placeholder || !container) return;

        const rect = placeholder.getBoundingClientRect();

        // Step 1: pin the container *exactly* over the placeholder (no visual jump)
        Object.assign(container.style, {
            position: 'fixed',
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            borderRadius: '12px',
            zIndex: '9999',
            margin: '0',
            transition: 'none',
        });

        // Step 2: force browser to register the "from" state
        container.getBoundingClientRect();

        // Step 3: animate to fullscreen
        Object.assign(container.style, {
            transition: `top ${ANIM_MS}ms ${EASING}, left ${ANIM_MS}ms ${EASING}, width ${ANIM_MS}ms ${EASING}, height ${ANIM_MS}ms ${EASING}, border-radius ${ANIM_MS}ms ${EASING}`,
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            borderRadius: '0',
        });

        setIsFullscreen(true);
        setResizerTick(t => t + 1);
    }, []);

    const exitFullscreen = useCallback(() => {
        const placeholder = placeholderRef.current;
        const container = containerRef.current;
        if (!placeholder || !container) return;

        // The placeholder hasn't moved — use its current rect as the target
        const rect = placeholder.getBoundingClientRect();

        Object.assign(container.style, {
            transition: `top ${ANIM_MS}ms ${EASING}, left ${ANIM_MS}ms ${EASING}, width ${ANIM_MS}ms ${EASING}, height ${ANIM_MS}ms ${EASING}, border-radius ${ANIM_MS}ms ${EASING}`,
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            borderRadius: '12px',
        });

        // After the animation, restore natural-flow positioning
        setTimeout(() => {
            Object.assign(container.style, {
                position: '',
                top: '',
                left: '',
                width: '',
                height: '',
                borderRadius: '',
                zIndex: '',
                transition: '',
            });
            setIsFullscreen(false);
            setResizerTick(t => t + 1);
        }, ANIM_MS);
    }, []);

    const toggleFullscreen = useCallback(() => {
        if (!isFullscreen) {
            enterFullscreen();
        } else {
            exitFullscreen();
        }
    }, [isFullscreen, enterFullscreen, exitFullscreen]);

    // Esc key exits fullscreen
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape' && isFullscreen) exitFullscreen(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isFullscreen, exitFullscreen]);

    const getPositions = (routeData) => {
        if (routeData.geometry && routeData.geometry.coordinates) {
            return routeData.geometry.coordinates.map(c => [c[1], c[0]]);
        }
        return (routeData.stops || [])
            .filter(s => s.lat != null && s.lon != null)
            .map(s => [s.lat, s.lon]);
    };

    const simplifyPath = (positions, toleranceMeters) => {
        if (positions.length <= 2 || toleranceMeters <= 0) return positions;
        const res = [positions[0]];
        let lastPt = positions[0];
        const latToMeters = 111320;
        
        for (let i = 1; i < positions.length - 1; i++) {
            const p = positions[i];
            const dy = (p[0] - lastPt[0]) * latToMeters;
            const dx = (p[1] - lastPt[1]) * latToMeters * Math.cos(lastPt[0] * Math.PI / 180);
            const dist = Math.sqrt(dy*dy + dx*dx);
            
            if (dist >= toleranceMeters) {
                res.push(p);
                lastPt = p;
            }
        }
        res.push(positions[positions.length - 1]);
        return res;
    };

    const applyGeographicOffset = (positions, offsetMeters) => {
        if (!offsetMeters || Math.abs(offsetMeters) < 0.1) return positions;
        if (positions.length < 2) return positions;
        
        const latToMeters = 111320;
        const res = [];
        for (let i = 0; i < positions.length; i++) {
            let pPrev = i > 0 ? positions[i-1] : null;
            let pCurr = positions[i];
            let pNext = i < positions.length - 1 ? positions[i+1] : null;

            let nx = 0, ny = 0;
            const computeD = (p1, p2) => {
                const dy = (p2[0] - p1[0]) * latToMeters;
                const dx = (p2[1] - p1[1]) * latToMeters * Math.cos(p1[0] * Math.PI / 180);
                const len = Math.sqrt(dy*dy + dx*dx) || 1;
                return [dy / len, dx / len]; // [dy, dx]
            };
            
            if (pPrev && pNext) {
                const [dyPrev, dxPrev] = computeD(pPrev, pCurr);
                const [dyNext, dxNext] = computeD(pCurr, pNext);
                const avgDy = (dyPrev + dyNext) / 2;
                const avgDx = (dxPrev + dxNext) / 2;
                const avgLen = Math.sqrt(avgDy*avgDy + avgDx*avgDx);
                if (avgLen > 0) {
                    nx = avgDy / avgLen;
                    ny = -avgDx / avgLen;
                } else {
                    nx = dyPrev;
                    ny = -dxPrev;
                }
            } else if (pNext) {
                const [dy, dx] = computeD(pCurr, pNext);
                nx = dy; ny = -dx;
            } else if (pPrev) {
                const [dy, dx] = computeD(pPrev, pCurr);
                nx = dy; ny = -dx;
            }
            
            const lonToMeters = latToMeters * Math.cos(pCurr[0] * Math.PI / 180);
            res.push([
                pCurr[0] + (ny * offsetMeters) / latToMeters,
                pCurr[1] + (nx * offsetMeters) / lonToMeters
            ]);
        }
        return res;
    };

    return (
        <div ref={placeholderRef} className="w-full h-full rounded-xl">
        <style>{`
            @keyframes route-glow-anim {
                0%   { opacity: 0; }
                8%   { opacity: 0.55; }
                78%  { opacity: 0.55; }
                100% { opacity: 0; }
            }
            @keyframes route-line-anim {
                0%   { opacity: 0; }
                8%   { opacity: 1; }
                78%  { opacity: 1; }
                100% { opacity: 0; }
            }
            .route-glow {
                filter: blur(12px);
                animation: route-glow-anim 5s cubic-bezier(0.4,0,0.2,1) forwards;
                pointer-events: none;
            }
            .route-line-hl {
                animation: route-line-anim 5s cubic-bezier(0.4,0,0.2,1) forwards;
            }
            .pin-inner {
                transition: transform 0.4s cubic-bezier(0.4,0,0.2,1);
                transform-origin: 50% 100%;
            }
            .stop-demand {
                transition: opacity 0.2s ease;
            }
            .map-minimal-pins .pin-inner {
                transform: scale(0.5);
            }
            .map-minimal-pins .stop-demand {
                opacity: 0;
            }
        `}</style>
            <div
                ref={containerRef}
                className={`w-full h-full rounded-xl overflow-hidden shadow-inner border border-gray-200 relative z-0 bg-gray-100${showDemand ? '' : ' map-minimal-pins'}`}
            >
                {/* Route toggle panel — bottom-left */}
                {routes && routes.length > 0 && (
                    <div className="absolute bottom-3 left-3 z-[1000] flex flex-col gap-1">
                        {routes.map((route, idx) => {
                            const color = COLORS[idx % COLORS.length];
                            const hidden = hiddenRouteIds.has(route.vehicle_id);
                            return (
                                <button
                                    key={route.vehicle_id}
                                    onClick={() => setHiddenRouteIds(prev => {
                                        const next = new Set(prev);
                                        hidden ? next.delete(route.vehicle_id) : next.add(route.vehicle_id);
                                        return next;
                                    })}
                                    className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium shadow-md bg-white transition-opacity"
                                    style={{ borderLeft: `4px solid ${color}`, opacity: hidden ? 0.45 : 1 }}
                                >
                                    <Bus size={12} style={{ color }} />
                                    <span style={{ color: hidden ? '#9ca3af' : '#1f2937' }}>
                                        Bus {route.vehicle_id + 1}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Top-right buttons */}
                <div className="absolute top-3 right-3 z-[1000] flex items-center gap-1.5">
                    <button
                        onClick={() => setShowDemand(v => !v)}
                        className="bg-white shadow-md rounded-full p-2 hover:bg-gray-100 transition-colors"
                        title={showDemand ? 'Nascondi partecipanti' : 'Mostra partecipanti'}
                    >
                        {showDemand
                            ? <Users className="w-4 h-4 text-gray-600" />
                            : <UserX className="w-4 h-4 text-gray-400" />
                        }
                    </button>
                    {highlightedRouteId !== null && onResetFocus && (
                        <button
                            onClick={onResetFocus}
                            className="bg-white shadow-md rounded-full p-2 hover:bg-gray-100 transition-colors"
                            title="Reimposta vista mappa"
                        >
                            <X className="w-4 h-4 text-gray-600" />
                        </button>
                    )}
                    <button
                        onClick={toggleFullscreen}
                        className="bg-white shadow-md rounded-full p-2 hover:bg-gray-100 transition-colors"
                        title={isFullscreen ? 'Esci da schermo intero' : 'Schermo intero'}
                    >
                        {isFullscreen
                            ? <Minimize2 className="w-4 h-4 text-gray-600" />
                            : <Maximize2 className="w-4 h-4 text-gray-600" />
                        }
                    </button>
                </div>

                <MapContainer center={defaultCenter} zoom={14} style={{ height: '100%', width: '100%' }}>
                    <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        attribution='&copy; OpenStreetMap contributors'
                    />

                    <MapResizer trigger={resizerTick} />
                    <MapEventTracker onZoomChange={setCurrentZoom} />

                    <MapController
                        schools={schools}
                        destination={destination}
                        focusBounds={focusBounds}
                    />

                    {destination && (
                        <Marker position={[destination.lat, destination.lon]} icon={destinationIcon} zIndexOffset={1000}>
                            <Popup>
                                <div className="text-center">
                                    <strong className="text-red-600 block text-lg mb-1">Destinazione</strong>
                                    <span className="text-gray-600 text-sm">{destination.address}</span>
                                </div>
                            </Popup>
                        </Marker>
                    )}

                    {schools.filter(s => s.lat != null && s.lon != null).map((school) => {
                        const color = school.institute
                            ? (instituteColorMap[school.institute] || '#3b82f6')
                            : '#3b82f6';
                        const icon = school.institute
                            ? getInstituteIcon(color)
                            : getStopIcon(color, school.demand);
                        return (
                            <Marker key={school.id} position={[school.lat, school.lon]} icon={icon}>
                                <Popup>
                                    <div className="min-w-[150px]">
                                        <strong className="block text-base mb-1 border-b pb-1" style={{ color }}>
                                            {school.institute ? school.institute : 'Fermata'}
                                        </strong>
                                        <div className="font-semibold text-gray-800">{school.name}</div>
                                        <div className="text-gray-600 text-xs mt-1 mb-2">{school.address}</div>
                                        <div className="bg-gray-100 text-gray-800 text-xs font-bold px-2 py-1 rounded-full inline-block">
                                            {school.demand} passeggeri
                                        </div>
                                    </div>
                                </Popup>
                            </Marker>
                        );
                    })}

                    {/* 1. LAYER VISIVO: MULTIPOLYLINES CON OFFSET DINAMICO */}
                    {Object.entries(segmentGroups).map(([combo, paths]) => {
                        const vIds = combo.split(',').map(Number);
                        const activeVIds = vIds.filter(vId => !hiddenRouteIds.has(vId));
                        if (activeVIds.length === 0) return null;
                        
                        const numVehicles = activeVIds.length;
                        
                        // Scale visually by targeting a constant pixel thickness/gap based on zoom
                        let baseWeight = 7;
                        let gapPixels = 1;
                        
                        // Because fitBounds can start the map at zoom 12 or 13, 
                        // we must guarantee a solid pixel gap at ALL zoom levels.
                        if (currentZoom <= 12) {
                            baseWeight = 3.5;
                            gapPixels = 0.5;
                        } else if (currentZoom === 13) {
                            baseWeight = 4;
                            gapPixels = 0.5;
                        } else if (currentZoom === 14) {
                            baseWeight = 5.5;
                            gapPixels = 0.5;
                        } else if (currentZoom >= 15) {
                            baseWeight = 11;
                            gapPixels = 1.5;
                        }
                        
                        if (numVehicles > 1) {
                            // Diminuisci la stazza delle linee quando sono affiancate per contenere l'ingombro visivo
                            baseWeight = Math.max(3, baseWeight * 0.65);
                            gapPixels = Math.max(0.5, gapPixels * 0.7);
                        }
                        
                        let toleranceMeters = 0;
                        if (currentZoom <= 12) toleranceMeters = 150;
                        else if (currentZoom === 13) toleranceMeters = 80;
                        else if (currentZoom === 14) toleranceMeters = 35;
                        
                        const lineWidth = baseWeight;
                        const offsetStepPixels = baseWeight + gapPixels;
                        const metersPerPixel = 108740 / Math.pow(2, currentZoom);
                        
                        // No cap on max meters! We WANT the geographic offset to become huge (e.g. 500m) 
                        // when zoomed out so the lines remain physically separated by `gapPixels` on the screen.
                        const offsetStepMeters = offsetStepPixels * metersPerPixel;

                        return activeVIds.map((vId, idx) => {
                            const originalIdx = routes.findIndex(r => r.vehicle_id === vId);
                            const color = COLORS[originalIdx % COLORS.length];
                            
                            const offsetMeters = (idx - (numVehicles - 1) / 2) * offsetStepMeters;
                            
                            const animId = highlight?.vehicleId;
                            const isAnimating = animId === vId;
                            const isSidebarHL = !animId && highlightedRouteId === vId;
                            const isDimmed = (animId !== null && animId !== undefined || highlightedRouteId !== null) && !isAnimating && !isSidebarHL;
                            
                            return paths.map((pathPositions, pathIdx) => {
                                const simplified = simplifyPath(pathPositions, toleranceMeters);
                                const offsetPath = applyGeographicOffset(simplified, offsetMeters);
                                return (
                                    <Polyline
                                        key={`seg-${combo}-${vId}-${pathIdx}`}
                                        positions={offsetPath}
                                        pathOptions={{
                                            color: isSidebarHL ? '#f97316' : color,
                                            weight: isSidebarHL ? 6 : lineWidth,
                                            opacity: isDimmed ? 0.25 : 1, // Opacità a 1
                                            lineCap: 'round',
                                            lineJoin: 'round',
                                            interactive: false
                                        }}
                                    />
                                );
                            });
                        });
                    })}

                    {/* 2. LAYER INTERATTIVO + GLOW: POLILINE CONTINUI E TRASPARENTI */}
                    {routes && routes.map((route) => {
                        if (hiddenRouteIds.has(route.vehicle_id)) return null;
                        const animId = highlight?.vehicleId;
                        const isAnimating = animId === route.vehicle_id;
                        const originalIdx = routes.findIndex(r => r.vehicle_id === route.vehicle_id);
                        const color = COLORS[originalIdx % COLORS.length];
                        const positions = getPositions(route.outbound || route);
                        
                        return (
                            <React.Fragment key={`interactive-${route.vehicle_id}`}>
                                {isAnimating && (
                                    <Polyline
                                        positions={positions}
                                        pathOptions={{
                                            color,
                                            weight: 22,
                                            opacity: 1,
                                            lineCap: 'round',
                                            lineJoin: 'round',
                                            className: 'route-glow',
                                            interactive: false
                                        }}
                                    />
                                )}
                                {/* Invisible thick line per facilitare i click mouse */}
                                <Polyline
                                    positions={positions}
                                    pathOptions={{
                                        color: 'transparent',
                                        weight: 20,
                                        opacity: 0,
                                        interactive: true
                                    }}
                                    eventHandlers={{ click: () => handlePolylineClick(route.vehicle_id) }}
                                />
                            </React.Fragment>
                        );
                    })}

                    {focusBounds && (
                        <Polyline
                            positions={focusBounds}
                            pathOptions={{ color: 'black', weight: 3, dashArray: '8, 8', opacity: 0.7 }}
                        />
                    )}
                </MapContainer>
            </div>
        </div>
    );
};

export default BusMap;
