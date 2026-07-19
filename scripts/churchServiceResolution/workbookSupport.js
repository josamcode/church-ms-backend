const crypto = require('crypto');

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function databaseFingerprint({ databaseName, host = '', port = '' }) {
  const payload = canonicalize({ databaseName: String(databaseName || ''), host: String(host || ''), port: String(port || '') });
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function splitList(value) {
  return String(value || '').split(/\s*[|;,]\s*/).map((entry) => entry.trim()).filter(Boolean);
}

function parseRows(value) {
  return splitList(value).map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 1);
}

module.exports = { canonicalize, databaseFingerprint, splitList, parseRows };
