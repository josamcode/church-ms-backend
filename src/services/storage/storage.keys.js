const crypto = require('crypto');
const path = require('path');

const MIME_EXTENSION_MAP = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/plain': '.txt',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
});

const normalizeSegment = (value, fallback = 'item') => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
};

const normalizePrefix = (value) =>
  String(value || '')
    .split('/')
    .map((segment) => normalizeSegment(segment))
    .filter(Boolean)
    .join('/');

const resolveExtension = ({ originalName, mimeType } = {}) => {
  const fromName = path.extname(String(originalName || '')).trim().toLowerCase();
  if (fromName && /^[.][a-z0-9]{1,12}$/.test(fromName)) {
    return fromName;
  }

  return MIME_EXTENSION_MAP[String(mimeType || '').trim().toLowerCase()] || '';
};

const createObjectKey = ({ prefix, originalName, mimeType } = {}) => {
  const safePrefix = normalizePrefix(prefix);
  const extension = resolveExtension({ originalName, mimeType });
  const stamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  const fileName = `${stamp}-${random}${extension}`;

  return safePrefix ? `${safePrefix}/${fileName}` : fileName;
};

module.exports = {
  createObjectKey,
  normalizeSegment,
  resolveExtension,
};
