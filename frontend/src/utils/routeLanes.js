// Splits bus routes into "lanes" so routes that share a road are drawn side by
// side instead of on top of each other.
//
// Every road segment (two consecutive route points) gets the sorted list of
// buses that use it; each bus takes a slot in that list (centred on 0). Slots
// are signed against the segment's canonical direction, so two buses driving
// the same road in opposite directions still keep their own side. Consecutive
// segments with the same slot become one feature.
//
// The slot is turned into a pixel offset by the map style (line-offset), so it
// stays right at every zoom level: nothing is recomputed while zooming.

const keyOf = c => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;

// Points of a route: the road geometry, or straight lines between the stops
// when the router gave none (drawn dashed)
function routeCoords(r) {
    const geom = (r.outbound || r).geometry?.coordinates;
    if (geom?.length >= 2) return { coords: geom, straight: false };
    const stops = ((r.outbound || r).stops || []).filter(s => s.lat != null && s.lon != null);
    return { coords: stops.map(s => [Number(s.lon), Number(s.lat)]), straight: true };
}

export function buildRouteLanes(routes, colors) {
    const edges = new Map(); // canonical edge key -> Set(vehicle ids)
    const prepared = routes.map(r => {
        const { coords, straight } = routeCoords(r);
        return { id: r.vehicle_id, color: r._color, straight, coords: coords.filter((c, i, a) => i === 0 || keyOf(c) !== keyOf(a[i - 1])) };
    });

    prepared.forEach(({ id, coords }) => {
        for (let i = 0; i < coords.length - 1; i++) {
            const a = keyOf(coords[i]), b = keyOf(coords[i + 1]);
            const k = a < b ? `${a}|${b}` : `${b}|${a}`;
            if (!edges.has(k)) edges.set(k, new Set());
            edges.get(k).add(id);
        }
    });

    const features = [];
    prepared.forEach(({ id, coords, color: own, straight }, routeIdx) => {
        const color = own || colors[routeIdx % colors.length];
        let current = null;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = keyOf(coords[i]), b = keyOf(coords[i + 1]);
            const forward = a < b;
            const users = [...edges.get(forward ? `${a}|${b}` : `${b}|${a}`)].sort((x, y) => x - y);
            const slot = (users.indexOf(id) - (users.length - 1) / 2) * (forward ? 1 : -1);
            if (!current || current.properties.slot !== slot) {
                current = {
                    type: 'Feature',
                    properties: { vid: id, color, slot, shared: users.length, straight },
                    geometry: { type: 'LineString', coordinates: [coords[i]] },
                };
                features.push(current);
            }
            current.geometry.coordinates.push(coords[i + 1]);
        }
    });

    return { type: 'FeatureCollection', features };
}

// Stops of every route as points (pickup / destination)
export function buildStops(routes, colors) {
    const features = [];
    routes.forEach((r, idx) => {
        ((r.outbound || r).stops || []).forEach((s, n) => {
            if (s.lat == null || s.lon == null) return;
            features.push({
                type: 'Feature',
                properties: { vid: r.vehicle_id, color: colors[idx % colors.length], type: s.type, name: s.name || '', order: n + 1 },
                geometry: { type: 'Point', coordinates: [Number(s.lon), Number(s.lat)] },
            });
        });
    });
    return { type: 'FeatureCollection', features };
}
