import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTripRows, buildTripPayload, analyzeDatasetRows, diffDataset, parsePax } from './sheetIssues.js';

const institutes = [
    { id: 'ala', name: 'IC ALA', description: 'ALA, Via Betta, Scuola primaria', address: 'Via Betta, Ala', lat: 45.7562, lon: 11.0015 },
    { id: 'cembra', name: 'IC CEMBRA - SSPG Cembra', description: 'CEMBRA, Via Negritelle - SSPG', address: '46.17, 11.22', lat: 46.1726, lon: 11.2227 },
];
const columns = ['Nome', 'Indirizzo', 'Partecipanti'];

test('participants are read like the backend did', () => {
    assert.equal(parsePax(18), 18);
    assert.equal(parsePax('18 alunni'), 18);
    assert.ok(isNaN(parsePax('')));
});

test('trip rows: sure match preselected, unknown stop and missing participants flagged, autonomous excluded', () => {
    const rows = [
        { Nome: 'IC Ala', Indirizzo: 'Ala (TN) - Via Betta, 10', Partecipanti: 18 },
        { Nome: 'IC Cembra', Indirizzo: 'Cembra, via delle Negritelle n. 1', Partecipanti: '' },
        { Nome: 'Liceo Inesistente', Indirizzo: 'Bolzano, Piazza Walther', Partecipanti: 5 },
        { Nome: 'IC Villa Lagarina', Indirizzo: 'NO PULLMAN', Partecipanti: 14 },
    ];
    const a = analyzeTripRows(rows, columns, institutes);
    assert.equal(a.resolutions[0].entry.id, 'ala');
    assert.ok(a.issues.some(i => i.row === 1 && i.col === 'Partecipanti' && i.fix === 'number'));
    assert.ok(a.issues.some(i => i.row === 2 && i.severity === 'error' && /non presente/.test(i.message)));
    assert.equal(a.resolutions[3].type, 'skip');
});

test('missing required columns are reported', () => {
    const a = analyzeTripRows([{ Scuola: 'x' }], ['Scuola'], institutes);
    assert.deepEqual(a.missingColumns, ['Nome', 'Indirizzo', 'Partecipanti']);
});

test('payload: dataset coordinates and street, typed participants, skipped rows dropped, new stops listed', () => {
    const rows = [
        { Nome: 'IC Ala', Indirizzo: 'Ala (TN) - Via Betta, 10', Partecipanti: 18 },
        { Nome: 'IC Cembra', Indirizzo: 'Cembra', Partecipanti: '' },
        { Nome: 'Nuova', Indirizzo: 'Albiano, Chiesa', Partecipanti: 8 },
        { Nome: 'IC Villa Lagarina', Indirizzo: 'NO PULLMAN', Partecipanti: 14 },
    ];
    const a = analyzeTripRows(rows, columns, institutes);
    const resolutions = {
        0: { type: 'db', entry: institutes[0] },
        1: { type: 'db', entry: institutes[1] },
        2: { type: 'new', name: 'IC Civezzano', address: 'Albiano, Fermata Chiesa', lat: 46.14, lon: 11.18 },
        3: { type: 'skip' },
    };
    const p = buildTripPayload(rows, a, resolutions, { '1|Partecipanti': '12' });
    assert.deepEqual(p.rawSchools.map(s => s.id), [0, 1, 2]);
    assert.equal(p.rawSchools[1].demand, 12);
    assert.equal(p.resolutions[0].display_address, 'ALA, Via Betta, Scuola primaria');
    assert.equal(p.resolutions[0].lat, 45.7562);
    assert.equal(p.resolutions[2].lat, 46.14);
    assert.deepEqual(p.newStops.map(n => n.name), ['IC Civezzano']);
});

test('dataset diff never deletes and tells new, changed and unchanged apart', () => {
    const rows = [
        { Nome: 'IC ALA', Via: 'ALA, Via Betta, Scuola primaria', Coordinate: '45.7562, 11.0015' },      // unchanged
        { Nome: 'IC CEMBRA - SSPG Cembra', Via: 'CEMBRA, Via Negritelle - SSPG', Coordinate: '46.1800, 11.2227' }, // moved
        { Nome: 'IC NUOVO', Via: 'Via Roma 1', Coordinate: '46.0, 11.0' },                                 // new
    ];
    const { parsed } = analyzeDatasetRows(rows, ['Nome', 'Via', 'Coordinate']);
    const d = diffDataset(Object.values(parsed), institutes);
    assert.equal(d.unchanged, 1);
    assert.deepEqual(d.changed.map(c => c.entry.id), ['cembra']);
    assert.deepEqual(d.added.map(a => a.name), ['IC NUOVO']);
});

test('a separate town column is joined to the street', () => {
    const rows = [{ 'Istituto / Fermata': 'IC ROVERETO NORD', 'Località': 'Rovereto', Indirizzo: 'Corso Bettini 67', 'Coordinate (lat, lon)': '45.8936, 11.0436' }];
    const { parsed } = analyzeDatasetRows(rows, Object.keys(rows[0]));
    assert.equal(parsed[0].address, 'Rovereto, Corso Bettini 67');
    assert.equal(parsed[0].lat, 45.8936);
});
