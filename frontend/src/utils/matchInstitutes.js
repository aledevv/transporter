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

// School-type tokens that must never count toward name similarity regardless
// of position (catches abbreviations that survive prefix-stripping).
const NAME_TYPE_STOP = new Set([
  'iis', 'isis', 'itis', 'ipss', 'ites', 'itc', 'cfp',
  'istituto', 'comprensivo', 'tecnico', 'professionale',
  'liceo', 'scientifico', 'classico', 'artistico',
  'scuola', 'secondaria', 'primaria', 'elementare', 'media',
  'centro', 'formazione',
]);

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
    .filter(t => t.length >= 3 && !NAME_TYPE_STOP.has(t));
}

// Institute numbers ("IC TRENTO 3" vs "IC TRENTO 6") are dropped by normalizeName
// (too short) but they identify different institutes
function nameNumbers(name) {
  return (name || '').replace(/\(.*?\)/g, '').match(/\b\d+\b/g) || [];
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
  let sNameStr = school.name;
  let sDescStr = school.description || '';
  if (!school.description && sNameStr) {
      const m = sNameStr.match(/\((.*?)\)/);
      if (m) {
          sDescStr = m[1];
          sNameStr = sNameStr.replace(/\(.*?\)/g, '');
      }
  }

  let dNameStr = dbEntry.name;
  let dDescStr = dbEntry.description || '';
  if (!dbEntry.description && dNameStr && dNameStr.includes('(')) {
      const m = dNameStr.match(/\((.*?)\)/);
      if (m) {
          dDescStr = m[1];
          dNameStr = dNameStr.replace(/\(.*?\)/g, '');
      }
  }

  const sName = normalizeName(sNameStr);
  const dName = normalizeName(dNameStr);
  const nameScore = tokenOverlap(sName, dName);

  const sDesc = normalizeName(sDescStr);
  const dDesc = normalizeName(dDescStr);
  
  const sAddr = normalizeAddress(school.address);
  const dAddr = normalizeAddress(dbEntry.address);
  const addrScore = tokenOverlap(sAddr, dAddr);

  let descScore = 1;
  let weightedScore = 0;
  
  if (sDesc.length === 0 && dDesc.length === 0) {
      descScore = 0;
      weightedScore = nameScore * 0.5 + addrScore * 0.5;
  } else {
      if (sDesc.length > 0 || dDesc.length > 0) {
          descScore = tokenOverlap(sDesc, dDesc);
      }
      weightedScore = nameScore * 0.4 + descScore * 0.2 + addrScore * 0.4;
  }

  // Global overlap across ALL fields (handles description fragments in address etc)
  const sAll = Array.from(new Set([...sName, ...sDesc, ...sAddr]));
  const dAll = Array.from(new Set([...dName, ...dDesc, ...dAddr]));
  let globalScore = 0;
  if (sAll.length > 0 && dAll.length > 0) {
      const intersection = sAll.filter(a => dAll.some(b => b.includes(a) || a.includes(b)));
      globalScore = intersection.length / Math.max(Math.min(sAll.length, dAll.length), 3);
  }

  // Cross-match bonuses
  let crossBonus = 0;
  // If input address tokens appear in candidate name
  if (sAddr.length > 0 && dName.length > 0) {
      const crossMatches = sAddr.filter(a => dName.some(b => b.includes(a) || a.includes(b)));
      if (crossMatches.length > 0) {
          crossBonus += (crossMatches.length / Math.max(sAddr.length, 3)) * 0.15;
      }
  }
  // If input name tokens appear in candidate address
  if (sName.length > 0 && dAddr.length > 0) {
      const crossMatches = sName.filter(a => dAddr.some(b => b.includes(a) || a.includes(b)));
      if (crossMatches.length > 0) {
          crossBonus += (crossMatches.length / Math.max(sName.length, 3)) * 0.15;
      }
  }
  // If input address tokens appear in candidate description
  if (sAddr.length > 0 && dDesc.length > 0) {
      const crossMatches = sAddr.filter(a => dDesc.some(b => b.includes(a) || a.includes(b)));
      if (crossMatches.length > 0) {
          crossBonus += (crossMatches.length / Math.max(sAddr.length, 3)) * 0.20;
      }
  }
  // If input name tokens appear in candidate description
  if (sName.length > 0 && dDesc.length > 0) {
      const crossMatches = sName.filter(a => dDesc.some(b => b.includes(a) || a.includes(b)));
      if (crossMatches.length > 0) {
          crossBonus += (crossMatches.length / Math.max(sName.length, 3)) * 0.15;
      }
  }

  // Name is the identifier: must overlap to be a candidate at all, UNLESS global score is very high
  if (nameScore < 0.3 && globalScore < 0.7 && crossBonus < 0.1) return 0;
  
  let baseScore = Math.max(weightedScore, globalScore);
  
  // Penalize if the overall context (globalScore) is very poor (e.g. huge address in DB vs tiny input address),
  // which means the high weighted score is just due to partial leniency.
  if (baseScore > 0.6 && globalScore < 0.4) {
      baseScore = (baseScore + globalScore) / 2;
  }

  // Add Exact Address Bonus to break ties (if the original address matches the db address perfectly)
  let exactAddressBonus = 0;
  if (school.address && dbEntry.address) {
      const sAddrRaw = school.address.toLowerCase().trim();
      const dAddrRaw = dbEntry.address.toLowerCase().trim();
      if (sAddrRaw === dAddrRaw) {
          exactAddressBonus = 0.15;
      } else if (sAddrRaw.includes(dAddrRaw) || dAddrRaw.includes(sAddrRaw)) {
          exactAddressBonus = 0.08;
      }
  }

  // Not capped at 1.0 here: several candidates would tie at 100% and the ranking
  // would fall back to Firestore order. findCandidates caps it for display.
  let score = baseScore + crossBonus + exactAddressBonus;

  // Different institute numbers ("IC TRENTO 3" vs "IC TRENTO 6") are different institutes
  const sNums = nameNumbers(sNameStr);
  const dNums = nameNumbers(dNameStr);
  if (sNums.length && dNums.length && !sNums.some(n => dNums.includes(n))) score *= 0.5;

  // The name identifies the institute: a candidate whose name shares nothing with
  // the stop (it only got here through address/city words like "trento") must not
  // outrank one with the right name, or the % shown would contradict the choice.
  if (nameScore === 0 && descScore === 0) score *= 0.6;

  return score;
}

const FALLBACK_COORDS = [46.0697, 11.1211];

// Case- and accent-insensitive form used to compare names and aliases
export function normalizeForCompare(text) {
  return (text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Whether two names look like the same school written differently: all the
 * words of the shorter name appear in the longer one and the numbers agree
 * ("IS ENAIP di TIONE" / "ENAIP TIONE", "ANDALO (SM)" / "IC MEZZOLOMBARDO
 * PAGANELLA - Andalo"). Different schools that share a meeting point
 * ("IS FILZI ROVERETO" / "IC DAME INGLESI ROVERETO") are not.
 */
export function looksLikeSameSchool(a, b) {
  const ta = normalizeName((a || '').replace(/\(.*?\)/g, ''));
  const tb = normalizeName((b || '').replace(/\(.*?\)/g, ''));
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (!short.every(t => long.some(u => u === t || (t.length >= 5 && (u.startsWith(t) || t.startsWith(u)))))) return false;
  const na = nameNumbers(a), nb = nameNumbers(b);
  return !(na.length && nb.length && !na.some(x => nb.includes(x)));
}

/**
 * The alias to add to a DB entry after a stop named `excelName` was matched to
 * it, or null when that name is already known for the entry, or when it is a
 * different school that only shares the entry's meeting point.
 */
export function aliasToLearn(excelName, entry) {
  const name = (excelName || '').trim();
  if (!name || !entry) return null;
  const known = [entry.name, entry.originalName, ...(entry.aliases || [])];
  if (known.map(normalizeForCompare).includes(normalizeForCompare(name))) return null;
  return known.some(k => looksLikeSameSchool(name, k)) ? name : null;
}

function hasUsableCoords(inst) {
  const { lat, lon } = inst;
  if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return false;
  return !(Math.abs(lat - FALLBACK_COORDS[0]) < 1e-6 && Math.abs(lon - FALLBACK_COORDS[1]) < 1e-6);
}

/**
 * Returns up to maxCandidates DB entries that match the given school.
 * Each candidate has an extra `_matchScore` field.
 */
export function findCandidates(school, dbInstitutes, { maxCandidates = 5, threshold = 0.4 } = {}) {
  const sName = normalizeName((school.name || '').replace(/\(.*?\)/g, ''));
  return dbInstitutes
    // Entries saved without coordinates (or with the Trento-centre geocoding
    // fallback) can't be used as a resolution
    .filter(hasUsableCoords)
    .map(inst => {
        // A point can be known under several names (aliases saved when entries with
        // the same coordinates were merged, or when a stop was matched to it):
        // score each name and keep the best one
        const variants = [
            { name: inst.name, description: inst.description },
            ...(inst.aliases || []).filter(Boolean).map(alias => ({ name: alias, description: '', isAlias: true })),
        ];
        let best = null;
        for (const v of variants) {
            const raw = scoreMatch(school, { ...inst, ...v });
            const dName = normalizeName((v.name || '').replace(/\(.*?\)/g, ''));
            const nameExact = sName.length > 0 && sName.length === dName.length && sName.every(t => dName.includes(t));
            // Same institute name ranks above another institute at the same address
            const ranked = nameExact ? raw + 0.25 : raw;
            if (!best || ranked > best.ranked) best = { raw, ranked, nameExact, v };
        }
        return {
            ...inst,
            _rawScore: best.ranked,
            _matchScore: Math.min(best.ranked, 1.0),
            _nameExact: best.nameExact,
            _isPerfect: best.raw >= 0.99 && best.nameExact,
            _matchedAlias: best.v.isAlias ? best.v.name : null,
        };
    })
    .filter(c => c._matchScore >= threshold)
    // Rank by the uncapped score so ties at 100% keep a meaningful order
    .sort((a, b) => b._rawScore - a._rawScore)
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

/**
 * Determines the best default candidate to pre-select.
 * 1. If only 1 candidate, select it.
 * 2. If exactly 1 candidate has a perfect score (>= 0.99), select it.
 * 3. If a word from the school name appears in exactly 1 candidate's address, select it.
 * 4. Otherwise, fallback to the first candidate (highest score).
 */
export function getBestDefaultCandidate(school, candidates) {
    // Candidates are already ranked by score, so the preselected one is
    // always the first, with the highest % shown
    if (!candidates || candidates.length === 0) return null;
    return candidates[0];
}
