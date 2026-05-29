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
      globalScore = intersection.length / Math.max(sAll.length, dAll.length);
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

  return Math.min(baseScore + crossBonus + exactAddressBonus, 1.0);
}

/**
 * Returns up to maxCandidates DB entries that match the given school.
 * Each candidate has an extra `_matchScore` field.
 */
export function findCandidates(school, dbInstitutes, { maxCandidates = 5, threshold = 0.4 } = {}) {
  return dbInstitutes
    .map(inst => {
        const score = scoreMatch(school, inst);
        return { ...inst, _matchScore: score, _isPerfect: score >= 0.99 };
    })
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

/**
 * Determines the best default candidate to pre-select.
 * 1. If only 1 candidate, select it.
 * 2. If exactly 1 candidate has a perfect score (>= 0.99), select it.
 * 3. If a word from the school name appears in exactly 1 candidate's address, select it.
 * 4. Otherwise, fallback to the first candidate (highest score).
 */
export function getBestDefaultCandidate(school, candidates) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const perfectMatches = candidates.filter(c => c._matchScore >= 0.99);
    if (perfectMatches.length === 1) return perfectMatches[0];

    const sNameTokens = normalizeName(school.name);
    for (const token of sNameTokens) {
        const candidatesWithToken = candidates.filter(c => {
            const dAddrTokens = normalizeAddress(c.address);
            return dAddrTokens.includes(token);
        });
        if (candidatesWithToken.length === 1) {
            return candidatesWithToken[0];
        }
    }

    return candidates[0];
}
