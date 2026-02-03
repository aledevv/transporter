import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import { X } from 'lucide-react';

import { renderToStaticMarkup } from 'react-dom/server';
import { MapPin, Flag, Building2 } from 'lucide-react';

const createCustomIcon = (color, IconComponent) => {
    const iconHtml = renderToStaticMarkup(
        <div className="relative flex items-center justify-center w-full h-full">
            <IconComponent
                className={`w-8 h-8 drop-shadow-md filter`}
                style={{ fill: color, color: 'white', strokeWidth: 1.5 }}
            />
            <div
                className="absolute -bottom-1 w-2 h-2 bg-black opacity-20 rounded-full blur-[1px]"
            ></div>
        </div>
    );

    return L.divIcon({
        html: iconHtml,
        className: 'custom-marker-icon', // Empty cleanup
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32]
    });
};

const schoolIcon = createCustomIcon('#3b82f6', MapPin); // Blue
const destinationIcon = createCustomIcon('#ef4444', Flag); // Red

// Inner component to handle Map updates via props
const MapController = ({ schools, destination, focusBounds }) => {
    const map = useMap();

    // 1. Handle explicit Focus (Zoom to Segment)
    useEffect(() => {
        if (focusBounds && focusBounds.length === 2) {
            const bounds = L.latLngBounds(focusBounds);
            map.fitBounds(bounds, { padding: [100, 100], maxZoom: 15, animate: true });
        }
    }, [focusBounds, map]);

    // 2. Handle Initial Data Load (Fit All)
    useEffect(() => {
        if (!focusBounds && schools.length > 0) {
            const bounds = L.latLngBounds(schools.map(s => [s.lat, s.lon]));
            if (destination) {
                bounds.extend([destination.lat, destination.lon]);
            }
            if (bounds.isValid()) {
                map.fitBounds(bounds, { padding: [50, 50] });
            }
        }
    }, [schools, destination, map, focusBounds]);

    return null;
};

const COLORS = [
    '#3b82f6', '#ef4444', '#22c55e', '#eab308',
    '#a855f7', '#f97316', '#ec4899', '#14b8a6'
];

const Map = ({ schools, routes, destination, focusBounds, highlightedRouteId, onResetFocus }) => {
    const defaultCenter = [46.0697, 11.1211]; // Trento

    const getPositions = (routeData) => {
        if (routeData.geometry && routeData.geometry.coordinates) {
            return routeData.geometry.coordinates.map(c => [c[1], c[0]]);
        }
        return routeData.stops.map(s => [s.lat, s.lon]);
    };

    return (
        <div className="h-[600px] w-full rounded-xl overflow-hidden shadow-inner border border-gray-200 relative z-0">
            {/* Reset Focus Button */}
            {highlightedRouteId !== null && onResetFocus && (
                <button
                    onClick={onResetFocus}
                    className="absolute top-3 right-3 z-[1000] bg-white shadow-md rounded-full p-2 hover:bg-gray-100 transition-colors"
                    title="Reimposta vista mappa"
                >
                    <X className="w-5 h-5 text-gray-600" />
                </button>
            )}

            <MapContainer center={defaultCenter} zoom={13} style={{ height: '100%', width: '100%' }}>
                <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution='&copy; OpenStreetMap contributors'
                />

                <MapController
                    schools={schools}
                    destination={destination}
                    focusBounds={focusBounds}
                />

                {destination && (
                    <Marker position={[destination.lat, destination.lon]} icon={destinationIcon}>
                        <Popup className="custom-popup">
                            <div className="text-center">
                                <strong className="text-red-600 block text-lg mb-1">🏁 Destinazione</strong>
                                <span className="text-gray-600 text-sm">{destination.address}</span>
                            </div>
                        </Popup>
                    </Marker>
                )}

                {schools.map((school) => (
                    <Marker key={school.id} position={[school.lat, school.lon]} icon={schoolIcon}>
                        <Popup className="custom-popup">
                            <div className="min-w-[150px]">
                                <strong className="text-blue-600 block text-base mb-1 border-b pb-1">🏫 {school.name}</strong>
                                <div className="text-gray-600 text-xs mt-1 mb-2">{school.address}</div>
                                <div className="bg-blue-50 text-blue-800 text-xs font-bold px-2 py-1 rounded-full inline-block">
                                    👥 {school.demand} passeggeri
                                </div>
                            </div>
                        </Popup>
                    </Marker>
                ))}

                {routes && routes.map((route, idx) => {
                    const isHighlighted = highlightedRouteId === route.vehicle_id;
                    const color = COLORS[idx % COLORS.length];
                    const positions = getPositions(route);

                    return (
                        <Polyline
                            key={route.vehicle_id}
                            positions={positions}
                            pathOptions={{
                                color: isHighlighted ? '#f97316' : color, // Orange for highlighted
                                weight: isHighlighted ? 10 : 5,
                                opacity: isHighlighted ? 1 : (highlightedRouteId !== null ? 0.3 : 0.8),
                                lineJoin: 'round'
                            }}
                        >
                            <Popup>Bus #{route.vehicle_id + 1}</Popup>
                        </Polyline>
                    );
                })}

                {/* Segment indicator line (A to B) */}
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
