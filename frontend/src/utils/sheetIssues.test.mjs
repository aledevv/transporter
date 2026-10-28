import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTripRows, buildTripPayload, analyzeDatasetRows, diffDataset, applyDatasetDiff, normalizeStreet, parsePax } from './sheetIssues.js';

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

test('trip sheets read the old headers and aliases, show only planner columns, stop at the first blank row', () => {
    const columns = ['Informazioni cronologiche', 'Indirizzo email', 'Nome Scuola', 'Indirizzo di ritiro', 'Passeggeri', 'Istituzione', 'N. telefono'];
    const rows = [
        { 'Nome Scuola': 'IC Ala', 'Indirizzo email': 'x@y.it', 'Indirizzo di ritiro': 'Ala (TN) - Via Betta, 10', Passeggeri: 18, Istituzione: 'IC Ala', 'N. telefono': '0464' },
        { 'Nome Scuola': '', 'Indirizzo di ritiro': '', Passeggeri: '' },
        { 'Nome Scuola': 'Totale', 'Indirizzo di ritiro': '', Passeggeri: 18 },
    ];
    const a = analyzeTripRows(rows, columns, institutes);
    assert.equal(a.nameCol, 'Nome Scuola');
    assert.equal(a.addrCol, 'Indirizzo di ritiro');
    assert.equal(a.paxCol, 'Passeggeri');
    assert.equal(a.instCol, 'Istituzione');
    assert.deepEqual(a.shownColumns, ['Nome Scuola', 'Indirizzo di ritiro', 'Passeggeri', 'Istituzione']);
    assert.equal(a.resolutions[0].entry.id, 'ala');
    assert.equal(a.tableRows, 1);
    assert.equal(a.resolutions[2].type, 'skip');
    assert.ok(!a.issues.some(i => i.row >= 1));
});

const datasetCols = ['Nome', 'Via', 'Coordinate'];
const parse = rows => Object.values(analyzeDatasetRows(rows, datasetCols).parsed);
const fileRows = [
    { Nome: 'IC ALA', Via: 'ALA, Via Betta, Scuola primaria', Coordinate: '45.7562, 11.0015' },
    { Nome: 'IC CEMBRA - SSPG Cembra', Via: 'CEMBRA, Via Negritelle - SSPG', Coordinate: '46.1726, 11.2227' },
    { Nome: 'IC ROVERETO NORD', Via: 'Rovereto, Corso Bettini 67', Coordinate: '45.8936, 11.0436' },
    { Nome: 'IC ROVERETO NORD', Via: 'Rovereto, V.le Trento - Fermata bus', Coordinate: '45.8991, 11.0423' },
];

test('importing the same file twice: the second time nothing is new or changed', () => {
    const first = diffDataset(parse(fileRows), institutes);
    const after = applyDatasetDiff(institutes, first);
    const second = diffDataset(parse(fileRows), after);
    assert.equal(second.added.length, 0);
    assert.equal(second.changed.length, 0);
    assert.equal(second.unchanged, fileRows.length);
});

test('the same file with 2 more rows adds exactly those 2', () => {
    const after = applyDatasetDiff(institutes, diffDataset(parse(fileRows), institutes));
    const more = [...fileRows,
        { Nome: 'IC MORI', Via: 'Mori, Via Giovanni XXIII 64', Coordinate: '45.8522, 10.9856' },
        { Nome: 'IC AVIO', Via: 'Avio, Viale Degasperi 69', Coordinate: '45.7388, 10.9531' }];
    const d = diffDataset(parse(more), after);
    assert.deepEqual(d.added.map(a => a.name), ['IC MORI', 'IC AVIO']);
    assert.equal(d.changed.length, 0);
});

test('case, spaces, accents, punctuation and street abbreviations do not make a row different', () => {
    const after = applyDatasetDiff(institutes, diffDataset(parse(fileRows), institutes));
    const variant = [
        { Nome: '  ic  ala ', Via: 'Ala,  via betta  -  scuola primaria', Coordinate: '45.7562,11.0015' },
        { Nome: 'IC Rovereto Nord', Via: 'ROVERETO CORSO BETTINI N. 67', Coordinate: '45,8936; 11,0436' },
        { Nome: 'IC ROVERETO NORD', Via: 'Rovereto, Viale Trento - fermata bus', Coordinate: '45.8991, 11.0423' },
    ];
    const d = diffDataset(parse(variant), after);
    assert.equal(d.added.length, 0);
    assert.equal(d.changed.length, 0);
    assert.equal(d.unchanged, 3);
    assert.equal(normalizeStreet('P.zza Duomo, 1'), normalizeStreet('Piazza Duomo 1'));
    assert.equal(normalizeStreet('C.so Rosmini n. 24'), normalizeStreet('Corso Rosmini 24'));
});

test('rows repeated in the file are inserted once', () => {
    const rows = [
        { Nome: 'IC NUOVO', Via: 'Via Roma 1', Coordinate: '46.0, 11.0' },
        { Nome: 'ic nuovo', Via: 'via roma 1', Coordinate: '46.0, 11.0' },
    ];
    assert.equal(diffDataset(parse(rows), institutes).added.length, 1);
});

test('same name within 30 m with a reworded street is a change, not a new entry', () => {
    const rows = [{ Nome: 'IC ALA', Via: 'Ala, Via Abramo Betta 10', Coordinate: '45.75625, 11.00152' }];
    const d = diffDataset(parse(rows), institutes);
    assert.equal(d.added.length, 0);
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0].before.address, 'ALA, Via Betta, Scuola primaria');
    assert.ok(d.changed[0].renamed);
});

test('two stops of one school at the same point stay two entries and re-import cleanly', () => {
    const rows = [
        { Nome: 'IC ROVERETO SUD', Via: 'Rovereto, Via Benacense, 27', Coordinate: '45.8704688, 11.0307145' },
        { Nome: 'IC ROVERETO SUD', Via: 'Rovereto/Lizzana, Via Livenza, 1 - SSPG', Coordinate: '45.8704688, 11.0307145' },
    ];
    const first = diffDataset(parse(rows), institutes);
    assert.equal(first.added.length, 2);
    const second = diffDataset(parse(rows), applyDatasetDiff(institutes, first));
    assert.equal(second.added.length + second.changed.length, 0);
    assert.equal(second.unchanged, 2);
});
