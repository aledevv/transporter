import React, { useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { addCollapsedAttribution } from '../utils/mapAttribution';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Database tab map: every place as a dot (drawn by the GPU, fine with hundreds),
 * the selected one bigger and blue. Clicking a dot selects it and opens its popup.
 * Frames the places shown in the list (refits when the tab or search changes); flies to the selected one.
 */
export default function PointsMapGL({ points, selectedIndex, onSelect, fitKey = '' }) {
    const divRef = useRef(null);
    const mapRef = useRef(null);
    const popupRef = useRef(null);
    const fittedKeyRef = useRef(null);
    const pointsRef = useRef(points);
    const onSelectRef = useRef(onSelect);
    const [ready, setReady] = useState(false);
    pointsRef.current = points;
    onSelectRef.current = onSelect;

    useEffect(() => {
        const map = new maplibregl.Map({ container: divRef.current, style: MAP_STYLE, center: [11.12, 46.07], zoom: 8, attributionControl: false });
        map.on('error', e => console.warn('[PointsMapGL]', e.error?.message || e));
        addCollapsedAttribution(map);
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
        map.on('load', () => {
            map.addSource('places', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({ id: 'places', type: 'circle', source: 'places', paint: {
                // zoom must be the outer expression: the selected dot is bigger at every zoom
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, ['case', ['get', 'selected'], 8, 4], 13, ['case', ['get', 'selected'], 10, 6.5]],
                'circle-color': ['case', ['get', 'selected'], '#3b82f6', '#6b7280'],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': ['case', ['get', 'selected'], 3, 1.5],
            } });
            map.on('click', 'places', e => {
                const i = e.features?.[0]?.properties?.i;
                if (i != null) onSelectRef.current?.(pointsRef.current[i], i);
            });
            map.on('mouseenter', 'places', () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', 'places', () => { map.getCanvas().style.cursor = ''; });
            setReady(true);
        });
        const ro = new ResizeObserver(() => map.resize());
        ro.observe(divRef.current);
        mapRef.current = map;
        return () => { ro.disconnect(); map.remove(); mapRef.current = null; };
    }, []);

    // Dots; the selected one last so it's drawn on top
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map) return;
        const features = points
            .map((p, i) => ({ p, i }))
            .filter(({ p }) => p.lat != null && p.lon != null)
            .map(({ p, i }) => ({ type: 'Feature', properties: { i, selected: i === selectedIndex }, geometry: { type: 'Point', coordinates: [Number(p.lon), Number(p.lat)] } }))
            .sort((a, b) => Number(a.properties.selected) - Number(b.properties.selected));
        map.getSource('places').setData({ type: 'FeatureCollection', features });
        // Frame the dots when the list changes (tab, search), not on every selection
        if (fittedKeyRef.current !== fitKey && features.length) {
            const b = new maplibregl.LngLatBounds();
            features.forEach(f => b.extend(f.geometry.coordinates));
            map.fitBounds(b, { padding: 40, maxZoom: 14, duration: fittedKeyRef.current == null ? 0 : 500 });
            fittedKeyRef.current = fitKey;
        }
    }, [ready, points, selectedIndex, fitKey]);

    // Fly to the selected place and show its popup
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map) return;
        popupRef.current?.remove();
        const p = selectedIndex != null ? points[selectedIndex] : null;
        if (!p || p.lat == null || p.lon == null) return;
        map.flyTo({ center: [Number(p.lon), Number(p.lat)], zoom: Math.max(map.getZoom(), 13), duration: 700 });
        popupRef.current = new maplibregl.Popup({ offset: 12, maxWidth: '260px' })
            .setLngLat([Number(p.lon), Number(p.lat)])
            .setHTML(renderToStaticMarkup(
                <div>
                    <strong>{p.name}</strong><br />{p.address}
                    {p.fixture_count > 1 && <><br /><span style={{ color: '#6b7280', fontSize: '0.75em' }}>×{p.fixture_count} eventi</span></>}
                </div>
            ))
            .addTo(map);
    }, [ready, selectedIndex]); // eslint-disable-line react-hooks/exhaustive-deps

    return <div ref={divRef} className="h-full w-full" />;
}
