import React, { useCallback, useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { X, Maximize2, Minimize2, Bus, Users, UserX, Navigation2, Flag, GraduationCap } from 'lucide-react';
import html2canvas from 'html2canvas';
import { buildRouteLanes } from '../utils/routeLanes';

// Vector basemap: OpenFreeMap "Liberty" (OpenStreetMap data, free, no key)
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const DEFAULT_CENTER = [11.1211, 46.0697];
const ANIM_MS = 420;
const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
const HIGHLIGHT_COLOR = '#f97316';

// Must match ROUTE_COLORS in Dashboard.jsx
const COLORS = [
    '#3b82f6', '#ef4444', '#22c55e', '#eab308',
    '#a855f7', '#f97316', '#ec4899', '#14b8a6',
    '#6366f1', '#06b6d4', '#f43f5e', '#84cc16',
    '#8b5cf6', '#f59e0b', '#10b981', '#0ea5e9',
    '#d946ef', '#dc2626', '#16a34a', '#b45309',
    '#7c3aed', '#0d9488', '#ea580c', '#db2777',
    '#65a30d', '#0284c7', '#9333ea', '#c2410c',
    '#0f766e', '#be185d',
];

// Lane width and offset in screen pixels by zoom: routes sharing a road stay
// side by side at every zoom level (see utils/routeLanes.js)
const laneWidth = ['interpolate', ['exponential', 1.4], ['zoom'], 7, 2.2, 11, 3.5, 14, 5.5, 17, 8];
const casingWidth = ['interpolate', ['exponential', 1.4], ['zoom'], 7, 4.7, 11, 6, 14, 8, 17, 10.5];
const glowWidth = ['interpolate', ['exponential', 1.4], ['zoom'], 7, 9, 11, 12, 14, 16, 17, 22];
const laneOffset = ['interpolate', ['exponential', 1.4], ['zoom'],
    7, ['*', ['get', 'slot'], 2.6], 11, ['*', ['get', 'slot'], 4.2], 14, ['*', ['get', 'slot'], 6.6], 17, ['*', ['get', 'slot'], 9.6]];

const EMPTY = { type: 'FeatureCollection', features: [] };

// White chevron repeated along each lane to show the direction
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

function stopPinHtml(color, demand) {
    const fontSize = demand >= 100 ? '9px' : demand >= 10 ? '11px' : '13px';
    return `
        <div class="pin-inner" style="position:relative;width:28px;height:34px;">
            <div style="width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};
                border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;">
                <span class="stop-demand" style="transform:rotate(45deg);color:white;font-size:${fontSize};font-weight:800;line-height:1;font-family:sans-serif;">${Number(demand) || 0}</span>
            </div>
            <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:8px;height:4px;background:rgba(0,0,0,0.15);border-radius:50%;filter:blur(2px);"></div>
        </div>`;
}

function institutePinHtml(color) {
    const icon = renderToStaticMarkup(<GraduationCap style={{ width: 22, height: 22, color: 'white', strokeWidth: 2 }} />);
    return `<div class="pin-inner" style="width:40px;height:40px;border-radius:50%;background:${color};border:3px solid white;
        box-shadow:0 3px 10px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;">${icon}</div>`;
}

const destinationHtml = renderToStaticMarkup(
    <div style={{ position: 'relative', width: 32, height: 32 }}>
        <Flag style={{ width: 32, height: 32, fill: '#ef4444', color: 'white', strokeWidth: 1.5, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' }} />
    </div>
);

function el(html, className = '') {
    const d = document.createElement('div');
    d.className = className;
    d.innerHTML = html;
    return d;
}

// Popup content is rendered by React, so names and addresses are escaped
function stopPopupHtml(school, color) {
    return renderToStaticMarkup(
        <div className="min-w-[150px]">
            <strong className="block text-base mb-1 border-b pb-1" style={{ color }}>{school.institute || 'Fermata'}</strong>
            <div className="font-semibold text-gray-800">{school.name}</div>
            {school.description && <div className="text-gray-500 text-xs italic mt-0.5">{school.description}</div>}
            <div className="text-gray-700 text-sm mt-1">{school.display_address || school.address}</div>
            {school.display_address && school.display_address !== school.address
                ? <div className="text-gray-400 text-[10px] mt-0.5 mb-2 leading-tight">{school.address}</div>
                : <div className="mb-2" />}
            <div className="bg-gray-100 text-gray-800 text-xs font-bold px-2 py-1 rounded-full inline-block">{school.demand} passeggeri</div>
        </div>
    );
}

function boundsOf(schools, destination, routes) {
    const b = new maplibregl.LngLatBounds();
    schools.forEach(s => { if (s.lat != null && s.lon != null) b.extend([s.lon, s.lat]); });
    if (destination) b.extend([destination.lon, destination.lat]);
    (routes || []).forEach(r => ((r.outbound || r).geometry?.coordinates || []).forEach(c => b.extend(c)));
    return b.isEmpty() ? null : b;
}

const BusMap = React.forwardRef(({ schools, routes, destination, focusBounds, highlightedRouteId, onResetFocus, instituteColorMap = {}, fitKey = 0, sizeTrigger = 0 }, ref) => {
    const mapRef = useRef(null);
    const mapDivRef = useRef(null);
    const placeholderRef = useRef(null); // keeps the natural-flow space while fullscreen
    const containerRef = useRef(null);   // the box animated to fullscreen
    const markersRef = useRef([]);
    const [ready, setReady] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [hiddenRouteIds, setHiddenRouteIds] = useState(new Set());
    const [showDemand, setShowDemand] = useState(true);
    const [showArrows, setShowArrows] = useState(false);
    const [flash, setFlash] = useState(null); // vehicle id highlighted for a few seconds after a click
    const flashTimer = useRef(null);

    useEffect(() => { setHiddenRouteIds(new Set()); }, [routes]);

    // --- map setup -------------------------------------------------------
    useEffect(() => {
        const map = new maplibregl.Map({
            container: mapDivRef.current,
            style: MAP_STYLE,
            center: DEFAULT_CENTER,
            zoom: 9,
            attributionControl: false,
            canvasContextAttributes: { preserveDrawingBuffer: true }, // lets the PDF export read the map
        });
        // Attribution starts collapsed (an "i" button) on every screen size
        map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
        map.on('load', () => {
            map.getContainer().querySelectorAll('.maplibregl-compact-show').forEach(n => n.classList.remove('maplibregl-compact-show'));
            map.addImage('chevron', chevronImage(), { pixelRatio: 2 });
            map.addSource('lanes', { type: 'geojson', data: EMPTY });
            map.addSource('focus', { type: 'geojson', data: EMPTY });
            const join = { 'line-join': 'round', 'line-cap': 'round' };
            map.addLayer({ id: 'lane-glow', type: 'line', source: 'lanes', layout: join, filter: ['==', ['get', 'vid'], -1],
                paint: { 'line-color': ['get', 'color'], 'line-width': glowWidth, 'line-offset': laneOffset, 'line-blur': 6, 'line-opacity': 0.55 } });
            map.addLayer({ id: 'lane-casing', type: 'line', source: 'lanes', layout: join,
                paint: { 'line-color': '#ffffff', 'line-width': casingWidth, 'line-offset': laneOffset, 'line-opacity': 0.9 } });
            map.addLayer({ id: 'lane', type: 'line', source: 'lanes', layout: join, filter: ['!', ['get', 'straight']],
                paint: { 'line-color': ['get', 'color'], 'line-width': laneWidth, 'line-offset': laneOffset } });
            map.addLayer({ id: 'lane-straight', type: 'line', source: 'lanes', filter: ['get', 'straight'],
                paint: { 'line-color': ['get', 'color'], 'line-width': laneWidth, 'line-offset': laneOffset, 'line-dasharray': [2, 1.5], 'line-opacity': 0.75 } });
            map.addLayer({ id: 'lane-arrows', type: 'line', source: 'lanes', layout: { 'line-join': 'round', visibility: 'none' },
                paint: { 'line-pattern': 'chevron', 'line-width': laneWidth, 'line-offset': laneOffset } });
            map.addLayer({ id: 'focus', type: 'line', source: 'focus',
                paint: { 'line-color': '#000000', 'line-width': 3, 'line-dasharray': [2, 2], 'line-opacity': 0.7 } });

            const onLane = e => {
                const vid = e.features?.[0]?.properties?.vid;
                if (vid == null) return;
                if (flashTimer.current) clearTimeout(flashTimer.current);
                setFlash(vid);
                flashTimer.current = setTimeout(() => setFlash(null), 5000);
            };
            ['lane', 'lane-straight'].forEach(l => {
                map.on('click', l, onLane);
                map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
                map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
            });
            setReady(true);
        });
        mapRef.current = map;
        // Follow the size of the box (stretched next to the configuration, fullscreen…)
        const ro = new ResizeObserver(() => map.resize());
        ro.observe(mapDivRef.current);
        return () => { ro.disconnect(); if (flashTimer.current) clearTimeout(flashTimer.current); map.remove(); mapRef.current = null; };
    }, []);

    useEffect(() => { if (sizeTrigger > 0) mapRef.current?.resize(); }, [sizeTrigger]);

    // --- routes ----------------------------------------------------------
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map) return;
        const visible = (routes || [])
            .map((r, idx) => ({ ...r, _color: COLORS[idx % COLORS.length] }))
            .filter(r => !hiddenRouteIds.has(r.vehicle_id));
        map.getSource('lanes').setData(buildRouteLanes(visible, COLORS));
    }, [ready, routes, hiddenRouteIds]);

    // Highlight: a route picked in the list (orange) or clicked on the map (glow); the others dim
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map) return;
        const active = flash ?? highlightedRouteId ?? null;
        const dim = v => (active == null ? v : ['case', ['==', ['get', 'vid'], active], 1, 0.22]);
        map.setPaintProperty('lane', 'line-opacity', dim(1));
        map.setPaintProperty('lane-straight', 'line-opacity', dim(0.75));
        map.setPaintProperty('lane-casing', 'line-opacity', dim(0.9));
        map.setPaintProperty('lane-arrows', 'line-opacity', dim(1));
        const orange = flash == null && highlightedRouteId != null;
        const color = orange ? ['case', ['==', ['get', 'vid'], highlightedRouteId], HIGHLIGHT_COLOR, ['get', 'color']] : ['get', 'color'];
        map.setPaintProperty('lane', 'line-color', color);
        map.setPaintProperty('lane-straight', 'line-color', color);
        map.setFilter('lane-glow', ['==', ['get', 'vid'], flash ?? -1]);
    }, [ready, flash, highlightedRouteId]);

    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map) return;
        map.setLayoutProperty('lane-arrows', 'visibility', showArrows ? 'visible' : 'none');
    }, [ready, showArrows]);

    // --- markers ---------------------------------------------------------
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map) return;
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];
        schools.filter(s => s.lat != null && s.lon != null).forEach(school => {
            const color = school.institute ? (instituteColorMap[school.institute] || '#3b82f6') : '#3b82f6';
            const node = el(school.institute ? institutePinHtml(color) : stopPinHtml(color, school.demand), 'busplan-pin');
            const popup = new maplibregl.Popup({ offset: school.institute ? 40 : 34, maxWidth: '280px' }).setHTML(stopPopupHtml(school, color));
            markersRef.current.push(new maplibregl.Marker({ element: node, anchor: 'bottom' }).setLngLat([school.lon, school.lat]).setPopup(popup).addTo(map));
        });
        if (destination) {
            const popup = new maplibregl.Popup({ offset: 30 }).setHTML(renderToStaticMarkup(
                <div className="text-center">
                    <strong className="text-red-600 block text-lg mb-1">Destinazione</strong>
                    <span className="text-gray-600 text-sm">{destination.address}</span>
                </div>
            ));
            const node = el(destinationHtml, 'busplan-pin busplan-dest');
            markersRef.current.push(new maplibregl.Marker({ element: node, anchor: 'bottom-left', offset: [-5, 3] })
                .setLngLat([destination.lon, destination.lat]).setPopup(popup).addTo(map));
        }
    }, [ready, schools, destination, instituteColorMap]);

    // --- view --------------------------------------------------------------
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map) return;
        if (focusBounds && focusBounds.length === 2) {
            const [[lat1, lon1], [lat2, lon2]] = focusBounds;
            map.getSource('focus').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[lon1, lat1], [lon2, lat2]] } });
            map.fitBounds([[Math.min(lon1, lon2), Math.min(lat1, lat2)], [Math.max(lon1, lon2), Math.max(lat1, lat2)]], { padding: 100, maxZoom: 15 });
            return;
        }
        map.getSource('focus').setData(EMPTY);
        const b = boundsOf(schools, destination, null);
        if (b) map.fitBounds(b, { padding: 50, maxZoom: 15 });
    }, [ready, schools, destination, focusBounds, fitKey]);

    // --- export image -------------------------------------------------------
    React.useImperativeHandle(ref, () => ({
        captureScreenshot: async () => {
            const map = mapRef.current;
            const container = containerRef.current;
            if (!map || !container) return null;
            const b = boundsOf(schools, destination, routes);
            try {
                map.triggerRepaint();
                await new Promise(r => map.once('idle', r));
                const scale = window.devicePixelRatio > 1 ? window.devicePixelRatio : 2;
                const full = await html2canvas(container, {
                    useCORS: true,
                    allowTaint: false,
                    scale,
                    backgroundColor: '#f3f4f6',
                    ignoreElements: n => n.classList?.contains('busplan-map-ui') || n.classList?.contains('maplibregl-ctrl-top-left'),
                    onclone: doc => doc.querySelector('.busplan-map')?.classList.add('map-minimal-pins'),
                });
                if (!b) return full.toDataURL('image/jpeg', 0.9);
                const nw = map.project(b.getNorthWest());
                const se = map.project(b.getSouthEast());
                const rect = container.getBoundingClientRect();
                const PAD = 60;
                const minX = Math.max(0, Math.min(nw.x, se.x) - PAD), maxX = Math.min(rect.width, Math.max(nw.x, se.x) + PAD);
                const minY = Math.max(0, Math.min(nw.y, se.y) - PAD), maxY = Math.min(rect.height, Math.max(nw.y, se.y) + PAD);
                const w = maxX - minX, h = maxY - minY;
                if (w <= 0 || h <= 0) return full.toDataURL('image/jpeg', 0.9);
                const crop = document.createElement('canvas');
                crop.width = w * scale; crop.height = h * scale;
                crop.getContext('2d').drawImage(full, minX * scale, minY * scale, w * scale, h * scale, 0, 0, w * scale, h * scale);
                return crop.toDataURL('image/jpeg', 0.95);
            } catch (err) {
                console.error('Screenshot capture failed:', err);
                return null;
            }
        },
    }));

    // --- fullscreen (FLIP animation of the box) ----------------------------
    const enterFullscreen = useCallback(() => {
        const placeholder = placeholderRef.current, container = containerRef.current;
        if (!placeholder || !container) return;
        const rect = placeholder.getBoundingClientRect();
        Object.assign(container.style, {
            position: 'fixed', top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px`,
            borderRadius: '12px', zIndex: '9999', margin: '0', transition: 'none',
        });
        container.getBoundingClientRect();
        Object.assign(container.style, {
            transition: `top ${ANIM_MS}ms ${EASING}, left ${ANIM_MS}ms ${EASING}, width ${ANIM_MS}ms ${EASING}, height ${ANIM_MS}ms ${EASING}, border-radius ${ANIM_MS}ms ${EASING}`,
            top: '0', left: '0', width: '100vw', height: '100vh', borderRadius: '0',
        });
        setIsFullscreen(true);
    }, []);

    const exitFullscreen = useCallback(() => {
        const placeholder = placeholderRef.current, container = containerRef.current;
        if (!placeholder || !container) return;
        const rect = placeholder.getBoundingClientRect();
        Object.assign(container.style, {
            transition: `top ${ANIM_MS}ms ${EASING}, left ${ANIM_MS}ms ${EASING}, width ${ANIM_MS}ms ${EASING}, height ${ANIM_MS}ms ${EASING}, border-radius ${ANIM_MS}ms ${EASING}`,
            top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: '12px',
        });
        setTimeout(() => {
            Object.assign(container.style, { position: '', top: '', left: '', width: '', height: '', borderRadius: '', zIndex: '', transition: '' });
            setIsFullscreen(false);
        }, ANIM_MS);
    }, []);

    useEffect(() => {
        const onKey = e => { if (e.key === 'Escape' && isFullscreen) exitFullscreen(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isFullscreen, exitFullscreen]);

    return (
        <div ref={placeholderRef} className="w-full h-full rounded-xl">
            <style>{`
                .busplan-pin { cursor: pointer; }
                .busplan-dest { z-index: 2; }
                .pin-inner { transition: transform 0.4s cubic-bezier(0.4,0,0.2,1); transform-origin: 50% 100%; }
                .stop-demand { transition: opacity 0.2s ease; }
                .map-minimal-pins .pin-inner { transform: scale(0.5); }
                .map-minimal-pins .stop-demand { opacity: 0; }
                .busplan-map .maplibregl-popup-content { border-radius: 10px; padding: 10px 12px; box-shadow: 0 6px 20px rgba(0,0,0,.15); }
            `}</style>
            <div
                ref={containerRef}
                className={`busplan-map w-full h-full rounded-xl overflow-hidden border border-gray-200 relative z-0 bg-gray-100${showDemand ? '' : ' map-minimal-pins'}`}
            >
                <div ref={mapDivRef} className="absolute inset-0" />

                {/* Bus toggles — bottom-left */}
                {routes && routes.length > 0 && (
                    <div className="busplan-map-ui absolute bottom-3 left-3 z-10 flex flex-col gap-1">
                        {routes.map((route, idx) => {
                            const color = COLORS[idx % COLORS.length];
                            const hidden = hiddenRouteIds.has(route.vehicle_id);
                            return (
                                <button
                                    key={route.vehicle_id}
                                    onClick={() => setHiddenRouteIds(prev => {
                                        const next = new Set(prev);
                                        if (hidden) next.delete(route.vehicle_id); else next.add(route.vehicle_id);
                                        return next;
                                    })}
                                    className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium shadow-md bg-white transition-opacity"
                                    style={{ borderLeft: `4px solid ${color}`, opacity: hidden ? 0.45 : 1 }}
                                >
                                    <Bus size={12} style={{ color }} />
                                    <span style={{ color: hidden ? '#9ca3af' : '#1f2937' }}>Bus {route.vehicle_id + 1}</span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Top-right buttons */}
                <div className="busplan-map-ui absolute top-3 right-3 z-10 flex items-center gap-1.5">
                    <button onClick={() => setShowArrows(v => !v)}
                        className={`shadow-md rounded-full p-2 transition-colors ${showArrows ? 'bg-blue-600 hover:bg-blue-700' : 'bg-white hover:bg-gray-100'}`}
                        title={showArrows ? 'Nascondi direzione percorso' : 'Mostra direzione percorso'}>
                        <Navigation2 className={`w-4 h-4 ${showArrows ? 'text-white' : 'text-gray-400'}`} />
                    </button>
                    <button onClick={() => setShowDemand(v => !v)} className="bg-white shadow-md rounded-full p-2 hover:bg-gray-100 transition-colors"
                        title={showDemand ? 'Nascondi partecipanti' : 'Mostra partecipanti'}>
                        {showDemand ? <Users className="w-4 h-4 text-gray-600" /> : <UserX className="w-4 h-4 text-gray-400" />}
                    </button>
                    {highlightedRouteId !== null && highlightedRouteId !== undefined && onResetFocus && (
                        <button onClick={onResetFocus} className="bg-white shadow-md rounded-full p-2 hover:bg-gray-100 transition-colors" title="Reimposta vista mappa">
                            <X className="w-4 h-4 text-gray-600" />
                        </button>
                    )}
                    <button onClick={() => (isFullscreen ? exitFullscreen() : enterFullscreen())}
                        className="bg-white shadow-md rounded-full p-2 hover:bg-gray-100 transition-colors"
                        title={isFullscreen ? 'Esci da schermo intero' : 'Schermo intero'}>
                        {isFullscreen ? <Minimize2 className="w-4 h-4 text-gray-600" /> : <Maximize2 className="w-4 h-4 text-gray-600" />}
                    </button>
                </div>
            </div>
        </div>
    );
});

export default BusMap;
