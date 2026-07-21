/**
 * Feature-level server-side validation.
 *
 * Schema conformance proves shape. These are the checks that decide whether a
 * well-formed response is actually usable and truthful.
 */

jest.mock('../../src/config/env', () => ({
  env: 'test',
  isProduction: false,
  ai: {
    enabled: true,
    features: { notificationDraft: true, analyticsNarrative: true, importAmbiguity: true },
    providers: {
      anthropic: { enabled: true, apiKey: 'k', baseUrl: 'https://x', version: '2023-06-01' },
      openai: { enabled: true, apiKey: 'k', baseUrl: 'https://x' },
      gemini: { enabled: false, apiKey: '', billingAccountVerified: false },
    },
    limits: { requestTimeoutMs: 1000, maxRetries: 1, dailySpendUsd: 5, monthlySpendUsd: 100 },
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 50 },
  },
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../src/config/redis', () => ({
  isReady: true, get: jest.fn(), incr: jest.fn(), incrby: jest.fn(), expire: jest.fn(),
}));

const { postValidate: validateDraft } = require('../../src/modules/ai/features/notificationDraft.feature');
const { buildPostValidate } = require('../../src/modules/ai/features/analyticsNarrative.feature');
const {
  postValidate: validateAmbiguity,
  pseudonymizeComparison,
  COMPARABLE_FIELDS,
} = require('../../src/modules/ai/features/importAmbiguity.feature');

// ── MVP-1 ───────────────────────────────────────────────────────────────────

describe('notification draft post-validation', () => {
  const VALID = {
    ar: { title: 'إعلان القداس', summary: 'قداس يوم الأحد الساعة السابعة صباحاً' },
    en: { title: 'Liturgy Notice', summary: 'Sunday liturgy at seven' },
    tone: 'formal',
    confidence: 'high',
  };

  it('accepts a clean draft', () => {
    expect(() => validateDraft(VALID)).not.toThrow();
  });

  it('rejects an Arabic title over the notification model limit', () => {
    const long = { ...VALID, ar: { ...VALID.ar, title: 'ع'.repeat(161) } };
    expect(() => validateDraft(long)).toThrow(/exceeds 160/);
  });

  it('rejects a summary over the limit', () => {
    const long = { ...VALID, ar: { ...VALID.ar, summary: 'ع'.repeat(501) } };
    expect(() => validateDraft(long)).toThrow(/exceeds 500/);
  });

  it('rejects HTML markup', () => {
    const html = { ...VALID, ar: { ...VALID.ar, summary: 'مرحبا <script>alert(1)</script>' } };
    expect(() => validateDraft(html)).toThrow(/HTML markup/);
  });

  it('rejects a benign-looking tag too', () => {
    expect(() => validateDraft({ ...VALID, ar: { ...VALID.ar, summary: 'نص <b>عريض</b>' } }))
      .toThrow(/HTML markup/);
  });

  // A model that silently answered in English produces a draft an admin might
  // paste without noticing the language is wrong.
  it('rejects an Arabic block that contains no Arabic', () => {
    const notArabic = { ...VALID, ar: { title: 'Notice', summary: 'Sunday liturgy' } };
    expect(() => validateDraft(notArabic)).toThrow(/does not contain Arabic/);
  });

  it('validates detail lines as well as the summary', () => {
    const draft = {
      ...VALID,
      ar: { ...VALID.ar, details: ['<img src=x onerror=alert(1)>'] },
    };
    expect(() => validateDraft(draft)).toThrow(/HTML markup/);
  });

  describe('links', () => {
    it('rejects an absolute URL rather than stripping it', () => {
      const draft = { ...VALID, ar: { ...VALID.ar, summary: 'التفاصيل على https://example.com/x' } };
      expect(() => validateDraft(draft)).toThrow(/link/i);
    });

    it('rejects a javascript: scheme', () => {
      const draft = { ...VALID, ar: { ...VALID.ar, summary: 'اضغط javascript://evil' } };
      expect(() => validateDraft(draft)).toThrow(/link/i);
    });

    it('accepts a safe same-origin relative path', () => {
      const draft = {
        ...VALID,
        ar: { ...VALID.ar, summary: 'التفاصيل على /dashboard/notifications' },
      };
      expect(() => validateDraft(draft)).not.toThrow();
    });

    it('rejects a relative path the existing sanitizer refuses', () => {
      const draft = { ...VALID, ar: { ...VALID.ar, summary: 'اذهب إلى //evil.com/x' } };
      expect(() => validateDraft(draft)).toThrow(/link/i);
    });
  });
});

// ── MVP-2 ───────────────────────────────────────────────────────────────────

describe('analytics narrative post-validation', () => {
  const SUPPLIED = ['total_sessions', 'unique_visitors'];
  const validate = buildPostValidate(SUPPLIED);

  const VALID = {
    narrative_ar: 'ارتفع عدد الجلسات هذا الشهر',
    observations: [{ statement_ar: 'إجمالي الجلسات 120', metricKey: 'total_sessions' }],
    hypotheses: [{ statement_ar: 'ربما بسبب الإعلان', certainty: 'speculative' }],
    caveats: [],
  };

  it('accepts observations citing supplied metrics', () => {
    expect(() => validate(VALID)).not.toThrow();
  });

  // This is the check that turns numeric hallucination from an undetectable
  // error into a hard rejection.
  it('rejects an observation citing a metric that was never supplied', () => {
    const invented = {
      ...VALID,
      observations: [{ statement_ar: 'المعموديات ارتفعت', metricKey: 'baptisms_total' }],
    };
    expect(() => validate(invented)).toThrow(/never supplied: baptisms_total/);
  });

  // A model that invented one metric has shown it is not grounded in the
  // payload, so the rest of its statements have not earned trust either.
  it('rejects the whole response, not just the invented observation', () => {
    const mixed = {
      ...VALID,
      observations: [
        { statement_ar: 'صحيح', metricKey: 'total_sessions' },
        { statement_ar: 'مخترع', metricKey: 'nonexistent_metric' },
      ],
    };
    expect(() => validate(mixed)).toThrow(/nonexistent_metric/);
  });

  it('reports every invented key once', () => {
    const mixed = {
      ...VALID,
      observations: [
        { statement_ar: 'a', metricKey: 'fake_one' },
        { statement_ar: 'b', metricKey: 'fake_one' },
        { statement_ar: 'c', metricKey: 'fake_two' },
      ],
    };
    expect(() => validate(mixed)).toThrow(/fake_one, fake_two/);
  });

  it('accepts an empty observations list', () => {
    expect(() => validate({ ...VALID, observations: [] })).not.toThrow();
  });

  // Hypotheses are interpretations and are not required to cite a metric.
  it('does not constrain hypotheses to supplied metric keys', () => {
    const withHypothesis = {
      ...VALID,
      hypotheses: [{ statement_ar: 'ربما موسم الأعياد', certainty: 'plausible' }],
    };
    expect(() => validate(withHypothesis)).not.toThrow();
  });

  it('rejects HTML in the narrative', () => {
    expect(() => validate({ ...VALID, narrative_ar: '<b>ارتفع</b>' })).toThrow(/HTML/);
  });

  it('rejects a narrative that is not in Arabic', () => {
    expect(() => validate({ ...VALID, narrative_ar: 'Sessions went up this month' }))
      .toThrow(/not in Arabic/);
  });

  it('rejects an over-long narrative', () => {
    expect(() => validate({ ...VALID, narrative_ar: `ع${'ع'.repeat(4100)}` }))
      .toThrow(/maximum length/);
  });
});

// ── MVP-3 ───────────────────────────────────────────────────────────────────

describe('import ambiguity pseudonymization', () => {
  const RECORD_A = {
    fullName: 'مينا عادل حنا',
    phonePrimary: '01012345678',
    birthDate: '2000-05-10',
    houseName: 'عادل',
    familyName: 'حنا',
  };
  const RECORD_B = {
    fullName: 'مينا عادل حنا',
    phonePrimary: '01012345679',
    birthDate: '2003-02-01',
    houseName: 'عادل',
    familyName: 'حنا',
  };

  // The property the whole feature rests on.
  it('emits no real value from either record', () => {
    const serialized = JSON.stringify(pseudonymizeComparison(RECORD_A, RECORD_B));

    expect(serialized).not.toContain('مينا');
    expect(serialized).not.toContain('حنا');
    expect(serialized).not.toContain('عادل');
    expect(serialized).not.toContain('01012345678');
    expect(serialized).not.toContain('01012345679');
    expect(serialized).not.toContain('2000');
    expect(serialized).not.toContain('2003');
  });

  it('passes the redaction gate that guards outbound payloads', () => {
    const { assertPayloadSafe } = require('../../src/modules/ai/safety/redaction.service');
    expect(() => assertPayloadSafe(pseudonymizeComparison(RECORD_A, RECORD_B))).not.toThrow();
  });

  it('reports name agreement without the name', () => {
    const { signals } = pseudonymizeComparison(RECORD_A, RECORD_B);
    expect(signals.find((s) => s.field === 'name').comparison).toBe('match');
  });

  it('describes phone difference as a digit-position count', () => {
    const { signals } = pseudonymizeComparison(RECORD_A, RECORD_B);
    expect(signals.find((s) => s.field === 'phonePattern').comparison)
      .toBe('same length, 1 of 11 digits differ');
  });

  it('describes birth dates as a year gap', () => {
    const { signals } = pseudonymizeComparison(RECORD_A, RECORD_B);
    expect(signals.find((s) => s.field === 'birthYearGap').comparison).toBe('3 year gap');
  });

  it('reports identical phones without revealing them', () => {
    const { signals } = pseudonymizeComparison(RECORD_A, { ...RECORD_B, phonePrimary: RECORD_A.phonePrimary });
    expect(signals.find((s) => s.field === 'phonePattern').comparison).toBe('identical');
  });

  it('handles missing values without throwing', () => {
    const { signals } = pseudonymizeComparison({}, {});
    expect(signals).toHaveLength(5);
    expect(signals.every((s) => typeof s.comparison === 'string')).toBe(true);
  });

  it('reports differing phone lengths', () => {
    const { signals } = pseudonymizeComparison(
      { phonePrimary: '0101234567' },
      { phonePrimary: '01012345678' }
    );
    expect(signals.find((s) => s.field === 'phonePattern').comparison).toBe('different lengths');
  });

  it('only ever emits the comparable fields', () => {
    const { signals } = pseudonymizeComparison(RECORD_A, RECORD_B);
    signals.forEach((signal) => expect(COMPARABLE_FIELDS).toContain(signal.field));
  });
});

describe('import ambiguity post-validation', () => {
  const VALID = {
    verdict: 'unclear',
    confidence: 'low',
    reasoning_ar: 'الأسماء متطابقة لكن تاريخ الميلاد مختلف',
    signals: [{ field: 'name', agreement: 'match' }],
  };

  it('accepts a well-formed explanation', () => {
    expect(() => validateAmbiguity(VALID)).not.toThrow();
  });

  it('rejects a signal field outside the comparable set', () => {
    const bad = { ...VALID, signals: [{ field: 'nationalId', agreement: 'match' }] };
    expect(() => validateAmbiguity(bad)).toThrow(/unknown fields/);
  });

  it('rejects HTML', () => {
    expect(() => validateAmbiguity({ ...VALID, reasoning_ar: '<b>x</b>' })).toThrow(/HTML/);
  });

  it('rejects over-long reasoning', () => {
    expect(() => validateAmbiguity({ ...VALID, reasoning_ar: 'ع'.repeat(1001) }))
      .toThrow(/maximum length/);
  });
});
