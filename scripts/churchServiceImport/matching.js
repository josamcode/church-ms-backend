const { cleanExactName, normalizeArabicComparison } = require('../../src/utils/arabicNormalization');

function addToMap(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function buildNameLookup(records, nameSelector = (record) => record.fullName) {
  const exact = new Map();
  const normalized = new Map();
  for (const record of records) {
    const displayName = cleanExactName(nameSelector(record));
    addToMap(exact, displayName, record);
    addToMap(normalized, normalizeArabicComparison(displayName), record);
  }
  return { exact, normalized };
}

function resolveName(value, lookup) {
  const original = cleanExactName(value);
  const normalizedName = normalizeArabicComparison(original);
  if (!original || !normalizedName) {
    return { status: 'INVALID', original, normalizedName, candidates: [], matchMethod: '' };
  }
  const exactCandidates = lookup.exact.get(original) || [];
  if (exactCandidates.length === 1) {
    return { status: 'EXACT_MATCH', original, normalizedName, candidates: exactCandidates, matched: exactCandidates[0], matchMethod: 'EXACT' };
  }
  if (exactCandidates.length > 1) {
    return { status: 'AMBIGUOUS', original, normalizedName, candidates: exactCandidates, matchMethod: 'EXACT' };
  }
  const normalizedCandidates = lookup.normalized.get(normalizedName) || [];
  if (normalizedCandidates.length === 1) {
    return { status: 'NORMALIZED_MATCH', original, normalizedName, candidates: normalizedCandidates, matched: normalizedCandidates[0], matchMethod: 'NORMALIZED' };
  }
  if (normalizedCandidates.length > 1) {
    return { status: 'AMBIGUOUS', original, normalizedName, candidates: normalizedCandidates, matchMethod: 'NORMALIZED' };
  }
  return { status: 'MISSING', original, normalizedName, candidates: [], matchMethod: '' };
}

module.exports = { buildNameLookup, resolveName };
