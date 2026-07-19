const fs = require('fs');
const { validateManualFamilyMappings } = require('./familyMatcher');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted && char === '"' && input[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, String(values[index] || '').trim()])));
}

function loadManualMappings(filePath) {
  return parseCsv(fs.readFileSync(filePath, 'utf8')).map((row) => ({
    stablePersonKey: row['Stable person key'],
    approvedFatherId: row.approvedFatherId,
    approvedMotherId: row.approvedMotherId,
    approvedHouseholdUserId: row.approvedHouseholdUserId,
    decision: row.decision.toUpperCase(),
    notes: row.notes,
  }));
}

function incorporateManualMappings(plan, mappings, existingUsers) {
  const validation = validateManualFamilyMappings(mappings, plan.identities, existingUsers);
  if (validation.errors.length) {
    validation.errors.forEach((message) => {
      const entry = { type: 'INVALID_MANUAL_FAMILY_MAPPING', severity: 'BLOCKER', stablePersonKey: '', name: '', rows: [], message };
      plan.conflicts.push(entry);
      plan.recordBlockers.push(entry);
    });
    plan.totals.recordBlockers = plan.recordBlockers.length;
    return validation;
  }
  plan.approvedAutomaticFamilyRelationships = [];
  plan.approvedManualFamilyRelationships = validation.approved.flatMap((mapping) => [
    ...(mapping.fatherId ? [{ stablePersonKey: mapping.stablePersonKey, relation: 'father', parentUserId: mapping.fatherId, evidence: ['Explicit manual approval in reviewed mapping file'] }] : []),
    ...(mapping.motherId ? [{ stablePersonKey: mapping.stablePersonKey, relation: 'mother', parentUserId: mapping.motherId, evidence: ['Explicit manual approval in reviewed mapping file'] }] : []),
  ]);
  plan.approvedManualHouseholds = validation.approved
    .filter((mapping) => mapping.householdUserId)
    .map((mapping) => ({ stablePersonKey: mapping.stablePersonKey, householdUserId: mapping.householdUserId, notes: mapping.notes }));
  return validation;
}

module.exports = { parseCsv, loadManualMappings, incorporateManualMappings };
