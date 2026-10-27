// Run with: node --test frontend/src/utils/matchInstitutes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { findCandidates, getBestDefaultCandidate, aliasToLearn } from './matchInstitutes.js';

// Real entries from the Firestore "institutes" collection (October 2026)
const PROV = "Territorio Val d'Adige, Provincia di Trento, Trentino-Alto Adige/Südtirol";
const db = [
  { id: 'villazzano', name: 'ENAIP VILLAZZANO', address: `Centro Formazione Professionale ENAIP, 14, Via Asiago, Man Sant'Antonio, Madonna Bianca, Oltrefersina, Villazzano, Trento, ${PROV}, 38123, Italia`, lat: 46.0459631, lon: 11.1374869 },
  { id: 'ossana', name: 'IS ENAIP OSSANA', address: "Cusiano, Via di Sant'Antonio - Strada Provinciale 202 di Ossana, Cusiano, Ossana, Comunità della Valle di Sole, Provincia di Trento, Trentino-Alto Adige/Südtirol, 38027, Italia", lat: 46.3100549, lon: 10.7456589 },
  { id: 'trento3-bolghera', name: 'IC TRENTO 3', address: `Via Simone Felice Crosina e Dante Sartori, Bolghera, Oltrefersina, Villazzano, Trento, ${PROV}, 38122, Italia`, lat: 46.0564305, lon: 11.135145 },
  { id: 'trento3-ss45', name: 'IC TRENTO 3', address: `SS45bis, Piedicastello, Centro Storico - Piedicastello, Vela, Trento, ${PROV}, 38122, Italia`, lat: 46.0698912, lon: 11.115817 },
  { id: 'trento5', name: 'IC TRENTO 5', address: `Ciclovia della Valle dell'Adige, Piedicastello, Centro Storico - Piedicastello, Vela, Trento, ${PROV}, 38122, Italia`, lat: 46.0702761, lon: 11.1159316 },
  { id: 'trento6', name: 'IC TRENTO 6', address: `Ex Italcementi, Lungadige San Nicolò, Piedicastello, Centro Storico - Piedicastello, Sardagna, Trento, ${PROV}, 38122, Italia`, lat: 46.0689541, lon: 11.112397 },
  { id: 'rosmini', name: 'IS ROSMINI - Trento', address: `Corso Tre Novembre, San Giuseppe, San Giuseppe - Santa Chiara, Villazzano, Trento, ${PROV}, 38122, Italia`, lat: 46.0596178, lon: 11.1264979 },
  { id: 'nocoords', name: 'ENAIP TIONE', address: 'stazione dei trenti - Tione', lat: null, lon: null },
  { id: 'fallback', name: 'ENAIP TIONE', address: 'Tione', lat: 46.0697, lon: 11.1211 },
];

test('preselected candidate is the one with the highest % shown', () => {
  const school = { name: 'IS ENAIP OSSANA', address: 'Ossana, Via di S. Antonio 1 – di fronte scuola' };
  const c = findCandidates(school, db);
  assert.equal(getBestDefaultCandidate(school, c).id, 'ossana');
  assert.equal(c[0].id, 'ossana');
  for (let i = 1; i < c.length; i++) assert.ok(c[i - 1]._matchScore >= c[i]._matchScore);
});

test('same institute name outranks other institutes in the same city', () => {
  const c = findCandidates({ name: 'ENAIP VILLAZZANO', address: 'Fermata bus, Park ex Italcementi, Trento' }, db);
  assert.equal(c[0].id, 'villazzano');
});

test('institute numbers are not interchangeable', () => {
  const c = findCandidates({ name: 'IC TRENTO 6', address: 'Fermata bus Funivia Trento/Sardagna, Trento' }, db);
  assert.equal(c[0].id, 'trento6');
  for (const other of c.filter(x => x.name !== 'IC TRENTO 6')) {
    assert.ok(other._matchScore < c[0]._matchScore);
    assert.ok(!other._isPerfect);
  }
});

test('entries without usable coordinates are never proposed', () => {
  const c = findCandidates({ name: 'IS ENAIP TIONE', address: 'stazione dei trenti - Tione' }, db);
  assert.ok(c.every(x => x.id !== 'nocoords' && x.id !== 'fallback'));
});

test('an alias name counts as the same institute, also for auto-assign', () => {
  const point = { id: 'orsi', name: 'IS DON MILANI ROVERETO', address: 'Rovereto, P.le Orsi', lat: 45.89, lon: 11.04, aliases: ['IC Rovereto Est', 'IC ALTA VALLAGARINA - Besenello'] };
  const other = { id: 'quercia', name: 'IC ROVERETO NORD', address: 'Stadio Quercia, Via Palestrina, Rovereto', lat: 45.9, lon: 11.05 };
  const c = findCandidates({ name: 'IC ROVERETO EST', address: 'Piazzale Orsi - Rovereto' }, [other, point]);
  assert.equal(c[0].id, 'orsi');
  assert.equal(c[0]._matchedAlias, 'IC Rovereto Est');
  assert.ok(c[0]._isPerfect);
});

test('alias numbers follow the same rule as names', () => {
  const point = { id: 'funivia', name: 'IC TRENTO 3', address: 'Fermata bus Funivia, Trento', lat: 46.07, lon: 11.11, aliases: ['IC TRENTO 5'] };
  const c = findCandidates({ name: 'IC TRENTO 6', address: 'Fermata bus Funivia, Trento' }, [point]);
  assert.ok(!c.length || !c[0]._isPerfect);
});

test('learning adds the Excel name only when it is new', () => {
  const entry = { name: 'ENAIP TIONE', originalName: 'ENAIP TIONE (Via Durone)', aliases: ['IS Guetti Tione'] };
  assert.equal(aliasToLearn('IS ENAIP di TIONE', entry), 'IS ENAIP di TIONE');
  assert.equal(aliasToLearn('enaip tione', entry), null);
  assert.equal(aliasToLearn('IS GUÈTTI TIONE', entry), null);
  assert.equal(aliasToLearn('ENAIP TIONE (Via Durone)', entry), null);
  assert.equal(aliasToLearn('  ', entry), null);
});
