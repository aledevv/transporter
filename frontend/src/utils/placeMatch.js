import { normalizeForCompare } from './matchInstitutes.js';

// Same idea as the Database tab's Istituti / Destinazioni split, plus the school
// abbreviations that tab misses (IS, ENAIP, ITET...)
const SCHOOL_RE = /\b(ic|is|iis|isis|itet|itt|ite|itis|ipss|cfp|enaip|istituto|scuola|liceo|polo|primaria|secondaria|sspg|ss1g)\b/i;

export function isSchoolEntry(entry) {
    if (entry.type === 'destinazione') return false;
    if (entry.type === 'istituto') return true;
    return SCHOOL_RE.test(entry.name || '');
}

/**
 * Places that make sense as a trip destination: database entries that are not
 * schools, plus the destinations of saved trips (most recent first, once each).
 */
export function destinationPlaces(institutes = [], trips = []) {
    const fromTrips = [];
    const seen = new Set();
    trips.forEach(t => {
        const lat = t.destCoords?.lat, lon = t.destCoords?.lon;
        if (!t.destination || lat == null || lon == null) return;
        const name = t.destination.split(',')[0].trim();
        const key = normalizeForCompare(t.destination);
        if (seen.has(key)) return;
        seen.add(key);
        fromTrips.push({ id: `trip-${t.id}`, name, description: t.destination.split(',').slice(1, 3).join(',').trim(), lat, lon, type: 'destinazione' });
    });
    return [...fromTrips, ...institutes.filter(i => !isSchoolEntry(i))];
}

const words = text => normalizeForCompare(text).split(' ').filter(Boolean);

/**
 * Places matching what's typed, only on a real match: every typed word of 3+
 * letters starts a word of the name or street, or the name starts with the
 * whole query. No loose substring matches.
 */
export function matchLocalPlaces(query, places, max = 3) {
    const q = normalizeForCompare(query);
    const typed = words(query).filter(w => w.length >= 3);
    if (!q || (!typed.length && q.length < 3) || !places?.length) return [];
    return places
        .filter(p => p.lat != null && p.lon != null)
        .map(p => {
            const name = normalizeForCompare(p.name);
            const all = [...words(p.name), ...words(p.description || ''), ...words(p.address || '')];
            const nameStarts = name.startsWith(q);
            const allWords = typed.length > 0 && typed.every(t => all.some(w => w.startsWith(t)));
            if (!nameStarts && !allWords) return null;
            return { p, score: (nameStarts ? 2 : 0) + (p.type === 'destinazione' ? 1 : 0) };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map(({ p }) => ({
            place_id: `db_${p.id}`,
            description: p.name,
            structured_formatting: { main_text: p.name, secondary_text: p.description || p.address || '' },
            types: ['database'],
            source: 'database',
            lat: Number(p.lat),
            lon: Number(p.lon),
        }));
}
