/**
 * Sanitize a notification link so that only same-origin relative paths are
 * accepted.  External URLs, protocol-relative URLs, and dangerous schemes
 * (javascript:, data:, vbscript:) are rejected.
 *
 * The return value is always a relative path starting with "/" or an empty
 * string when the input is null/empty.  Callers should fall back to a safe
 * default (e.g. "/dashboard/notifications/inbox") when they receive an
 * empty string.
 */

const DANGEROUS_SCHEMES = /^(javascript|data|vbscript):/i;
const PROTOCOL_RELATIVE = /^\/\//;
const ABSOLUTE_URL = /^[a-z][a-z0-9+\-.]*:/i;

// Common encoding tricks that can hide dangerous schemes
const ENCODED_COLON = /^[a-z]+%3a/i;       // javascript%3Aalert(1)
const ENCODED_SLASH = /^[a-z]+%2f/i;       // javascript%2f%2f

function _looksLikeEncodedScheme(raw) {
  return ENCODED_COLON.test(raw) || ENCODED_SLASH.test(raw);
}

/**
 * @param {string|null|undefined} raw
 * @returns {string}  safe relative path starting with "/", or "" if input is empty
 */
function sanitizeNotificationLink(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';

  // Backslash tricks — reject
  if (value.includes('\\')) return '';

  // Encoded scheme tricks
  if (_looksLikeEncodedScheme(value)) return '';

  // Protocol-relative URL (//evil.com)
  if (PROTOCOL_RELATIVE.test(value)) return '';

  // Absolute URL with scheme (http://, https://, javascript:, data:, etc.)
  if (ABSOLUTE_URL.test(value) || DANGEROUS_SCHEMES.test(value)) {
    // Only safe scheme: same-origin relative paths
    return '';
  }

  // Must start with "/"
  if (!value.startsWith('/')) return '';

  // Prevent path traversal tricks (../../etc/passwd, /../something)
  if (value.includes('..')) return '';

  // Max reasonable length for an app path
  if (value.length > 2000) return '';

  // Must start with / followed by a non-slash char (//-style protocol-relative
  // URLs are already caught above; this is defense-in-depth).
  // Allow: alphanumeric, /, -, _, ., ~, @, :, ?, =, &, %, +, #, !, $, ', (, ), *, ,, ;
  if (!/^\/[a-zA-Z0-9\-_.~@:?&=+%#!$'()*,;][a-zA-Z0-9/\-_.~@:?&=+%#!$'()*,;]*$/.test(value)) {
    return '';
  }

  return value;
}

module.exports = { sanitizeNotificationLink };
