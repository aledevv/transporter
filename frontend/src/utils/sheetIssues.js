import { findCandidates, normalizeForCompare } from './matchInstitutes.js';
import { parseCoordinates } from './coordinates.js';

// An issue points at one cell of the sheet:
//   { row, col, severity: 'error' | 'warning', message }
// fix: 'number' -> fixed by typing the value in the cell's tag (no dataset lookup)
// error   -> must be resolved before confirming
// warning -> pre-resolved with the best guess, shown so the user can check it

// Finds the column whose header matches one of the names (case/accent-insensitive)
export function findColumn(columns, names) {
    const wanted = names.map(normalizeForCompare);
    return columns.find(c => wanted.includes(normalizeForCompare(c))) ||
        columns.find(c => wanted.some(w => normalizeForCompare(c).startsWith(w))) || null;
}

/**
 * Trip sheet (Nome / Indirizzo / Partecipanti): every stop must map to a
 * dataset entry, which gives it its coordinates.
 * Returns { issues, resolutions } where resolutions[row] is the preselected
 * dataset entry for rows matched with confidence.
 */
// Same words the backend used to mark stops that don't need the bus
const AUTONOMOUS_RE = /\b(autonomo|autonomi|autonomia|per conto loro|mezzi propri|con genitori|in proprio|no pullman|senza pullman)\b/i;

// Trip sheets keep the format read by data_loader.py: Nome / Indirizzo /
// Partecipanti (+ optional Istituto), with the same header aliases
export const TRIP_COLUMNS = {
    name: ['Nome', 'Nome Scuola', 'Istituto Scolastico'],
    address: ['Indirizzo', 'Indirizzi', 'Indirizzo di ritiro'],
    pax: ['Partecipanti', 'Passeggeri', 'Num Partecipanti'],
    institute: ['Istituto', 'Istituzione'],
};

// Participants as the backend read them: digits only, so "18 alunni" -> 18
export function parsePax(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : NaN;
    const digits = String(value ?? '').replace(/\D/g, '');
    return digits ? parseInt(digits, 10) : NaN;
}

/**
 * Trip sheet (Nome / Indirizzo / Partecipanti): every stop must map to a
 * dataset entry, which gives it its coordinates.
 * Returns { issues, resolutions, candidatesByRow, nameCol, addrCol, paxCol, instCol }
 * where resolutions[row] is the preselection (a sure dataset match, or 'skip'
 * for stops that travel on their own).
 */
export function analyzeTripRows(rows, columns, institutes) {
    const nameCol = findColumn(columns, TRIP_COLUMNS.name);
    const addrCol = findColumn(columns, TRIP_COLUMNS.address);
    const paxCol = findColumn(columns, TRIP_COLUMNS.pax);
    const instCol = [findColumn(columns.filter(c => c !== nameCol), TRIP_COLUMNS.institute)].find(Boolean) || null;
    const issues = [];
    const resolutions = {};
    const candidatesByRow = {};

    if (!nameCol || !addrCol || !paxCol) {
        const missing = [!nameCol && 'Nome', !addrCol && 'Indirizzo', !paxCol && 'Partecipanti'].filter(Boolean);
        return { issues: [], resolutions, candidatesByRow, nameCol, addrCol, paxCol, instCol, missingColumns: missing };
    }

    // Like data_loader.py: the table ends at the first row with no name, address or participants
    const end = rows.findIndex(r => [nameCol, addrCol, paxCol].every(c => String(r[c] ?? '').trim() === ''));
    const tableRows = end === -1 ? rows.length : end;

    rows.forEach((r, row) => {
        if (row >= tableRows) {
            resolutions[row] = { type: 'skip' };
            return;
        }
        const name = String(r[nameCol] ?? '').trim();
        const address = String(r[addrCol] ?? '').trim();

        if (!name) {
            issues.push({ row, col: nameCol, severity: 'error', message: 'Nome mancante' });
            return;
        }
        if (AUTONOMOUS_RE.test(`${name} ${address}`)) {
            issues.push({ row, col: addrCol, severity: 'warning', message: 'Va in autonomia: esclusa dal viaggio' });
            resolutions[row] = { type: 'skip' };
            return;
        }
        const pax = parsePax(r[paxCol]);
        if (isNaN(pax) || pax <= 0) {
            issues.push({ row, col: paxCol, severity: 'error', message: 'Partecipanti mancanti', fix: 'number' });
        }

        const candidates = findCandidates({ name, address }, institutes, { maxCandidates: 8, threshold: 0.3 });
        candidatesByRow[row] = candidates;
        const [best, second] = candidates;

        if (!best) {
            issues.push({ row, col: addrCol, severity: 'error', message: 'Fermata non presente nel database' });
            return;
        }
        const tie = second && second._matchScore >= 0.5 && best._rawScore - second._rawScore < 0.05;
        if (tie) {
            issues.push({ row, col: addrCol, severity: 'error', message: `Più fermate possibili (${candidates.filter(c => best._rawScore - c._rawScore < 0.05).length})` });
            return;
        }
        if (best._matchScore < 0.75) {
            issues.push({ row, col: addrCol, severity: 'warning', message: `Abbinamento incerto: ${best.name}` });
        }
        resolutions[row] = { type: 'db', entry: best };
    });

    // The review shows only the columns the planner reads (the file may carry contacts and notes)
    const shownColumns = [nameCol, addrCol, paxCol, instCol].filter(Boolean);
    return { issues, resolutions, candidatesByRow, nameCol, addrCol, paxCol, instCol, shownColumns, tableRows };
}

/**
 * Turns the reviewed trip sheet into what /api/start-processing expects:
 * raw_schools (one per kept row, id = row index) and resolutions with the
 * coordinates of the chosen dataset entry (or of the new stop).
 * Also returns the new stops to add to the dataset.
 */
export function buildTripPayload(rows, analysis, resolutions, edits = {}) {
    const { nameCol, addrCol, paxCol, instCol } = analysis;
    const rawSchools = [];
    const backendResolutions = {};
    const newStops = [];

    rows.forEach((r, row) => {
        const res = resolutions[row];
        if (!res || res.type === 'skip') return;
        const name = String(r[nameCol] ?? '').trim();
        const address = String(r[addrCol] ?? '').trim();
        const edited = edits[`${row}|${paxCol}`];
        const demand = parsePax(edited !== undefined && edited !== '' ? edited : r[paxCol]);
        rawSchools.push({
            id: row,
            name,
            address,
            original_address: address,
            display_address: address,
            demand: isNaN(demand) ? 0 : demand,
            institute: instCol && String(r[instCol] ?? '').trim() ? String(r[instCol]).trim() : null,
            is_autonomous: false,
        });
        if (res.type === 'db') {
            const e = res.entry;
            backendResolutions[row] = {
                lat: Number(e.lat), lon: Number(e.lon),
                address: e.address, name: e.name, docId: e.id,
                display_address: e.description || e.address,
            };
        } else if (res.type === 'new') {
            backendResolutions[row] = {
                lat: res.lat, lon: res.lon, address: res.address, name: res.name,
                display_address: res.address,
            };
            newStops.push({ row, excelName: name, name: res.name, address: res.address, lat: res.lat, lon: res.lon });
        }
    });

    return { rawSchools, resolutions: backendResolutions, newStops };
}

/**
 * Dataset sheet (Nome / Indirizzo da mostrare / Coordinate): coordinates are sanitized, rows
 * without a name, a street or usable coordinates are flagged.
 * Returns { issues, parsed } where parsed[row] = { name, address, lat, lon } for valid rows.
 */
export function analyzeDatasetRows(rows, columns) {
    const nameCol = findColumn(columns, ['Nome', 'Nome fermata', 'Istituto', 'Istituto / Fermata', 'Fermata']);
    const addrCol = findColumn(columns, ['Indirizzo da mostrare', 'Via', 'Indirizzo']);
    const coordCol = findColumn(columns, ['Coordinate', 'Coordinate (lat, lon)', 'Coord']);
    // A separate town column is joined to the street: "Rovereto" + "Corso Bettini 67"
    const locCol = findColumn(columns, ['Località', 'Localita', 'Comune', 'Paese']);
    const latCol = !coordCol && findColumn(columns, ['Lat', 'Latitudine']);
    const lonCol = !coordCol && findColumn(columns, ['Lon', 'Lng', 'Longitudine']);
    const issues = [];
    const parsed = {};
    const seen = new Map();

    rows.forEach((r, row) => {
        const name = String(r[nameCol] ?? '').trim();
        const street = String(r[addrCol] ?? '').trim();
        const town = locCol ? String(r[locCol] ?? '').trim() : '';
        const address = town && street && !normalizeForCompare(street).includes(normalizeForCompare(town)) ? `${town}, ${street}` : street;
        if (!name && !street && !(coordCol ? r[coordCol] : r[latCol])) return; // blank line
        let ok = true;
        if (!name) { issues.push({ row, col: nameCol, severity: 'error', message: 'Nome mancante' }); ok = false; }
        if (!street) { issues.push({ row, col: addrCol, severity: 'error', message: 'Indirizzo da mostrare mancante' }); ok = false; }

        const c = coordCol ? parseCoordinates(r[coordCol]) : parseCoordinates(r[latCol], r[lonCol]);
        const cCol = coordCol || latCol;
        if (!c.ok) {
            issues.push({ row, col: cCol, severity: 'error', message: c.error });
            ok = false;
        } else if (c.warning) {
            issues.push({ row, col: cCol, severity: 'warning', message: `${c.warning}: corrette` });
        }

        const key = `${normalizeForCompare(name)}|${normalizeStreet(address)}`;
        if (name && address && seen.has(key)) {
            issues.push({ row, col: nameCol, severity: 'warning', message: `Doppione della riga ${seen.get(key) + 2}` });
        } else {
            seen.set(key, row);
        }
        if (ok) parsed[row] = { name, address, lat: c.lat, lon: c.lon };
    });

    // Street as it will be saved (town column joined), for the correction panel
    const rowAddress = r => {
        const street = String(r[addrCol] ?? '').trim();
        const town = locCol ? String(r[locCol] ?? '').trim() : '';
        return town && street && !normalizeForCompare(street).includes(normalizeForCompare(town)) ? `${town}, ${street}` : street;
    };

    return { issues, parsed, nameCol, addrCol, coordCol: coordCol || latCol, rowAddress };
}

// Street abbreviations written in different ways by different people
const STREET_ABBREVIATIONS = [
    [/\bv\.?\s*le\b\.?/g, 'viale'], [/\bvle\b\.?/g, 'viale'],
    [/\bp\.?\s*zza\b\.?/g, 'piazza'], [/\bp\.?\s*za\b\.?/g, 'piazza'], [/\bpza\b\.?/g, 'piazza'],
    [/\bp\.?\s*le\b\.?/g, 'piazzale'], [/\bp\.?\s*zzale\b\.?/g, 'piazzale'],
    [/\bc\.?\s*so\b\.?/g, 'corso'], [/\bloc\b\.?/g, 'localita'], [/\bfraz\b\.?/g, 'frazione'],
    [/\bv\.(?=\s)/g, 'via'], [/\bn\.\s*(?=\d)/g, ''], [/\bnr?\s+(?=\d)/g, ''],
];

// Name / street as compared by the import: case, accents, spaces, punctuation
// and the usual abbreviations don't make two entries different
export function normalizeStreet(text) {
    let t = String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    STREET_ABBREVIATIONS.forEach(([re, rep]) => { t = t.replace(re, rep); });
    return normalizeForCompare(t);
}

function metersBetween(a, b) {
    const R = 6371000, toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Same place when the name matches and the street matches, or the point is within 30 m
const SAME_PLACE_METERS = 30;

/**
 * Compares the imported dataset rows with the institutes in Firestore, so the
 * same file can be imported again and again without creating duplicates.
 * The import never deletes: entries missing from the file are left alone.
 *   added     -> no entry with the same name and (same street or within 30 m)
 *   changed   -> same entry, but the street text or the coordinates (more than 1 m) differ
 *   unchanged -> everything else
 * Rows repeated in the file count once.
 */
export function diffDataset(parsedRows, institutes) {
    const existing = institutes.map(i => ({
        entry: i, name: normalizeForCompare(i.name), via: normalizeStreet(i.description || i.address),
        rawVia: i.description || i.address, lat: Number(i.lat), lon: Number(i.lon),
    }));
    const added = [], changed = [];
    let unchanged = 0;

    // Rows repeated in the file count once
    const seen = new Set();
    const rows = [];
    parsedRows.forEach(p => {
        const row = { p, name: normalizeForCompare(p.name), via: normalizeStreet(p.address), lat: p.lat, lon: p.lon };
        const key = `${row.name}|${row.via}`;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push(row);
    });

    // Pass 1: same name and street. Pass 2: same name within 30 m, only among the
    // entries no other row claimed, so two stops of one school sharing a point
    // (e.g. two meeting places with the same coordinates) stay two entries.
    const claimed = new Set();
    const matchOf = new Map();
    rows.forEach(row => {
        const m = existing.find(e => !claimed.has(e) && e.name === row.name && e.via === row.via);
        if (m) { claimed.add(m); matchOf.set(row, m); }
    });
    rows.forEach(row => {
        if (matchOf.has(row)) return;
        const near = existing
            .filter(e => !claimed.has(e) && e.name === row.name)
            .map(e => ({ e, d: metersBetween(e, row) }))
            .filter(x => x.d <= SAME_PLACE_METERS)
            .sort((x, y) => x.d - y.d);
        if (near.length) { claimed.add(near[0].e); matchOf.set(row, near[0].e); }
    });

    rows.forEach(row => {
        const match = matchOf.get(row);
        if (!match) { added.push(row.p); return; }
        const moved = metersBetween(match, row) > 1;
        const renamed = match.via !== row.via;
        if (moved || renamed) {
            changed.push({
                entry: match.entry, next: row.p, moved, renamed,
                before: { address: match.rawVia, lat: match.lat, lon: match.lon },
            });
        } else {
            unchanged += 1;
        }
    });

    return { added, changed, unchanged };
}

/**
 * The institutes as they are after writing `diff` (what the import writes:
 * new entries with name / street / coordinates, changed ones get the new
 * street and coordinates). Used to check that a second import changes nothing.
 */
export function applyDatasetDiff(institutes, diff) {
    const byId = new Map(institutes.map(i => [i.id, { ...i }]));
    diff.changed.forEach(c => {
        Object.assign(byId.get(c.entry.id), { description: c.next.address, lat: c.next.lat, lon: c.next.lon });
    });
    diff.added.forEach((a, n) => {
        byId.set(`new-${n}-${a.name}`, { id: `new-${n}-${a.name}`, name: a.name, description: a.address, address: a.address, lat: a.lat, lon: a.lon });
    });
    return [...byId.values()];
}
