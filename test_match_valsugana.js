import { findCandidates } from './frontend/src/utils/matchInstitutes.js';

const mockDb = [
  {
    name: 'IC CENTRO VALSUGANA - Telve "Piazza Maggiore"',
    address: 'Piazza Maggiore, Nale, Longhini, Telve, Comunità Valsugana e Tesino, Provincia di Trento, Trentino-Alto A...',
    lat: 46.0, lon: 11.0
  },
  {
    name: 'IC BORGO VALSUGANA - "Ora e Veglia" Borgo Valsugana',
    address: 'Borgo Valsugana, Via Spagolla, 1',
    lat: 46.0, lon: 11.0
  },
  {
    name: 'IC CENTRO VALSUGANA - Roncegno (Pizzeria "Il Picchio")',
    address: 'Pizzeria il Picchio, 26, Via Cesare Battisti, Cadenzi, Marter, Roncegno Terme, Comunità Valsugana e Tesin...',
    lat: 46.0, lon: 11.0
  }
];

const testInput = {
  name: 'IC Centro Valsugana',
  address: 'RONCEGNO, Fermata "Il Picchio"'
};

console.log("Matching results:");
console.dir(findCandidates(testInput, mockDb, { threshold: 0.1, maxCandidates: 10 }), { depth: null });
