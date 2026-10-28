import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destinationPlaces, matchLocalPlaces, isSchoolEntry } from './placeMatch.js';

const db = [
    { id: 'a', name: 'IC FOLGARIA', description: 'FOLGARIA, Via Nazioni Unite - Fermata bus Palazzo del ghiaccio', lat: 45.9, lon: 11.1 },
    { id: 'b', name: 'IS FONTANA ROVERETO', description: 'ROVERETO, Via Piomarta, Palasport', lat: 45.89, lon: 11.04 },
    { id: 'c', name: 'Centro Sportivo Sopramonte', address: 'Via di Mura 17, Sopramonte', lat: 46.07, lon: 11.05 },
    { id: 'd', name: 'Palazzetto dello Sport Rovereto', address: 'Via Piomarta, Rovereto', lat: 45.896, lon: 11.042, type: 'destinazione' },
    { id: 'e', name: 'ENAIP TIONE', description: 'Tione, Via Durone 53', lat: 46.03, lon: 10.73 },
];
const trips = [{ id: 't1', destination: 'Villa Lagarina, Comunità della Vallagarina, Provincia di Trento', destCoords: { lat: 45.94, lon: 11.02 } }];

test('schools never appear among destinations', () => {
    const places = destinationPlaces(db, trips);
    assert.deepEqual(places.map(p => p.id).sort(), ['c', 'd', 'trip-t1']);
    assert.ok(isSchoolEntry(db[1]) && isSchoolEntry(db[4]));
});

test('only real matches: typed words start words of the name or street', () => {
    const places = destinationPlaces(db, trips);
    assert.deepEqual(matchLocalPlaces('pala', places).map(p => p.place_id), ['db_d']);
    assert.deepEqual(matchLocalPlaces('villa lag', places).map(p => p.place_id), ['db_trip-t1']);
    assert.deepEqual(matchLocalPlaces('centro sport', places).map(p => p.place_id), ['db_c']);
    // "azzetto" is inside a word, not at its start
    assert.deepEqual(matchLocalPlaces('azzetto', places), []);
    // a school with "Palasport" in its street is not offered as a destination
    assert.ok(!matchLocalPlaces('palasport', places).some(p => p.place_id === 'db_b'));
});

test('at most 3 database suggestions', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Palestra ${i}`, lat: 46, lon: 11 }));
    assert.equal(matchLocalPlaces('palestra', many).length, 3);
});
