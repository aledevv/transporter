import React, { useEffect, useState, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X, Maximize2, Minimize2, Bus, Users, UserX } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Flag, GraduationCap } from 'lucide-react';

const ANIM_MS = 420;
const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

const createStopIcon = (color, demand) => {
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
    return L.divIcon({
        html,
        className: 'custom-marker-icon',
        iconSize: [28, 34],
        iconAnchor: [14, 34],
        popupAnchor: [0, -34],
    });
};

const createInstituteIcon = (color) => {
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
    return L.divIcon({
        html,
        className: 'custom-marker-icon',
        iconSize: [40, 40],
        iconAnchor: [20, 40],
        popupAnchor: [0, -40],
    });
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

const COLORS = [
    '#3b82f6', '#ef4444', '#22c55e', '#eab308',
    '#a855f7', '#f97316', '#ec4899', '#14b8a6'
];


const Map = ({ schools, routes, destination, focusBounds, highlightedRouteId, onResetFocus, instituteColorMap = {} }) => {
    const defaultCenter = [46.0697, 11.1211];
    const placeholderRef = useRef(null); // the div that holds the natural-flow space
    const containerRef = useRef(null);   // the actual map div we animate
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [resizerTick, setResizerTick] = useState(0);
    const [hiddenRouteIds, setHiddenRouteIds] = useState(new Set());
    const [showDemand, setShowDemand] = useState(true);
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
                className="w-full h-full rounded-xl overflow-hidden shadow-inner border border-gray-200 relative z-0 bg-gray-100"
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

                <MapContainer center={defaultCenter} zoom={13} style={{ height: '100%', width: '100%' }} className={showDemand ? '' : 'map-minimal-pins'}>
                    <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        attribution='&copy; OpenStreetMap contributors'
                    />

                    <MapResizer trigger={resizerTick} />

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
                            ? createInstituteIcon(color)
                            : createStopIcon(color, school.demand);
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

                    {routes && (() => {
                        const animId = highlight?.vehicleId;
                        const frontId = animId ?? topRouteId ?? highlightedRouteId;
                        const isAnyDimmed = animId !== null && animId !== undefined || highlightedRouteId !== null;
                        const sorted = [...routes].sort((a, b) =>
                            a.vehicle_id === frontId ? 1 : b.vehicle_id === frontId ? -1 : 0
                        );
                        return sorted.map((route) => {
                            if (hiddenRouteIds.has(route.vehicle_id)) return null;
                            const originalIdx = routes.findIndex(r => r.vehicle_id === route.vehicle_id);
                            const color = COLORS[originalIdx % COLORS.length];
                            const isAnimating = animId === route.vehicle_id;
                            const isSidebarHL = !animId && highlightedRouteId === route.vehicle_id;
                            const positions = getPositions(route.outbound || route);
                            return (
                                <React.Fragment key={route.vehicle_id}>
                                    {isAnimating && (
                                        <Polyline
                                            key={`glow-${highlight.animKey}`}
                                            positions={positions}
                                            pathOptions={{
                                                color,
                                                weight: 22,
                                                opacity: 1,
                                                lineCap: 'round',
                                                lineJoin: 'round',
                                                className: 'route-glow',
                                            }}
                                        />
                                    )}
                                    <Polyline
                                        key={isAnimating ? `line-${highlight.animKey}` : route.vehicle_id}
                                        positions={positions}
                                        pathOptions={{
                                            color: isSidebarHL ? '#f97316' : color,
                                            weight: (isAnimating || isSidebarHL) ? 7 : 4,
                                            opacity: (isAnimating || isSidebarHL) ? 1 : (isAnyDimmed ? 0.3 : 0.75),
                                            lineCap: 'round',
                                            lineJoin: 'round',
                                            className: isAnimating ? 'route-line-hl' : '',
                                        }}
                                        eventHandlers={{ click: () => handlePolylineClick(route.vehicle_id) }}
                                    />
                                </React.Fragment>
                            );
                        });
                    })()}

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

export default Map;
