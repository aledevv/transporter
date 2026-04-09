import React, { useEffect, useState, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-polylineoffset';
import { X, Maximize2, Minimize2, Bus } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Flag, GraduationCap } from 'lucide-react';

const ANIM_MS = 420;
const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

const createStopIcon = (color, demand) => {
    const fontSize = demand >= 100 ? '10px' : demand >= 10 ? '12px' : '14px';
    const html = `
        <div style="position:relative;width:36px;height:44px;">
            <div style="
                width:36px;height:36px;
                border-radius:50% 50% 50% 0;
                transform:rotate(-45deg);
                background:${color};
                border:2px solid white;
                box-shadow:0 3px 10px rgba(0,0,0,0.25);
                display:flex;align-items:center;justify-content:center;
            ">
                <span style="
                    transform:rotate(45deg);
                    color:white;
                    font-size:${fontSize};
                    font-weight:800;
                    line-height:1;
                    font-family:sans-serif;
                ">${demand}</span>
            </div>
            <div style="
                position:absolute;bottom:0;left:50%;
                transform:translateX(-50%);
                width:10px;height:5px;
                background:rgba(0,0,0,0.15);
                border-radius:50%;
                filter:blur(2px);
            "></div>
        </div>`;
    return L.divIcon({
        html,
        className: 'custom-marker-icon',
        iconSize: [36, 44],
        iconAnchor: [18, 44],
        popupAnchor: [0, -44],
    });
};

const createInstituteIcon = (color) => {
    const iconHtml = renderToStaticMarkup(
        <GraduationCap style={{ width: 22, height: 22, color: 'white', strokeWidth: 2 }} />
    );
    const html = `
        <div style="
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

const OffsetPolyline = ({ positions, options, offset, popup }) => {
    const map = useMap();
    const [zoom, setZoom] = useState(() => map.getZoom());

    useEffect(() => {
        const onZoom = () => setZoom(map.getZoom());
        map.on('zoomend', onZoom);
        return () => map.off('zoomend', onZoom);
    }, [map]);

    useEffect(() => {
        const scale = Math.max(0.15, Math.min(1, (zoom - 12) / 3));
        const scaledOffset = offset * scale;
        const layer = L.polyline(positions, { ...options, offset: scaledOffset, smoothFactor: 1 });
        if (popup) layer.bindPopup(popup);
        layer.addTo(map);
        return () => map.removeLayer(layer);
    }, [positions, options, offset, popup, map, zoom]);
    return null;
};

const Map = ({ schools, routes, destination, focusBounds, highlightedRouteId, onResetFocus, instituteColorMap = {} }) => {
    const defaultCenter = [46.0697, 11.1211];
    const placeholderRef = useRef(null); // the div that holds the natural-flow space
    const containerRef = useRef(null);   // the actual map div we animate
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [resizerTick, setResizerTick] = useState(0);
    const [hiddenRouteIds, setHiddenRouteIds] = useState(new Set());

    useEffect(() => { setHiddenRouteIds(new Set()); }, [routes]);

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
        // The placeholder always stays in the normal document flow
        // and defines the space the map occupies when not fullscreen
        <div ref={placeholderRef} className="w-full h-full rounded-xl">
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

                <MapContainer center={defaultCenter} zoom={13} style={{ height: '100%', width: '100%' }}>
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
                        <Marker position={[destination.lat, destination.lon]} icon={destinationIcon}>
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

                    {routes && routes.map((route, idx) => {
                        if (hiddenRouteIds.has(route.vehicle_id)) return null;
                        const isHighlighted = highlightedRouteId === route.vehicle_id;
                        const color = COLORS[idx % COLORS.length];
                        const positions = getPositions(route.outbound || route);
                        const routeOffset = (idx - (routes.length - 1) / 2) * 3;
                        return (
                            <OffsetPolyline
                                key={route.vehicle_id}
                                positions={positions}
                                options={{
                                    color: isHighlighted ? '#f97316' : color,
                                    weight: isHighlighted ? 10 : 5,
                                    opacity: isHighlighted ? 1 : (highlightedRouteId !== null ? 0.3 : 0.8),
                                    lineJoin: 'round',
                                }}
                                offset={routeOffset}
                                popup={`Bus #${route.vehicle_id + 1}`}
                            />
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

export default Map;
