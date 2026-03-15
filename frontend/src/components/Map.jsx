import React, { useEffect, useState, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X, Maximize2, Minimize2 } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MapPin, Flag, Building2 } from 'lucide-react';

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

// Invalidate map size when container changes (e.g. fullscreen)
const MapResizer = () => {
    const map = useMap();
    useEffect(() => {
        setTimeout(() => map.invalidateSize(), 100);
    });
    return null;
};

const COLORS = [
    '#3b82f6', '#ef4444', '#22c55e', '#eab308',
    '#a855f7', '#f97316', '#ec4899', '#14b8a6'
];

const Map = ({ schools, routes, destination, focusBounds, highlightedRouteId, onResetFocus, instituteColorMap = {} }) => {
    const defaultCenter = [46.0697, 11.1211];
    const containerRef = useRef(null);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Listen for native fullscreen change (Esc key exits fullscreen)
    useEffect(() => {
        const handleFsChange = () => {
            if (!document.fullscreenElement) {
                setIsFullscreen(false);
            }
        };
        document.addEventListener('fullscreenchange', handleFsChange);
        return () => document.removeEventListener('fullscreenchange', handleFsChange);
    }, []);

    const toggleFullscreen = useCallback(async () => {
        if (!isFullscreen) {
            try {
                await containerRef.current.requestFullscreen();
                setIsFullscreen(true);
            } catch (e) {
                console.warn('Fullscreen not supported', e);
            }
        } else {
            await document.exitFullscreen();
            setIsFullscreen(false);
        }
    }, [isFullscreen]);

    const getPositions = (routeData) => {
        if (routeData.geometry && routeData.geometry.coordinates) {
            return routeData.geometry.coordinates.map(c => [c[1], c[0]]);
        }
        return (routeData.stops || [])
            .filter(s => s.lat != null && s.lon != null)
            .map(s => [s.lat, s.lon]);
    };

    return (
        <div
            ref={containerRef}
            className="w-full rounded-xl overflow-hidden shadow-inner border border-gray-200 relative z-0 bg-gray-100"
            style={{ height: isFullscreen ? '100vh' : '100%' }}
        >
            {/* Top-right control buttons */}
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

                <MapResizer />

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
                    const icon = createCustomIcon(color, school.institute ? Building2 : MapPin);
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
                    const isHighlighted = highlightedRouteId === route.vehicle_id;
                    const color = COLORS[idx % COLORS.length];
                    const positions = getPositions(route.outbound || route);
                    return (
                        <Polyline
                            key={route.vehicle_id}
                            positions={positions}
                            pathOptions={{
                                color: isHighlighted ? '#f97316' : color,
                                weight: isHighlighted ? 10 : 5,
                                opacity: isHighlighted ? 1 : (highlightedRouteId !== null ? 0.3 : 0.8),
                                lineJoin: 'round',
                            }}
                        >
                            <Popup>Bus #{route.vehicle_id + 1}</Popup>
                        </Polyline>
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
    );
};

export default Map;
