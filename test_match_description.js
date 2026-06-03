import { findCandidates } from './frontend/src/utils/matchInstitutes.js';

const mockDb = [
  {
    name: 'Istituto Comprensivo Centro Valsugana',
    address: 'Piazza Municipio 1, Roncegno Terme',
    description: 'Fermata Il Picchio',
    lat: 46.05, lon: 11.41
  },
  {
    name: 'Istituto Comprensivo Ladino di Fassa',
    address: 'Strada di Scuole 1, San Giovanni di Fassa',
    description: 'Fermata Te Volto',
    lat: 46.43, lon: 11.68
  },
  {
    name: 'Another random school',
    address: 'Via Roma 1, Trento',
    description: '',
    lat: 46.0, lon: 11.0
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
