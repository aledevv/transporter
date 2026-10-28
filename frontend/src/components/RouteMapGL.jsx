import React, { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../utils/maplibreWorker';
import { buildRouteLanes, buildStops } from '../utils/routeLanes';

export const ROUTE_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#4f46e5'];

// Pixel width of one lane at a zoom level; offsets are multiples of it
const laneWidth = ['interpolate', ['exponential', 1.4], ['zoom'], 7, 2.2, 11, 3.5, 14, 5.5, 17, 8];
const casingWidth = ['interpolate', ['exponential', 1.4], ['zoom'], 7, 4.7, 11, 6, 14, 8, 17, 10.5];
const laneOffset = ['interpolate', ['exponential', 1.4], ['zoom'],
    7, ['*', ['get', 'slot'], 2.6], 11, ['*', ['get', 'slot'], 4.2], 14, ['*', ['get', 'slot'], 6.6], 17, ['*', ['get', 'slot'], 9.6]];

// White chevron used as a repeating pattern on top of each lane: shows the direction
function chevronImage(size = 24) {
    const c = document.createElement('canvas');
    c.width = size * 2; c.height = size;
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = size * 0.16;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(size * 0.75, size * 0.28); g.lineTo(size * 1.05, size * 0.5); g.lineTo(size * 0.75, size * 0.72);
    g.stroke();
    return g.getImageData(0, 0, c.width, c.height);
}

/**
 * Routes on a vector (MapLibre) map: shared roads are drawn as parallel lanes
 * offset in screen pixels, so they stay aligned at any zoom; white casing,
 * direction chevrons, hover to highlight one bus.
 */
export default function RouteMapGL({ routes, destCoords, styleUrl, className = '', onReady }) {
    const ref = useRef(null);

    useEffect(() => {
        const map = new maplibregl.Map({
            container: ref.current,
            style: styleUrl,
            center: destCoords ? [destCoords.lon, destCoords.lat] : [11.12, 46.07],
            zoom: 9,
            attributionControl: { compact: true },
            // Lets screenshots / PDF export read the canvas
            canvasContextAttributes: { preserveDrawingBuffer: true },
        });
        map.on('error', e => console.warn('[RouteMapGL]', e.error?.message || e));
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

        map.on('load', () => {
            const lanes = buildRouteLanes(routes, ROUTE_COLORS);
            const stops = buildStops(routes, ROUTE_COLORS);
            map.addImage('chevron', chevronImage(), { pixelRatio: 2 });
            map.addSource('lanes', { type: 'geojson', data: lanes });
            map.addSource('stops', { type: 'geojson', data: stops });

            const join = { 'line-join': 'round', 'line-cap': 'round' };
            map.addLayer({ id: 'lane-casing', type: 'line', source: 'lanes', layout: join,
                paint: { 'line-color': '#ffffff', 'line-width': casingWidth, 'line-offset': laneOffset, 'line-opacity': 0.9 } });
            map.addLayer({ id: 'lane', type: 'line', source: 'lanes', layout: join,
                paint: { 'line-color': ['get', 'color'], 'line-width': laneWidth, 'line-offset': laneOffset } });
            map.addLayer({ id: 'lane-arrows', type: 'line', source: 'lanes', minzoom: 11, layout: { 'line-join': 'round' },
                paint: { 'line-pattern': 'chevron', 'line-width': laneWidth, 'line-offset': laneOffset } });
            map.addLayer({ id: 'stop', type: 'circle', source: 'stops', filter: ['==', ['get', 'type'], 'pickup'],
                paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 14, 7], 'circle-color': '#ffffff',
                    'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 3] } });
            map.addLayer({ id: 'dest', type: 'circle', source: 'stops', filter: ['==', ['get', 'type'], 'destination'],
                paint: { 'circle-radius': 8, 'circle-color': '#111827', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });

            // Highlight: dim the other buses while one is hovered
            const setHl = v => {
                ['lane', 'lane-casing', 'lane-arrows'].forEach(l => map.setPaintProperty(l, 'line-opacity',
                    v == null ? (l === 'lane-casing' ? 0.9 : 1) : ['case', ['==', ['get', 'vid'], v], 1, 0.12]));
            };
            map.on('mousemove', 'lane', e => { map.getCanvas().style.cursor = 'pointer'; setHl(e.features[0].properties.vid); });
            map.on('mouseleave', 'lane', () => { map.getCanvas().style.cursor = ''; setHl(null); });

            const b = new maplibregl.LngLatBounds();
            lanes.features.forEach(f => f.geometry.coordinates.forEach(c => b.extend(c)));
            if (!b.isEmpty()) map.fitBounds(b, { padding: 40, duration: 0 });
            onReady?.(map);
        });
        return () => map.remove();
    }, [routes, destCoords, styleUrl]); // eslint-disable-line react-hooks/exhaustive-deps

    return <div ref={ref} className={className} />;
}
