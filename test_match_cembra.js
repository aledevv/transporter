import { findCandidates } from './frontend/src/utils/matchInstitutes.js';

const mockDb = [
  {
    name: 'IC CEMBRA - “P. Marconi” Faver',
    address: 'Scuola primaria Faver, 1, via campagna, Faver, Altavalle, Comunità della Valle di Cembra, Provincia di Trent...',
    lat: 46.0, lon: 11.0
  },
  {
    name: 'IC CEMBRA - "A. Vielmetti" Cembra',
    address: 'Via delle Negritelle, Fadana, Cembra, Cembra Lisignago, Comunità della Valle di Cembra, Provincia di Tren...',
    lat: 46.0, lon: 11.0
  },
  {
    name: 'IC CEMBRA - Primaria Segonzano',
    address: 'Scuola secondaria di primo grado Stedro Segonzano, 68, Frazione Stedro, Scancio, Segonzano, Comunità...',
    lat: 46.0, lon: 11.0
  },
  {
    name: 'IC CEMBRA - Giovo',
    address: 'Scuola Primaria Verla Giovo, 2, Via al Grec, Valternigo di Giovo, Verla, Giovo, Comunità della Valle di Cemb...',
    lat: 46.0, lon: 11.0
  }
];

const testInput = {
  name: 'IC Cembra',
  address: 'GIOVO Via Al Grec, 2, SEGONZANO Frazione Scancio, Fermata Trentino Trasporti “Snack Bar” Scancio'
};

console.log("Matching results:");
console.dir(findCandidates(testInput, mockDb, { threshold: 0.1, maxCandidates: 10 }), { depth: null });
