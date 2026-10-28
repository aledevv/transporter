// Parse and sanitize "lat, lon" pairs as people paste them (mostly from Google Maps).
//
// Accepted inputs:
//   "46.0697, 11.1211"            Google Maps copy
//   "46,0697; 11,1211"            Italian decimal comma, semicolon separator
//   "46.0697 11.1211", "(46.0697, 11.1211)", "lat 46.0697 lon 11.1211"
//   numbers as two separate cells: parseCoordinates(46.0697, 11.1211)
//
// Returns { ok: true, lat, lon, swapped, warning } or { ok: false, error }.

// Generous box around Trentino and the neighbouring valleys the buses reach
// (Belluno, Verona, Brescia, Bolzano borders).
export const SERVICE_AREA = { minLat: 45.4, maxLat: 46.9, minLon: 10.2, maxLon: 12.3 };

// Coordinates the backend used as "geocoding failed" fallback (Trento centre)
const FALLBACK = [46.0697, 11.1211];

function toNumber(token) {
    if (typeof token === 'number') return token;
    const t = String(token).trim().replace(/[°\s]/g, '');
    if (!/^[-+]?\d+([.,]\d+)?$/.test(t)) return NaN;
    return parseFloat(t.replace(',', '.'));
}

function splitPair(raw) {
    const s = String(raw).trim().replace(/^[([{]|[)\]}]$/g, '').replace(/\b(lat|lon|lng|latitudine|longitudine)\b[:=]?/gi, ' ');
    // "46.07, 11.12" or "46.07,11.12" or "46.07; 11.12"
    let m = s.match(/^\s*([-+]?\d+(?:\.\d+)?)\s*[,;]\s*([-+]?\d+(?:\.\d+)?)\s*$/);
    if (m) return [m[1], m[2]];
    // Decimal comma: "46,07; 11,12" or "46,07 11,12"
    m = s.match(/^\s*([-+]?\d+(?:,\d+)?)\s*[;\s]\s*([-+]?\d+(?:,\d+)?)\s*$/);
    if (m) return [m[1], m[2]];
    // Space separated with dots: "46.07 11.12"
    m = s.match(/^\s*([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)\s*$/);
    if (m) return [m[1], m[2]];
    return null;
}

function inArea(lat, lon) {
    const a = SERVICE_AREA;
    return lat >= a.minLat && lat <= a.maxLat && lon >= a.minLon && lon <= a.maxLon;
}

export function parseCoordinates(raw, rawLon) {
    let latTok, lonTok;
    if (rawLon !== undefined && rawLon !== null && rawLon !== '') {
        latTok = raw; lonTok = rawLon;
    } else {
        if (raw === undefined || raw === null || String(raw).trim() === '') {
            return { ok: false, error: 'Coordinate mancanti' };
        }
        const pair = splitPair(raw);
        if (!pair) return { ok: false, error: 'Formato non valido (usa "lat, lon")' };
        [latTok, lonTok] = pair;
    }

    let lat = toNumber(latTok);
    let lon = toNumber(lonTok);
    if (isNaN(lat) || isNaN(lon)) return { ok: false, error: 'Formato non valido (usa "lat, lon")' };
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, error: 'Coordinate impossibili' };

    let swapped = false;
    if (!inArea(lat, lon) && inArea(lon, lat)) {
        [lat, lon] = [lon, lat];
        swapped = true;
    }
    if (!inArea(lat, lon)) return { ok: false, error: 'Fuori dalla zona servita' };
    if (Math.abs(lat - FALLBACK[0]) < 1e-4 && Math.abs(lon - FALLBACK[1]) < 1e-4) {
        return { ok: false, error: 'Centro di Trento (segnaposto)' };
    }

    return { ok: true, lat, lon, swapped, warning: swapped ? 'Lat e lon erano invertite' : null };
}

export function formatCoordinates(lat, lon) {
    return `${lat}, ${lon}`;
}
