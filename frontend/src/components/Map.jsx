import React, { useEffect, useState } from 'react';
import { GoogleMap, useJsApiLoader, Marker, InfoWindow, Polyline } from '@react-google-maps/api';
import { X } from 'lucide-react';

const COLORS = [
    '#3b82f6', '#ef4444', '#22c55e', '#eab308',
    '#a855f7', '#f97316', '#ec4899', '#14b8a6'
];

const Map = ({ schools, routes, destination, focusBounds, highlightedRouteId, onResetFocus, instituteColorMap = {}, mapsKey = '' }) => {
    const { isLoaded } = useJsApiLoader({ googleMapsApiKey: mapsKey });
    const [mapRef, setMapRef] = useState(null);
    const [selectedSchool, setSelectedSchool] = useState(null);

    // Auto-fit bounds when schools/destination change
    useEffect(() => {
        if (!mapRef || !isLoaded) return;
        const geocodedSchools = schools.filter(s => s.lat != null && s.lon != null);
        if (geocodedSchools.length === 0 && !destination) return;
        const bounds = new window.google.maps.LatLngBounds();
        geocodedSchools.forEach(s => bounds.extend({ lat: s.lat, lng: s.lon }));
        if (destination) bounds.extend({ lat: destination.lat, lng: destination.lon });
        if (!bounds.isEmpty()) mapRef.fitBounds(bounds, 50);
    }, [schools, destination, mapRef, isLoaded]);

    // Focus on segment
    useEffect(() => {
        if (!mapRef || !focusBounds || !isLoaded) return;
        const bounds = new window.google.maps.LatLngBounds();
        focusBounds.forEach(p => bounds.extend({ lat: p[0], lng: p[1] }));
        if (!bounds.isEmpty()) mapRef.fitBounds(bounds, 100);
    }, [focusBounds, mapRef, isLoaded]);

    const makeIcon = (color) => ({
        path: window.google.maps.SymbolPath.CIRCLE,
        fillColor: color,
        fillOpacity: 1,
        strokeColor: '#fff',
        strokeWeight: 2,
        scale: 9,
    });

    const destinationIcon = () => ({
        path: window.google.maps.SymbolPath.CIRCLE,
        fillColor: '#ef4444',
        fillOpacity: 1,
        strokeColor: '#fff',
        strokeWeight: 2,
        scale: 12,
    });

    const getPositions = (routeData) => {
        if (routeData.geometry && routeData.geometry.coordinates) {
            return routeData.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] }));
        }
        return routeData.stops
            .filter(s => s.lat != null && s.lon != null)
            .map(s => ({ lat: s.lat, lng: s.lon }));
    };

    if (!isLoaded) {
        return (
            <div className="h-[600px] w-full rounded-xl overflow-hidden shadow-inner border border-gray-200 flex items-center justify-center bg-gray-50">
                <span className="text-gray-500">Caricamento mappa...</span>
            </div>
        );
    }

    return (
        <div className="h-[600px] w-full rounded-xl overflow-hidden shadow-inner border border-gray-200 relative z-0">
            {highlightedRouteId !== null && onResetFocus && (
                <button
                    onClick={onResetFocus}
                    className="absolute top-3 right-3 z-[1000] bg-white shadow-md rounded-full p-2 hover:bg-gray-100 transition-colors"
                    title="Reimposta vista mappa"
                >
                    <X className="w-5 h-5 text-gray-600" />
                </button>
            )}

            <GoogleMap
                mapContainerStyle={{ height: '100%', width: '100%' }}
                center={{ lat: 46.0697, lng: 11.1211 }}
                zoom={13}
                onLoad={setMapRef}
                options={{
                    mapTypeControl: false,
                    streetViewControl: false,
                    fullscreenControl: false,
                }}
            >
                {destination && (
                    <Marker
                        position={{ lat: destination.lat, lng: destination.lon }}
                        icon={destinationIcon()}
                        onClick={() => setSelectedSchool({ _isDestination: true, ...destination })}
                    />
                )}

                {selectedSchool && selectedSchool._isDestination && (
                    <InfoWindow
                        position={{ lat: selectedSchool.lat, lng: selectedSchool.lon }}
                        onCloseClick={() => setSelectedSchool(null)}
                    >
                        <div className="text-center">
                            <strong className="text-red-600 block text-base mb-1">Destinazione</strong>
                            <span className="text-gray-600 text-sm">{selectedSchool.address}</span>
                        </div>
                    </InfoWindow>
                )}

                {schools.filter(s => s.lat != null && s.lon != null).map((school) => {
                    const color = school.institute
                        ? (instituteColorMap[school.institute] || '#3b82f6')
                        : '#3b82f6';
                    return (
                        <Marker
                            key={school.id}
                            position={{ lat: school.lat, lng: school.lon }}
                            icon={makeIcon(color)}
                            onClick={() => setSelectedSchool(school)}
                        />
                    );
                })}

                {selectedSchool && !selectedSchool._isDestination && (
                    <InfoWindow
                        position={{ lat: selectedSchool.lat, lng: selectedSchool.lon }}
                        onCloseClick={() => setSelectedSchool(null)}
                    >
                        <div className="min-w-[150px]">
                            <strong
                                className="block text-base mb-1 border-b pb-1"
                                style={{ color: selectedSchool.institute ? (instituteColorMap[selectedSchool.institute] || '#3b82f6') : '#3b82f6' }}
                            >
                                {selectedSchool.institute ? `${selectedSchool.institute}` : 'Fermata'}
                            </strong>
                            <div className="font-semibold text-gray-800">{selectedSchool.name}</div>
                            <div className="text-gray-600 text-xs mt-1 mb-2">{selectedSchool.address}</div>
                            <div className="bg-gray-100 text-gray-800 text-xs font-bold px-2 py-1 rounded-full inline-block">
                                {selectedSchool.demand} passeggeri
                            </div>
                        </div>
                    </InfoWindow>
                )}

                {routes && routes.map((route, idx) => {
                    const isHighlighted = highlightedRouteId === route.vehicle_id;
                    const color = COLORS[idx % COLORS.length];
                    const positions = getPositions(route.outbound || route);

                    return (
                        <Polyline
                            key={route.vehicle_id}
                            path={positions}
                            options={{
                                strokeColor: isHighlighted ? '#f97316' : color,
                                strokeWeight: isHighlighted ? 10 : 5,
                                strokeOpacity: isHighlighted ? 1 : (highlightedRouteId !== null ? 0.3 : 0.8),
                            }}
                        />
                    );
                })}

                {focusBounds && (
                    <Polyline
                        path={focusBounds.map(p => ({ lat: p[0], lng: p[1] }))}
                        options={{ strokeColor: '#000000', strokeWeight: 3, strokeOpacity: 0.7, icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 4 }, offset: '0', repeat: '20px' }] }}
                    />
                )}
            </GoogleMap>
        </div>
    );
};

export default Map;
