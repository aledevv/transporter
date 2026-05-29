import { findCandidates } from './frontend/src/utils/matchInstitutes.js';

const input = { name: "IC Giudicarie Esteriori", address: "COMANO TERME Via S Giovanni Bosco, 14", description: "" };
const db = [
  { name: "IC GIUDICARIE ESTERIORI - Campo", address: "Centro sportivo Scuola Primaria Lomaso, Piazza Risorgimento, Campo Lomaso, Vigo Lomaso, Comano Terme, Comunità delle Giudicarie, Provincia di Trento, Trentino-Alto Adige/Südtirol, 38077, Italia", description: "" },
  { name: "IC GIUDICARIE ESTERIORI - Comano Terme", address: "Via S Giovanni Bosco 14", description: "" },
  { name: "IC GIUDICARIE ESTERIORI - Fiavé", address: "Scuola primaria Fiavé, Via De Gasperi, Stumiaga, Fiavé, Comunità delle Giudicarie, Provincia di Trento, Trentino-Alto Adige/Südtirol, 38075, Italia", description: "" }
];

console.log(findCandidates(input, db));
