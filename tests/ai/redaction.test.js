/**
 * The redaction hard gate.
 *
 * Every value in this file is synthetic. No real personal data is used, and
 * the patterns are exercised with obviously-fabricated values.
 */

const {
  assertPayloadSafe,
  assertOutputSafe,
  inspectPayload,
  scanText,
  maskText,
  RedactionBlockedError,
} = require('../../src/modules/ai/safety/redaction.service');
const { DENIED_FIELD_NAMES } = require('../../src/modules/ai/safety/denylist');

describe('denied field names', () => {
  const SAFE_PAYLOAD = { notificationTypeName: 'إعلان', bulletPoints: ['نقطة أولى'] };

  it('accepts a payload built only from admin-typed content', () => {
    expect(() => assertPayloadSafe(SAFE_PAYLOAD)).not.toThrow();
  });

  // Each of these is a field the design says must never reach a provider.
  it.each([
    ['notes', { notes: 'pastoral note' }],
    ['nationalId', { nationalId: '12345678901234' }],
    ['phonePrimary', { phonePrimary: 'x' }],
    ['email', { email: 'x' }],
    ['address', { address: 'x' }],
    ['monthlyIncome', { monthlyIncome: 1 }],
    ['healthConditions', { healthConditions: [] }],
    ['apiKey', { apiKey: 'x' }],
    ['refreshToken', { refreshToken: 'x' }],
    ['birthDate', { birthDate: '2000-01-01' }],
    ['attachments', { attachments: [] }],
    ['message', { message: 'private chat' }],
  ])('blocks a payload containing %s', (_label, payload) => {
    expect(() => assertPayloadSafe(payload)).toThrow(RedactionBlockedError);
  });

  it('blocks a denied field regardless of letter case', () => {
    expect(() => assertPayloadSafe({ NationalID: 'x' })).toThrow(RedactionBlockedError);
    expect(() => assertPayloadSafe({ PHONEPRIMARY: 'x' })).toThrow(RedactionBlockedError);
  });

  it('blocks a denied field nested deep inside the payload', () => {
    const payload = { a: { b: { c: { d: { notes: 'hidden' } } } } };
    expect(() => assertPayloadSafe(payload)).toThrow(RedactionBlockedError);
  });

  it('blocks a denied field inside an array element', () => {
    expect(() => assertPayloadSafe({ items: [{ ok: 1 }, { nationalId: 'x' }] }))
      .toThrow(RedactionBlockedError);
  });

  it('rejects rather than strips, so the caller learns it built a bad payload', () => {
    // A gate that silently sanitized would leave the upstream defect in place.
    let thrown = null;
    try {
      assertPayloadSafe({ bulletPoints: ['ok'], notes: 'secret' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RedactionBlockedError);
    expect(thrown.violations[0]).toMatchObject({ type: 'denied_field', detail: 'notes' });
  });

  it('never puts the offending value into the error', () => {
    let thrown = null;
    try {
      assertPayloadSafe({ notes: 'THE-SECRET-VALUE' });
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify(thrown.violations)).not.toContain('THE-SECRET-VALUE');
    expect(thrown.message).not.toContain('THE-SECRET-VALUE');
  });

  it('covers every documented denied field name', () => {
    for (const field of DENIED_FIELD_NAMES) {
      expect(() => assertPayloadSafe({ [field]: 'value' })).toThrow(RedactionBlockedError);
    }
  });

  it('blocks a raw buffer outright', () => {
    expect(() => assertPayloadSafe({ upload: Buffer.from('binary') }))
      .toThrow(RedactionBlockedError);
  });

  it('refuses an implausibly deep object instead of scanning it partially', () => {
    let deep = { value: 'x' };
    for (let i = 0; i < 15; i += 1) deep = { nested: deep };
    expect(() => assertPayloadSafe(deep)).toThrow(RedactionBlockedError);
  });
});

describe('denied value patterns in free text', () => {
  // Synthetic values, constructed to match the pattern shape only.
  it.each([
    ['Egyptian national id', 'رقم 29001011234567 هنا'],
    ['Egyptian mobile', 'اتصل على 01012345678'],
    ['email address', 'contact person@example.com please'],
    ['IBAN', 'account EG380019000500000000263180002'],
    ['Anthropic key', 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA'],
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
  ])('blocks %s appearing in an otherwise allowed field', (_label, text) => {
    expect(() => assertPayloadSafe({ bulletPoints: [text] })).toThrow(RedactionBlockedError);
  });

  it('allows ordinary Arabic announcement text', () => {
    const payload = {
      notificationTypeName: 'إعلان عام',
      bulletPoints: [
        'قداس يوم الأحد الساعة السابعة صباحاً',
        'اجتماع الشباب بعد القداس مباشرة',
        'يرجى الحضور مبكراً',
      ],
    };
    expect(() => assertPayloadSafe(payload)).not.toThrow();
  });

  it('allows numbers that are not identifiers', () => {
    expect(() => assertPayloadSafe({ bulletPoints: ['عدد الحاضرين 250 شخصاً'] })).not.toThrow();
    expect(() => assertPayloadSafe({ metrics: [{ key: 'a', value: 1234 }] })).not.toThrow();
  });

  it('reports the path of the offending value', () => {
    const { safe, violations } = inspectPayload({ bulletPoints: ['ok', 'mail me at a@b.com'] });
    expect(safe).toBe(false);
    expect(violations[0].path).toBe('bulletPoints[1]');
    expect(violations[0].detail).toBe('email_address');
  });

  it('is stateless across calls despite global regex flags', () => {
    // A /g regex carries lastIndex; a leaked one would make every second call
    // silently pass. This asserts the reset is real.
    const text = 'contact a@b.com';
    for (let i = 0; i < 5; i += 1) {
      expect(scanText(text).length).toBeGreaterThan(0);
    }
  });
});

describe('output redaction (reverse leak)', () => {
  it('accepts a clean draft', () => {
    const draft = {
      ar: { title: 'إعلان', summary: 'ملخص' },
      en: { title: 'Notice', summary: 'Summary' },
      tone: 'formal',
      confidence: 'high',
    };
    expect(() => assertOutputSafe(draft)).not.toThrow();
  });

  it('blocks a model response that echoed a phone number', () => {
    const draft = {
      ar: { title: 'إعلان', summary: 'اتصل على 01012345678' },
      en: { title: 'Notice', summary: 'Summary' },
    };
    expect(() => assertOutputSafe(draft)).toThrow(RedactionBlockedError);
  });

  it('blocks a model response that invented a national id', () => {
    expect(() => assertOutputSafe({ text: 'الرقم القومي 29001011234567' }))
      .toThrow(RedactionBlockedError);
  });
});

describe('maskText', () => {
  it('masks matched patterns for safe logging', () => {
    const masked = maskText('call 01012345678 or mail a@b.com');
    expect(masked).not.toContain('01012345678');
    expect(masked).not.toContain('a@b.com');
    expect(masked).toContain('[redacted:');
  });

  it('leaves clean text unchanged', () => {
    expect(maskText('قداس الأحد')).toBe('قداس الأحد');
  });
});

describe('evasion resistance (hardening from adversarial review)', () => {
  // A Mongoose-style object serializes via toJSON to something other than its
  // own enumerable props; the gate must scan the outbound bytes, not the walk.
  it('blocks a toJSON that reveals a denied field', () => {
    const sneaky = {
      safeLabel: 'ok',
      toJSON() { return { notes: 'confession text', safeLabel: 'ok' }; },
    };
    expect(() => assertPayloadSafe({ record: sneaky })).toThrow(RedactionBlockedError);
  });

  it('blocks a toJSON that reveals a personal value', () => {
    const sneaky = { toJSON() { return { ref: 'call 01012345678' }; } };
    expect(() => assertPayloadSafe({ record: sneaky })).toThrow(RedactionBlockedError);
  });

  // A national id passed as a Number never hits the string scanner on the walk,
  // but appears as a digit run in the serialized JSON.
  it('blocks a national id passed as a number', () => {
    expect(() => assertPayloadSafe({ someId: 29901011234567 })).toThrow(RedactionBlockedError);
  });

  it('blocks a phone number hidden by a zero-width space', () => {
    expect(() => assertPayloadSafe({ bulletPoints: ['call 0101​2345678'] }))
      .toThrow(RedactionBlockedError);
  });

  it('blocks a phone number split by hyphens', () => {
    expect(() => assertPayloadSafe({ bulletPoints: ['call 0101-234-5678'] }))
      .toThrow(RedactionBlockedError);
  });

  it('blocks a phone number split by spaces', () => {
    expect(() => assertPayloadSafe({ bulletPoints: ['call 0101 234 5678'] }))
      .toThrow(RedactionBlockedError);
  });

  it('blocks a circular / non-serializable payload rather than passing it', () => {
    const circular = { a: 1 };
    circular.self = circular;
    expect(() => assertPayloadSafe(circular)).toThrow(RedactionBlockedError);
  });

  // Regression guard: the hardening must not start rejecting legitimate output.
  it('still accepts an ordinary announcement with numbers and dates', () => {
    const draft = {
      ar: { title: 'قداس الأحد', summary: 'الساعة 7 صباحاً، عدد المقاعد 250' },
      en: { title: 'Sunday Liturgy', summary: 'At 7am, 250 seats' },
      tone: 'formal',
      confidence: 'high',
    };
    expect(() => assertOutputSafe(draft)).not.toThrow();
  });

  it('still accepts an aggregate metrics snapshot', () => {
    const snapshot = {
      period: 'month', scope: 'site',
      metrics: [
        { key: 'total_sessions', label: 'الجلسات', value: 1234 },
        { key: 'unique_visitors', label: 'الزوار', value: 567 },
      ],
    };
    expect(() => assertPayloadSafe(snapshot)).not.toThrow();
  });
});

describe('denylist covers the app\'s real PII field names', () => {
  // These are the actual field names from user.model.js that the first pass
  // missed; a future feature passing a user subdocument must be stopped.
  it.each([
    'fullName', 'whatsappNumber', 'jobTitle', 'employerName', 'schoolName',
    'universityName', 'travelDestination', 'customDetails', 'father', 'city',
    'governorate', 'conditions',
  ])('blocks a payload containing %s', (field) => {
    expect(() => assertPayloadSafe({ [field]: 'value' })).toThrow(RedactionBlockedError);
  });
});

describe('non-ASCII digit evasion (critical, from confirmation review)', () => {
  // This is the headline hole: in an Arabic app a phone number or national ID
  // is normally typed in Arabic-Indic numerals, which ASCII \d never sees.
  it('blocks a phone number in Arabic-Indic digits', () => {
    expect(() => assertPayloadSafe({ bulletPoints: ['اتصل ٠١٠١٢٣٤٥٦٧٨'] }))
      .toThrow(RedactionBlockedError);
  });

  it('blocks a national id in Arabic-Indic digits', () => {
    expect(() => assertPayloadSafe({ x: '٢٩٠٠١٠١١٢٣٤٥٦٧' })).toThrow(RedactionBlockedError);
  });

  it('blocks extended Arabic-Indic (Persian/Urdu) digits', () => {
    expect(() => assertPayloadSafe({ x: '۰۱۰۱۲۳۴۵۶۷۸' })).toThrow(RedactionBlockedError);
  });

  it('blocks fullwidth digits', () => {
    expect(() => assertPayloadSafe({ x: '０１０１２３４５６７８' })).toThrow(RedactionBlockedError);
  });

  it('blocks a national id smuggled as an array of digit numbers', () => {
    expect(() => assertPayloadSafe({ x: [2, 9, 0, 0, 1, 0, 1, 1, 2, 3, 4, 5, 6, 7] }))
      .toThrow(RedactionBlockedError);
  });

  it('blocks a comma-joined digit run', () => {
    expect(() => assertPayloadSafe({ x: '2,9,0,0,1,0,1,1,2,3,4,5,6,7' }))
      .toThrow(RedactionBlockedError);
  });

  it('blocks a slash-separated phone', () => {
    expect(() => assertPayloadSafe({ x: '0101/234/5678' })).toThrow(RedactionBlockedError);
  });

  // Must not start flagging legitimate Arabic announcements or metric counts.
  it('still accepts ordinary Arabic text with a small Arabic-digit time', () => {
    expect(() => assertPayloadSafe({ bulletPoints: ['قداس الأحد الساعة ٧ صباحاً'] }))
      .not.toThrow();
  });

  it('still accepts an aggregate metrics snapshot with numeric values', () => {
    expect(() => assertPayloadSafe({
      metrics: [{ key: 'a', value: 1234 }, { key: 'b', value: 5678 }],
    })).not.toThrow();
  });

  describe('maskText handles the same evasions', () => {
    it('masks an Arabic-Indic phone', () => {
      const masked = maskText('اتصل ٠١٠١٢٣٤٥٦٧٨');
      expect(masked).not.toMatch(/[٠-٩]{6,}/);
      expect(masked).toContain('[redacted:');
    });

    it('masks a hyphen-separated phone', () => {
      expect(maskText('call 0101-234-5678')).toContain('[redacted:');
      expect(maskText('call 0101-234-5678')).not.toContain('5678');
    });

    it('leaves a small standalone number alone', () => {
      expect(maskText('250 مقعد')).toBe('250 مقعد');
    });
  });
});
