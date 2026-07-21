/**
 * The redaction hard gate.
 *
 * Every outbound AI payload passes through `assertPayloadSafe` before a
 * provider is contacted. There is no bypass parameter and no "trusted caller"
 * path, because the value of a gate is exactly the set of cases it cannot be
 * asked to skip.
 *
 * On a denylist match the request is REJECTED, not sanitized. A denylisted
 * value in an outbound payload means a caller assembled data the design
 * forbids; stripping it silently would leave that defect in place and let the
 * next field through.
 */

const { DENIED_VALUE_PATTERNS, isDeniedFieldName } = require('./denylist');

const MAX_DEPTH = 8;

class RedactionBlockedError extends Error {
  constructor(violations) {
    const summary = violations
      .map((v) => `${v.type}:${v.detail}${v.path ? ` at ${v.path}` : ''}`)
      .join(', ');
    super(`AI payload blocked by redaction gate (${summary})`);
    this.name = 'RedactionBlockedError';
    this.code = 'REDACTION_BLOCKED';
    // Rule names and paths only — never the offending value, since this error
    // is logged and must not become the leak it exists to prevent.
    this.violations = violations;
  }
}

// Zero-width and bidi-control characters. Invisible, so their only purpose
// inside a value is to break a detection pattern — `0101<ZWSP>2345678` reads
// as one phone number to a human and to the provider, but not to a naive regex.
const INVISIBLE_CHARS = /[​-‏‪-‮⁠﻿]/g;

// Digit scripts that render as numerals but are not ASCII `[0-9]`, so the
// value patterns' `\d` never sees them. This is the CRITICAL one for an
// Arabic-language deployment: a phone number or national ID typed in
// Arabic-Indic numerals (٠١٢…) is completely ordinary here, and without this
// folding it would sail straight through the gate to the provider.
const DIGIT_SCRIPTS = [
  { base: 0x0660, name: 'arabic-indic' },        // ٠-٩
  { base: 0x06f0, name: 'extended-arabic-indic' }, // ۰-۹ (Persian/Urdu)
  { base: 0xff10, name: 'fullwidth' },            // ０-９
];

/** Fold every non-ASCII digit script to ASCII, position-for-position. */
function foldDigits(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    let folded = ch;
    for (const { base } of DIGIT_SCRIPTS) {
      if (cp >= base && cp <= base + 9) {
        folded = String(cp - base);
        break;
      }
    }
    out += folded;
  }
  return out;
}

/**
 * Normalize text so an evaded structured value cannot hide.
 *
 *   - non-ASCII digit scripts are folded to ASCII;
 *   - invisible characters are removed;
 *   - separators BETWEEN digits are collapsed, so `0101-234-5678`,
 *     `0101 234 5678`, `0101/234/5678`, and comma-joined digit runs all scan
 *     the same as `01012345678`.
 *
 * The normalized variants are scanned IN ADDITION to the original text, never
 * instead of it, so ordinary prose is still checked verbatim.
 */
function normalizedVariants(text) {
  const original = String(text ?? '');
  const folded = foldDigits(original).replace(INVISIBLE_CHARS, '');
  // Collapse anything that is not a digit when it sits between two digits —
  // covers spaces, hyphens, dots, slashes, commas, parentheses, and NBSP.
  const digitsCollapsed = folded.replace(/(\d)[^\d\n]{1,3}(?=\d)/g, '$1');

  const variants = new Set([original, folded, digitsCollapsed]);
  return [...variants];
}

/**
 * Scan free text for denylisted value patterns.
 * @returns {Array<{type: string, detail: string, path?: string}>}
 */
function scanText(text, path = '') {
  const violations = [];
  const value = String(text ?? '');
  if (!value) return violations;

  const seen = new Set();
  for (const variant of normalizedVariants(value)) {
    for (const { name, pattern } of DENIED_VALUE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(variant) && !seen.has(name)) {
        seen.add(name);
        violations.push({ type: 'value_pattern', detail: name, path });
      }
      pattern.lastIndex = 0;
    }
  }

  return violations;
}

/**
 * Scan the exact JSON bytes that will be sent to the provider.
 *
 * This is what closes two structural evasions that a walk of `Object.entries`
 * cannot:
 *
 *   - **`toJSON` bypass.** A Mongoose document, or any object with a `toJSON`
 *     method or a getter, serializes to something different from its own
 *     enumerable properties. `JSON.stringify` is exactly what the adapters
 *     call, so scanning its output scans reality.
 *   - **Numeric values.** A 14-digit national id passed as a Number never hits
 *     the string scanner during the structural walk, but it appears as a digit
 *     run in the serialized JSON, where the value patterns catch it.
 *
 * A circular or non-serializable payload throws here; that is treated as a
 * block, because something that cannot be represented as the outbound bytes has
 * no business being sent as them.
 */
function scanSerialized(payload, path = 'serialized') {
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (error) {
    return [{ type: 'structure', detail: `not_serializable: ${error.message}`, path }];
  }
  if (!json) return [];

  const violations = [];

  // Re-parse and run the full structural scan on the REAL outbound object.
  // `JSON.parse(JSON.stringify(x))` resolves `toJSON`/getters and drops
  // functions and symbols, so a denied field name that only appears in the
  // serialized form (a Mongoose virtual, say) is now visible to the field-name
  // check that a walk of the original object's own properties would miss.
  try {
    violations.push(...scanPayload(JSON.parse(json), path));
  } catch {
    // Unreachable in practice — `json` came from `JSON.stringify` — but a parse
    // failure is treated as a block rather than a silent pass.
    return [{ type: 'structure', detail: 'reparse_failed', path }];
  }

  // Scan the raw JSON text too, so a personal value passed as a NUMBER — which
  // the structural walk skips — is caught as a digit run in the bytes.
  violations.push(...scanText(json, path));

  return violations;
}

/**
 * Recursively inspect a payload for denylisted field names and value patterns.
 */
function scanPayload(payload, path = '', depth = 0) {
  const violations = [];

  if (payload === null || payload === undefined) return violations;

  if (depth > MAX_DEPTH) {
    // An unexpectedly deep object is itself suspicious: the MVP payloads are
    // shallow, so refusing is safer than scanning partially and passing.
    return [{ type: 'structure', detail: 'max_depth_exceeded', path }];
  }

  if (typeof payload === 'string') {
    return scanText(payload, path);
  }

  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return violations;
  }

  if (Buffer.isBuffer(payload)) {
    // Raw uploads never go to a provider in any phase.
    return [{ type: 'binary', detail: 'buffer_not_permitted', path }];
  }

  if (Array.isArray(payload)) {
    payload.forEach((entry, index) => {
      violations.push(...scanPayload(entry, `${path}[${index}]`, depth + 1));
    });
    return violations;
  }

  if (typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      const childPath = path ? `${path}.${key}` : key;

      if (isDeniedFieldName(key)) {
        violations.push({ type: 'denied_field', detail: key, path: childPath });
        // Do not descend: the field itself is already disqualifying.
        continue;
      }

      violations.push(...scanPayload(value, childPath, depth + 1));
    }
    return violations;
  }

  return violations;
}

/**
 * The gate. Throws `RedactionBlockedError` if anything denylisted is present.
 *
 * @param {any} payload  the exact object that would be serialized to the provider
 * @returns {{ safe: true, checkedAt: Date }}
 */
function assertPayloadSafe(payload) {
  // Structural walk (field names + string values) AND a scan of the exact
  // outbound bytes (catches toJSON/getter output and numeric values).
  const violations = [...scanPayload(payload), ...scanSerialized(payload)];
  if (violations.length > 0) {
    throw new RedactionBlockedError(violations);
  }
  return { safe: true, checkedAt: new Date() };
}

/**
 * Non-throwing form, for reporting and tests.
 */
function inspectPayload(payload) {
  const violations = [...scanPayload(payload), ...scanSerialized(payload)];
  return { safe: violations.length === 0, violations };
}

/**
 * Reverse-leak check on model OUTPUT.
 *
 * A model can echo or hallucinate something that looks like personal data.
 * Output is treated with the same suspicion as input, so the same value
 * patterns are applied before anything is returned to a client.
 */
function assertOutputSafe(output) {
  const violations = [...scanPayload(output), ...scanSerialized(output)];
  if (violations.length > 0) {
    throw new RedactionBlockedError(violations);
  }
  return { safe: true };
}

/**
 * Mask denylisted value patterns in a string.
 *
 * Used for audit metadata and log lines — never as a way to make an unsafe
 * payload sendable (`assertPayloadSafe` remains the gate).
 *
 * The input is first digit-folded and stripped of invisible characters, so an
 * Arabic-Indic or zero-width-split value is masked rather than deposited in the
 * clear. The returned string is therefore digit-normalized; that is acceptable
 * for telemetry, where the goal is non-leakage, not byte-fidelity.
 */
function maskText(text) {
  let masked = foldDigits(String(text ?? '')).replace(INVISIBLE_CHARS, '');

  // First mask contiguous matches, then a separator-tolerant second pass so
  // `0101-234-5678` is masked as one value rather than left in the clear.
  for (const { name, pattern } of DENIED_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, `[redacted:${name}]`);
    pattern.lastIndex = 0;
  }

  // A run of 10+ digits, contiguous or lightly separated (hyphen/space/comma),
  // is masked wholesale. `[^\d\n]{0,3}` allows zero separators, so a partly
  // contiguous form like `0101-234-5678` is caught, not just fully separated
  // ones.
  masked = masked.replace(/\d(?:[^\d\n]{0,3}\d){9,}/g, '[redacted:digit-run]');

  return masked;
}

module.exports = {
  assertPayloadSafe,
  assertOutputSafe,
  inspectPayload,
  scanText,
  maskText,
  RedactionBlockedError,
};
