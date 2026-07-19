const fs = require('fs');
const { parseCsv } = require('../churchServiceUsersImport/manualMappings');

const idOf = (value) => String(value?._id || value?.id || value || '');

function loadIdentityMappings(filePath) {
  return parseCsv(fs.readFileSync(filePath, 'utf8')).map((row) => ({
    original: row['Excel original name'],
    normalizedName: row['Normalized name'],
    currentStatus: row['Current status'],
    approvedUserId: row.approvedUserId,
    decision: String(row.decision || '').toUpperCase(),
    notes: row.notes,
    overrideExactMatch: String(row.overrideExactMatch || '').toLowerCase() === 'true',
    overrideReason: row.overrideReason || '',
  }));
}

function validateIdentityMappings(mappings, peopleMatches, users) {
  const errors = [];
  const warnings = [];
  const approved = [];
  const peopleByOriginal = new Map((peopleMatches || []).map((person) => [person.original, person]));
  const usersById = new Map((users || []).map((user) => [idOf(user), user]));
  const sourceClaims = new Map();
  const userClaims = new Map();

  for (const mapping of mappings || []) {
    if (!mapping.approvedUserId && !mapping.decision) continue;
    const person = peopleByOriginal.get(mapping.original);
    if (!person) {
      errors.push(`Unknown Excel identity: ${mapping.original || '(blank)'}`);
      continue;
    }
    if (!mapping.approvedUserId) {
      if (!['REJECT', 'SPLIT', 'DEFER'].includes(mapping.decision)) errors.push(`Decision for ${mapping.original} requires approvedUserId`);
      continue;
    }
    const user = usersById.get(mapping.approvedUserId);
    if (!user) {
      errors.push(`Approved user ${mapping.approvedUserId} for ${mapping.original} does not exist`);
      continue;
    }
    if (user.isDeleted) {
      errors.push(`Approved user ${mapping.approvedUserId} for ${mapping.original} is deleted`);
      continue;
    }
    if (!user.fullName || !user.role) {
      errors.push(`Approved user ${mapping.approvedUserId} for ${mapping.original} is not a valid church person record`);
      continue;
    }
    const previous = sourceClaims.get(mapping.original);
    if (previous && previous !== mapping.approvedUserId) {
      errors.push(`Excel identity ${mapping.original} is mapped to multiple user IDs`);
      continue;
    }
    sourceClaims.set(mapping.original, mapping.approvedUserId);

    if (['EXACT_MATCH', 'NORMALIZED_MATCH'].includes(person.status)) {
      if (!mapping.overrideExactMatch || !mapping.overrideReason) {
        errors.push(`Mapping cannot override unique ${person.status} for ${mapping.original} without overrideExactMatch=true and overrideReason`);
        continue;
      }
    }
    const listed = new Set((person.candidates || []).map((candidate) => idOf(candidate)));
    if (listed.size && !listed.has(mapping.approvedUserId)) {
      if (mapping.decision !== 'APPROVE_OUTSIDE_CANDIDATES' || !mapping.notes) {
        errors.push(`Approved user for ${mapping.original} is outside the listed candidates and lacks documented APPROVE_OUTSIDE_CANDIDATES decision`);
        continue;
      }
    } else if (!listed.size && person.status === 'MISSING') {
      if (mapping.decision !== 'APPROVE_OUTSIDE_CANDIDATES' || !mapping.notes) {
        errors.push(`Missing identity ${mapping.original} requires documented APPROVE_OUTSIDE_CANDIDATES decision`);
        continue;
      }
    }
    if (!userClaims.has(mapping.approvedUserId)) userClaims.set(mapping.approvedUserId, []);
    userClaims.get(mapping.approvedUserId).push(mapping.original);
    approved.push({ original: mapping.original, approvedUserId: mapping.approvedUserId, decision: mapping.decision, notes: mapping.notes });
  }

  for (const [userId, originals] of userClaims) {
    const distinct = [...new Set(originals)];
    if (distinct.length > 1) warnings.push(`Multiple source identities map to user ${userId}: ${distinct.join(' | ')}`);
  }
  return { valid: errors.length === 0, errors, warnings, approved };
}

module.exports = { loadIdentityMappings, validateIdentityMappings };
