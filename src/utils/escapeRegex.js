/**
 * Regex-safety helpers for MongoDB queries.
 *
 * Any value that reaches a `$regex` operator is a regular expression, not a
 * literal. Passing user input through unescaped has two consequences:
 *
 *   1. **Semantic breakage** — a search for `a.b` matches `axb`, and a search
 *      containing `$` or `|` escapes an intended `^...$` exact-match anchor.
 *   2. **ReDoS** — a crafted pattern such as `(a+)+$` makes the database burn
 *      CPU on a single request. MongoDB evaluates the regex server-side, so the
 *      cost lands on the shared cluster, not the caller.
 *
 * Both are avoided by escaping every regex metacharacter before interpolation.
 * Use `escapeRegex` when you build the query object yourself; use
 * `buildSafeRegexFilter` for the common "optional search box" shape.
 */

// All ECMAScript regex metacharacters. `-` and `/` are omitted deliberately:
// `-` is only special inside a character class, and `/` only matters in literal
// notation, which is never used here.
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape every regex metacharacter in a value so it matches literally.
 *
 * Nullish, boolean-false, and zero inputs collapse to an empty string rather
 * than to the strings `"null"` / `"false"` / `"0"`, so a missing filter never
 * silently becomes a search for the word "null".
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeRegex(value) {
  return String(value || '').replace(REGEX_METACHARACTERS, '\\$&');
}

/**
 * Build a Mongo `$regex` filter from untrusted input.
 *
 * Returns `null` for empty input so callers can keep their existing
 * `if (search) { ... }` guard shape.
 *
 * @param {unknown} value            Raw user input.
 * @param {object}  [options]
 * @param {boolean} [options.exact]  Anchor with `^...$` for an exact match.
 * @param {boolean} [options.prefix] Anchor with `^` for a prefix match.
 * @param {string}  [options.options='i'] Mongo regex flags.
 * @returns {{ $regex: string, $options: string }|null}
 */
function buildSafeRegexFilter(value, { exact = false, prefix = false, options = 'i' } = {}) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  const escaped = escapeRegex(trimmed);
  let pattern = escaped;
  if (exact) pattern = `^${escaped}$`;
  else if (prefix) pattern = `^${escaped}`;

  return { $regex: pattern, $options: options };
}

module.exports = { escapeRegex, buildSafeRegexFilter, REGEX_METACHARACTERS };
