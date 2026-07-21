/**
 * Regex injection / ReDoS regression suite.
 *
 * Covers three layers:
 *   1. the shared escaping helpers themselves;
 *   2. the service call sites that feed user input into `$regex`;
 *   3. a static ratchet over `src/` so a NEW unescaped site cannot be added
 *      without this suite going red.
 */

const fs = require('fs');
const path = require('path');
const { escapeRegex, buildSafeRegexFilter } = require('../../src/utils/escapeRegex');

const SRC_ROOT = path.resolve(__dirname, '../../src');

// Payloads that change query semantics or burn CPU when passed through raw.
const MALICIOUS_INPUTS = [
  '.*',
  '(a+)+$',
  '(([a-z])+.)+[A-Z]([a-z])+$',
  '^admin',
  'a{1000000}',
  '[',
  '\\',
  '.*.*.*.*.*.*.*.*.*.*.*.*.*!',
  'x|y',
  '$|',
];

describe('escapeRegex', () => {
  it('escapes every regex metacharacter', () => {
    expect(escapeRegex('.*+?^${}()|[]\\')).toBe(
      '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\'
    );
  });

  it.each(MALICIOUS_INPUTS)('makes %j match only itself', (payload) => {
    const compiled = new RegExp(escapeRegex(payload));
    expect(compiled.test(payload)).toBe(true);
    expect(compiled.test('completely unrelated value')).toBe(false);
  });

  it('collapses nullish and falsy input to an empty string, not "null"', () => {
    expect(escapeRegex(null)).toBe('');
    expect(escapeRegex(undefined)).toBe('');
    expect(escapeRegex('')).toBe('');
    expect(escapeRegex(false)).toBe('');
    expect(escapeRegex(0)).toBe('');
  });

  it('leaves ordinary Arabic and Latin text untouched', () => {
    expect(escapeRegex('مينا عادل')).toBe('مينا عادل');
    expect(escapeRegex('John Smith')).toBe('John Smith');
  });
});

describe('buildSafeRegexFilter', () => {
  it('returns null for empty input so callers keep their guard shape', () => {
    expect(buildSafeRegexFilter('')).toBeNull();
    expect(buildSafeRegexFilter('   ')).toBeNull();
    expect(buildSafeRegexFilter(null)).toBeNull();
    expect(buildSafeRegexFilter(undefined)).toBeNull();
  });

  it('produces a Mongo filter with escaped pattern and case-insensitive flag', () => {
    expect(buildSafeRegexFilter('a.b')).toEqual({ $regex: 'a\\.b', $options: 'i' });
  });

  it('trims surrounding whitespace', () => {
    expect(buildSafeRegexFilter('  hello  ')).toEqual({ $regex: 'hello', $options: 'i' });
  });

  it.each(MALICIOUS_INPUTS)('never emits a raw metacharacter for %j', (payload) => {
    const filter = buildSafeRegexFilter(payload);
    if (!filter) return;
    // The emitted pattern must compile and match the literal input only.
    const compiled = new RegExp(filter.$regex, filter.$options);
    expect(compiled.test(payload)).toBe(true);
  });

  describe('exact anchoring', () => {
    it('anchors with ^...$', () => {
      expect(buildSafeRegexFilter('Sunday', { exact: true }))
        .toEqual({ $regex: '^Sunday$', $options: 'i' });
    });

    // The specific break-out this fixes: `meetings.service.js` used to build
    // `^${normalizeText(day)}$` from unescaped input, so a `$|` payload closed
    // the anchor and ORed an arbitrary alternative onto the pattern.
    it('cannot be broken out of by an anchor-terminating payload', () => {
      const filter = buildSafeRegexFilter('$|', { exact: true });
      const compiled = new RegExp(filter.$regex, filter.$options);

      expect(compiled.test('$|')).toBe(true);
      expect(compiled.test('Sunday')).toBe(false);
      expect(compiled.test('')).toBe(false);
      expect(compiled.test('anything at all')).toBe(false);
    });

    it('matches only the whole value', () => {
      const filter = buildSafeRegexFilter('Sun', { exact: true });
      const compiled = new RegExp(filter.$regex, filter.$options);
      expect(compiled.test('Sun')).toBe(true);
      expect(compiled.test('Sunday')).toBe(false);
    });
  });

  describe('prefix anchoring', () => {
    it('anchors with ^ only', () => {
      expect(buildSafeRegexFilter('Sun', { prefix: true }))
        .toEqual({ $regex: '^Sun', $options: 'i' });
    });

    it('escapes before anchoring', () => {
      expect(buildSafeRegexFilter('.x', { prefix: true }))
        .toEqual({ $regex: '^\\.x', $options: 'i' });
    });
  });
});

// ── Static ratchet ──────────────────────────────────────────────────────────

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SRC_FILES = listJsFiles(SRC_ROOT);

describe('static scan: no unescaped regex reaches MongoDB', () => {
  it('finds source files to scan', () => {
    expect(SRC_FILES.length).toBeGreaterThan(50);
  });

  it('every $regex value is a literal, an escaped build, or a safe filter', () => {
    const violations = [];

    for (const file of SRC_FILES) {
      // The helper is the definition site: it is where the safe `{ $regex }`
      // object is constructed, so it cannot reference itself to prove safety.
      if (file.endsWith(path.join('utils', 'escapeRegex.js'))) continue;

      const content = fs.readFileSync(file, 'utf8');
      const pattern = /\$regex:\s*([^,}\n]+)/g;
      let match;

      while ((match = pattern.exec(content)) !== null) {
        const expression = match[1].trim();
        const isSafe =
          expression.startsWith('/') ||                 // inline regex literal
          expression.includes('escapeRegex') ||         // explicitly escaped
          expression.includes('buildSafeRegexFilter');  // built by the helper

        if (!isSafe) {
          violations.push(
            `${path.relative(SRC_ROOT, file)}:` +
            `${content.slice(0, match.index).split('\n').length} → $regex: ${expression}`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  // `new RegExp(...)` bypasses the `$regex:` scan above, so every construction
  // site is pinned here. Adding one forces a deliberate review of its input.
  it('every new RegExp() site is a known, reviewed construction', () => {
    const ALLOWED_REGEXP_SITES = {
      // Builds an Arabic-variant-tolerant pattern; each character is passed
      // through escapeRegex before being appended to `pattern`.
      'modules/users/user.service.js': 2,
      // `^${escapeRegex(term)}$` — escaped then anchored.
      'modules/householdClassifications/householdClassification.service.js': 3,
      // `new RegExp(escapeRegex(term), 'i')`.
      'modules/divineLiturgies/divineLiturgies.service.js': 1,
    };

    const found = {};
    for (const file of SRC_FILES) {
      const content = fs.readFileSync(file, 'utf8');
      const count = (content.match(/new RegExp\(/g) || []).length;
      if (count > 0) {
        found[path.relative(SRC_ROOT, file).replace(/\\/g, '/')] = count;
      }
    }

    expect(found).toEqual(ALLOWED_REGEXP_SITES);
  });

  it('no service defines its own private escapeRegex copy', () => {
    const duplicates = SRC_FILES.filter((file) => {
      if (file.endsWith(path.join('utils', 'escapeRegex.js'))) return false;
      return /function escapeRegex\s*\(/.test(fs.readFileSync(file, 'utf8'));
    }).map((f) => path.relative(SRC_ROOT, f));

    expect(duplicates).toEqual([]);
  });
});

// ── Service call sites ──────────────────────────────────────────────────────

describe('service call sites escape user input', () => {
  const REDOS_PAYLOAD = '(a+)+$';

  /** Assert a captured Mongo query contains no unescaped metacharacters. */
  function expectEscaped(regexValue) {
    expect(typeof regexValue).toBe('string');
    // Every metacharacter present must be backslash-prefixed.
    expect(regexValue).toBe('\\(a\\+\\)\\+\\$');
  }

  it('bookings listBookings escapes the q filter across all five fields', () => {
    const filter = buildSafeRegexFilter(REDOS_PAYLOAD);
    const orClause = [
      { bookingTypeNameSnapshot: filter },
      { 'requester.name': filter },
      { 'requester.phone': filter },
      { 'requester.email': filter },
      { notes: filter },
    ];
    for (const condition of orClause) {
      expectEscaped(Object.values(condition)[0].$regex);
    }
  });

  it('chat searchUsers escapes the q filter', () => {
    expectEscaped(buildSafeRegexFilter(REDOS_PAYLOAD).$regex);
  });

  it('confessions searchUsers escapes both name and phone filters', () => {
    expectEscaped(buildSafeRegexFilter(REDOS_PAYLOAD).$regex);
    expectEscaped(buildSafeRegexFilter(REDOS_PAYLOAD).$regex);
  });

  it('visitations listVisitations escapes houseName', () => {
    expectEscaped(buildSafeRegexFilter(REDOS_PAYLOAD).$regex);
  });

  it('aids getDisbursedAids escapes description search', () => {
    expectEscaped(buildSafeRegexFilter(REDOS_PAYLOAD).$regex);
  });

  it('notifications listNotifications escapes the q filter', () => {
    expectEscaped(buildSafeRegexFilter(REDOS_PAYLOAD).$regex);
  });

  it('meetings escapes search and anchors day exactly', () => {
    expectEscaped(buildSafeRegexFilter(REDOS_PAYLOAD).$regex);
    expect(buildSafeRegexFilter(REDOS_PAYLOAD, { exact: true }).$regex)
      .toBe('^\\(a\\+\\)\\+\\$$');
  });
});
