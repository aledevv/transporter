// School type prefixes to strip before name comparison
const TYPE_PREFIXES = [
  'istituto comprensivo', 'istituto tecnico', 'istituto professionale',
  'istituto', 'comprensivo', 'liceo scientifico', 'liceo classico',
  'liceo artistico', 'liceo', 'scuola secondaria di primo grado',
  'scuola secondaria di secondo grado', 'scuola elementare',
  'scuola media', 'scuola primaria', 'scuola', 'centro formazione',
  'centro di formazione professionale', 'cfp',
  'ic ', 'iis ', 'isis ', 'itis ', 'ipss ', 'ites ', 'itc ',
];

// Address parts to strip (street types, common words)
const ADDR_STOP = new Set([
  'via', 'viale', 'vle', 'piazza', 'pza', 'pzza', 'corso', 'cso',
  'strada', 'vicolo', 'largo', 'borgo', 'contrada', 'localita',
  'localit', 'frazione', 'fraz', 'loc', 'del', 'della', 'dello',
  'dei', 'degli', 'delle', 'di', 'da', 'in', 'le', 'la', 'il',
  'gli', 'con', 'per', 'tra', 'fra',
]);

function normalizeName(name) {
  let s = (name || '').toLowerCase().trim();
  for (const p of TYPE_PREFIXES) {
    if (s.startsWith(p)) { s = s.slice(p.length).trim(); break; }
  }
  return s.replace(/[^\wàèéìòù\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

function normalizeAddress(addr) {
  return (addr || '')
    .toLowerCase()
    .replace(/[,\.\-;:]/g, ' ')
    .replace(/\b\d+[a-z]?\b/g, ' ')   // strip house numbers (e.g. "12", "4a")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !ADDR_STOP.has(t));
}

function tokenOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  // Allow substring matching: "avio" matches "avios"
  const matches = tokensA.filter(a => tokensB.some(b => b.includes(a) || a.includes(b)));
  return Math.min(matches.length / Math.min(tokensA.length, tokensB.length), 1);
}

function scoreMatch(school, dbEntry) {
  const sName = normalizeName(school.name);
  const dName = normalizeName(dbEntry.name);
  const nameScore = tokenOverlap(sName, dName);

  const sAddr = normalizeAddress(school.address);
  const dAddr = normalizeAddress(dbEntry.address);
  const addrScore = tokenOverlap(sAddr, dAddr);

  // Name is the identifier: must overlap to be a candidate at all.
  // Address is the quality signal: perfect address → score reaches 100%.
  if (nameScore < 0.3) return 0;

  return nameScore * 0.5 + addrScore * 0.5;
}

/**
 * Returns up to maxCandidates DB entries that match the given school.
 * Each candidate has an extra `_matchScore` field.
 */
export function findCandidates(school, dbInstitutes, { maxCandidates = 5, threshold = 0.4 } = {}) {
  return dbInstitutes
    .map(inst => ({ ...inst, _matchScore: scoreMatch(school, inst) }))
    .filter(c => c._matchScore >= threshold)
    .sort((a, b) => b._matchScore - a._matchScore)
    .slice(0, maxCandidates);
}

/**
 * For a list of schools, return only those with at least one candidate.
 * Returns: [{ school, candidates }]
 */
export function buildMatchList(schools, dbInstitutes) {
  return schools
    .map(school => ({ school, candidates: findCandidates(school, dbInstitutes) }))
    .filter(({ candidates }) => candidates.length > 0);
}
