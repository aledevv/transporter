import { findCandidates } from './frontend/src/utils/matchInstitutes.js';

const mockDb = [
  {
    name: 'Istituto Comprensivo Centro Valsugana (Fermata Il Picchio)',
    address: 'Piazza Municipio 1, Roncegno Terme',
    lat: 46.05, lon: 11.41
  },
  {
    name: 'Istituto Comprensivo Ladino di Fassa (Fermata Te Volto)',
    address: 'Strada di Scuole 1, San Giovanni di Fassa',
    lat: 46.43, lon: 11.68
  }
];

const test1 = {
  name: 'Ic centro valsugana',
  address: 'Roncegno fermata "Il Picchio"'
};

const test2 = {
  name: 'Ladino di fassa',
  address: 'Fermata Te Volto'
};

console.log("Test 1: Ic centro valsugana | Roncegno fermata Il Picchio");
console.log(findCandidates(test1, mockDb, { threshold: 0.1 }));

console.log("\nTest 2: Ladino di fassa | Fermata Te Volto");
console.log(findCandidates(test2, mockDb, { threshold: 0.1 }));
