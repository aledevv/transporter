import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinates } from './coordinates.js';

test('Google Maps copy', () => {
    const r = parseCoordinates('46.06997953078613, 11.1554038040949616');
    assert.ok(r.ok);
    assert.equal(r.lat, 46.06997953078613);
    assert.equal(r.lon, 11.1554038040949616);
    assert.equal(r.swapped, false);
});

test('decimal comma with semicolon, spaces, brackets', () => {
    for (const s of ['46,28885; 11,51090', '46,28885 11,51090', '(46.28885, 11.51090)', ' 46.28885 ,11.51090 ', '46.28885 11.51090']) {
        const r = parseCoordinates(s);
        assert.ok(r.ok, s);
        assert.equal(r.lat, 46.28885, s);
        assert.equal(r.lon, 11.5109, s);
    }
});

test('two separate cells, numbers or strings', () => {
    assert.deepEqual(parseCoordinates(46.1, 11.2).lat, 46.1);
    assert.equal(parseCoordinates('46,1', '11,2').lon, 11.2);
});

test('swapped lat/lon is fixed and reported', () => {
    const r = parseCoordinates('11.0015357, 45.7562382');
    assert.ok(r.ok);
    assert.equal(r.lat, 45.7562382);
    assert.equal(r.swapped, true);
    assert.ok(r.warning);
});

test('rejects garbage, empty, outside area and the Trento placeholder', () => {
    assert.equal(parseCoordinates('').ok, false);
    assert.equal(parseCoordinates('vedi mappa').ok, false);
    assert.equal(parseCoordinates('53.23095953078613, -0.5538040949616065').error, 'Fuori dalla zona servita');
    assert.equal(parseCoordinates('46.0697, 11.1211').ok, false);
    assert.equal(parseCoordinates('46.07').ok, false);
});
