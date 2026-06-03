const TYPE_PREFIXES = [
  'istituto comprensivo', 'istituto tecnico', 'istituto professionale',
  'istituto', 'comprensivo', 'liceo scientifico', 'liceo classico',
  'liceo artistico', 'liceo', 'scuola secondaria di primo grado',
  'scuola secondaria di secondo grado', 'scuola elementare',
  'scuola media', 'scuola primaria', 'scuola', 'centro formazione',
  'centro di formazione professionale', 'cfp',
  'ic ', 'iis ', 'isis ', 'itis ', 'ipss ', 'ites ', 'itc ',
];

const NAME_TYPE_STOP = new Set([
  'iis', 'isis', 'itis', 'ipss', 'ites', 'itc', 'cfp',
  'istituto', 'comprensivo', 'tecnico', 'professionale',
  'liceo', 'scientifico', 'classico', 'artistico',
  'scuola', 'secondaria', 'primaria', 'elementare', 'media',
  'centro', 'formazione',
]);

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
    .replace(/\b\d+[a-z]?\b/g, ' ')   
    .split(/\s+/)
    .filter(t => t.length >= 3 && !ADDR_STOP.has(t));
}

function tokenOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
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

  const sAll = Array.from(new Set([...sName, ...sDesc, ...sAddr]));
  const dAll = Array.from(new Set([...dName, ...dDesc, ...dAddr]));
  let globalScore = 0;
  if (sAll.length > 0 && dAll.length > 0) {
      const intersection = sAll.filter(a => dAll.some(b => b.includes(a) || a.includes(b)));
      // FIX: use Math.min
      globalScore = intersection.length / Math.max(Math.min(sAll.length, dAll.length), 3);
  }

  let crossBonus = 0;
  if (sAddr.length > 0 && dName.length > 0) {
      const crossMatches = sAddr.filter(a => dName.some(b => b.includes(a) || a.includes(b)));
      if (crossMatches.length > 0) {
          crossBonus += (crossMatches.length / Math.max(sAddr.length, 3)) * 0.15;
      }
  }
  if (sName.length > 0 && dAddr.length > 0) {
      const crossMatches = sName.filter(a => dAddr.some(b => b.includes(a) || a.includes(b)));
      if (crossMatches.length > 0) {
          crossBonus += (crossMatches.length / Math.max(sName.length, 3)) * 0.15;
      }
  }
  if (sAddr.length > 0 && dDesc.length > 0) {
      const crossMatches = sAddr.filter(a => dDesc.some(b => b.includes(a) || a.includes(b)));
      if (crossMatches.length > 0) {
          crossBonus += (crossMatches.length / Math.max(sAddr.length, 3)) * 0.20;
      }
  }
  if (sName.length > 0 && dDesc.length > 0) {
      const crossMatches = sName.filter(a => dDesc.some(b => b.includes(a) || a.includes(b)));
      if (crossMatches.length > 0) {
          crossBonus += (crossMatches.length / Math.max(sName.length, 3)) * 0.15;
      }
  }

  if (nameScore < 0.3 && globalScore < 0.7 && crossBonus < 0.1) return 0;
  
  let baseScore = Math.max(weightedScore, globalScore);
  
  if (baseScore > 0.6 && globalScore < 0.4) {
      baseScore = (baseScore + globalScore) / 2;
  }

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

const mockDb = [
  {
    name: 'IC CEMBRA - “P. Marconi” Faver',
    address: 'Scuola primaria Faver, 1, via campagna, Faver, Altavalle, Comunità della Valle di Cembra, Provincia di Trent...',
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

console.log("Giovo Score:", scoreMatch(testInput, mockDb[1]));
console.log("Faver Score:", scoreMatch(testInput, mockDb[0]));
