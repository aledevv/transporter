import { findCandidates, normalizeForCompare } from './matchInstitutes';
import { parseCoordinates } from './coordinates';

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
export function analyzeTripRows(rows, columns, institutes) {
    const nameCol = findColumn(columns, ['Nome', 'Fermata', 'Nome fermata']);
    const addrCol = findColumn(columns, ['Indirizzo', 'Via', 'Indirizzi']);
    const paxCol = findColumn(columns, ['Partecipanti', 'Passeggeri', 'Pax']);
    const issues = [];
    const resolutions = {};
    const candidatesByRow = {};

    rows.forEach((r, row) => {
        const name = String(r[nameCol] ?? '').trim();
        const address = String(r[addrCol] ?? '').trim();
        const pax = r[paxCol];

        if (paxCol && (pax === '' || pax == null || isNaN(Number(pax)) || Number(pax) <= 0)) {
            issues.push({ row, col: paxCol, severity: 'error', message: 'Partecipanti mancanti', fix: 'number' });
        }
        if (!name && !address) {
            issues.push({ row, col: nameCol, severity: 'error', message: 'Riga senza nome né via' });
            return;
        }

        const candidates = findCandidates({ name, address }, institutes, { maxCandidates: 8, threshold: 0.3 });
        candidatesByRow[row] = candidates;
        const [best, second] = candidates;
        const anchor = addrCol || nameCol;

        if (!best) {
            issues.push({ row, col: anchor, severity: 'error', message: 'Fermata non presente nel database' });
            return;
        }
        const tie = second && second._matchScore >= 0.5 && best._rawScore - second._rawScore < 0.05;
        if (tie) {
            issues.push({ row, col: anchor, severity: 'error', message: `Più fermate possibili (${candidates.filter(c => best._rawScore - c._rawScore < 0.05).length})` });
            return;
        }
        if (best._matchScore < 0.75) {
            issues.push({ row, col: anchor, severity: 'warning', message: `Abbinamento incerto: ${best.name}` });
        }
        resolutions[row] = { type: 'db', entry: best };
    });

    return { issues, resolutions, candidatesByRow, nameCol, addrCol };
}

/**
 * Dataset sheet (Nome / Via / Coordinate): coordinates are sanitized, rows
 * without a name, a street or usable coordinates are flagged.
 * Returns { issues, parsed } where parsed[row] = { name, address, lat, lon } for valid rows.
 */
export function analyzeDatasetRows(rows, columns) {
    const nameCol = findColumn(columns, ['Nome', 'Nome fermata', 'Istituto', 'Istituto / Fermata', 'Fermata']);
    const addrCol = findColumn(columns, ['Via', 'Indirizzo']);
    const coordCol = findColumn(columns, ['Coordinate', 'Coordinate (lat, lon)', 'Coord']);
    const latCol = !coordCol && findColumn(columns, ['Lat', 'Latitudine']);
    const lonCol = !coordCol && findColumn(columns, ['Lon', 'Lng', 'Longitudine']);
    const issues = [];
    const parsed = {};
    const seen = new Map();

    rows.forEach((r, row) => {
        const name = String(r[nameCol] ?? '').trim();
        const address = String(r[addrCol] ?? '').trim();
        if (!name && !address && !(coordCol ? r[coordCol] : r[latCol])) return; // blank line
        let ok = true;
        if (!name) { issues.push({ row, col: nameCol, severity: 'error', message: 'Nome mancante' }); ok = false; }
        if (!address) { issues.push({ row, col: addrCol, severity: 'error', message: 'Via mancante' }); ok = false; }

        const c = coordCol ? parseCoordinates(r[coordCol]) : parseCoordinates(r[latCol], r[lonCol]);
        const cCol = coordCol || latCol;
        if (!c.ok) {
            issues.push({ row, col: cCol, severity: 'error', message: c.error });
            ok = false;
        } else if (c.warning) {
            issues.push({ row, col: cCol, severity: 'warning', message: `${c.warning}: corrette` });
        }

        const key = `${normalizeForCompare(name)}|${normalizeForCompare(address)}`;
        if (name && address && seen.has(key)) {
            issues.push({ row, col: nameCol, severity: 'warning', message: `Doppione della riga ${seen.get(key) + 2}` });
        } else {
            seen.set(key, row);
        }
        if (ok) parsed[row] = { name, address, lat: c.lat, lon: c.lon };
    });

    return { issues, parsed, nameCol, addrCol, coordCol: coordCol || latCol };
}
