import { findCandidates } from './frontend/src/utils/matchInstitutes.js';

const input = { name: "IC Aldeno-Mattarello", address: "ALDENO Via Alle Albere / MATTARELLO", description: "" };
const db = [
  { name: "IC Aldeno-Mattarello - sede mattarello", address: "Via Roma, Mattarello", description: "" },
  { name: "IC Aldeno-Mattarello - sede Aldeno", address: "Via Alle Albere, Aldeno", description: "" },
  { name: "IC Aldeno-Mattarello - sede romagnano", address: "Via Romagnano", description: "" }
];

console.log(findCandidates(input, db));
