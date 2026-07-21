/**
 * MVP-3 — workbook ambiguity annotation.
 *
 * The two properties that matter: no record content ever leaves, and a failure
 * degrades to an unannotated workbook rather than aborting the import run.
 */

const mockConfig = {
  env: 'test',
  isProduction: false,
  // Reached transitively via quota.service -> config/redis.
  redis: { enabled: false, required: false, url: '', host: '' },
  ai: {
    enabled: true,
    features: { notificationDraft: true, analyticsNarrative: true, importAmbiguity: true },
    providers: {
      anthropic: { enabled: true, apiKey: 'placeholder', baseUrl: 'https://x', version: '2023-06-01' },
      openai: { enabled: true, apiKey: 'placeholder', baseUrl: 'https://x' },
      gemini: { enabled: false, apiKey: '', billingAccountVerified: false },
    },
    limits: { requestTimeoutMs: 1000, maxRetries: 0, dailySpendUsd: 5, monthlySpendUsd: 100 },
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 50 },
  },
};

jest.mock('../../src/config/env', () => mockConfig);
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockExplainBatch = jest.fn();
jest.mock('../../src/modules/ai/features/importAmbiguity.feature', () => {
  const actual = jest.requireActual('../../src/modules/ai/features/importAmbiguity.feature');
  return {
    ...actual,
    explainAmbiguityBatch: (...args) => mockExplainBatch(...args),
  };
});

const {
  annotateCandidateRows,
  rowToRecordPair,
} = require('../../scripts/churchServiceResolution/aiAmbiguityExplainer');
const {
  ADVISORY_COLUMNS,
  CANDIDATE_COLUMNS,
  generatedFieldsHash,
} = require('../../scripts/churchServiceResolution/workbookSchema');
const logger = require('../../src/utils/logger');

function candidateRow(overrides = {}) {
  return {
    identityKey: 'identity-1',
    sourceName: 'مينا عادل حنا',
    candidateUserId: 'user-1',
    candidateFullName: 'مينا عادل حنا',
    candidateBirthDate: '2000-05-10',
    candidateFamilyName: 'حنا',
    candidateHouseName: 'عادل',
    ...overrides,
  };
}

const OK_RESULT = {
  ok: true,
  data: {
    verdict: 'unclear',
    confidence: 'low',
    reasoning_ar: 'الاسم متطابق لكن باقي البيانات ناقصة',
    signals: [{ field: 'name', agreement: 'match' }],
  },
};

beforeEach(() => {
  mockExplainBatch.mockReset();
  mockConfig.ai.enabled = true;
  mockConfig.ai.features.importAmbiguity = true;
});

describe('opt-in behaviour', () => {
  it('does nothing at all unless explicitly enabled', async () => {
    const rows = [candidateRow()];
    await annotateCandidateRows(rows, { enabled: false });

    expect(mockExplainBatch).not.toHaveBeenCalled();
    expect(rows[0].aiAmbiguityReason).toBeUndefined();
  });

  it('does nothing when the feature flag is off', async () => {
    mockConfig.ai.features.importAmbiguity = false;
    const rows = [candidateRow()];
    await annotateCandidateRows(rows, { enabled: true });

    expect(mockExplainBatch).not.toHaveBeenCalled();
  });

  it('does nothing when AI is globally disabled', async () => {
    mockConfig.ai.enabled = false;
    await annotateCandidateRows([candidateRow()], { enabled: true });
    expect(mockExplainBatch).not.toHaveBeenCalled();
  });

  it('handles an empty row list', async () => {
    await expect(annotateCandidateRows([], { enabled: true })).resolves.toEqual([]);
    await expect(annotateCandidateRows(null, { enabled: true })).resolves.toEqual([]);
  });
});

describe('annotation', () => {
  it('fills both advisory columns from the model response', async () => {
    mockExplainBatch.mockResolvedValue([OK_RESULT]);
    const rows = [candidateRow()];

    await annotateCandidateRows(rows, { enabled: true });

    expect(rows[0].aiAmbiguityReason).toContain('غير واضح');
    expect(rows[0].aiAmbiguityReason).toContain('الاسم متطابق');
    expect(rows[0].aiConfidence).toBe('منخفضة');
  });

  it('maps each verdict to an Arabic label', async () => {
    const verdicts = ['likely_same', 'likely_different', 'unclear'];
    mockExplainBatch.mockResolvedValue(
      verdicts.map((verdict) => ({ ...OK_RESULT, data: { ...OK_RESULT.data, verdict } }))
    );
    const rows = verdicts.map(() => candidateRow());

    await annotateCandidateRows(rows, { enabled: true });

    expect(rows[0].aiAmbiguityReason).toContain('نفس الشخص');
    expect(rows[1].aiAmbiguityReason).toContain('شخصان مختلفان');
    expect(rows[2].aiAmbiguityReason).toContain('غير واضح');
  });

  it('leaves a row untouched when its explanation failed', async () => {
    mockExplainBatch.mockResolvedValue([
      OK_RESULT,
      { ok: false, error: 'provider unavailable' },
    ]);
    const rows = [candidateRow(), candidateRow({ identityKey: 'identity-2' })];

    await annotateCandidateRows(rows, { enabled: true });

    expect(rows[0].aiAmbiguityReason).toBeDefined();
    expect(rows[1].aiAmbiguityReason).toBeUndefined();
  });

  // The workbook is the deliverable; an AI outage must not stop it shipping.
  it('returns the rows unannotated when the whole batch throws', async () => {
    mockExplainBatch.mockRejectedValue(new Error('provider down'));
    const rows = [candidateRow()];

    await expect(annotateCandidateRows(rows, { enabled: true })).resolves.toBe(rows);
    expect(rows[0].aiAmbiguityReason).toBeUndefined();
  });

  it('caps the number of rows sent and says so out loud', async () => {
    mockExplainBatch.mockResolvedValue([OK_RESULT, OK_RESULT]);
    const rows = Array.from({ length: 10 }, () => candidateRow());

    await annotateCandidateRows(rows, { enabled: true, maxRows: 2 });

    expect(mockExplainBatch.mock.calls[0][0]).toHaveLength(2);
    // A silently truncated run reads as full coverage; it must be logged.
    expect(logger.warn).toHaveBeenCalledWith(
      'AI ambiguity explanation capped',
      expect.objectContaining({ total: 10, explained: 2, skipped: 8 })
    );
  });
});

describe('nothing identifying leaves the process', () => {
  it('sends only pseudonymized signals', async () => {
    mockExplainBatch.mockResolvedValue([OK_RESULT]);
    await annotateCandidateRows([candidateRow()], { enabled: true });

    const sent = JSON.stringify(mockExplainBatch.mock.calls[0][0]);

    expect(sent).not.toContain('مينا');
    expect(sent).not.toContain('حنا');
    expect(sent).not.toContain('عادل');
    expect(sent).not.toContain('2000');
    expect(sent).not.toContain('user-1');
  });

  it('sends payloads that pass the redaction gate', async () => {
    const { assertPayloadSafe } = require('../../src/modules/ai/safety/redaction.service');
    mockExplainBatch.mockResolvedValue([OK_RESULT]);

    await annotateCandidateRows([candidateRow()], { enabled: true });

    mockExplainBatch.mock.calls[0][0].forEach((payload) => {
      expect(() => assertPayloadSafe(payload)).not.toThrow();
    });
  });

  it('builds the record pair from source and candidate sides', () => {
    const [source, candidate] = rowToRecordPair(candidateRow());
    expect(source.fullName).toBe('مينا عادل حنا');
    expect(candidate.candidateUserId).toBeUndefined();
    expect(candidate.birthDate).toBe('2000-05-10');
  });
});

describe('workbook integrity', () => {
  it('registers both columns on the candidates sheet', () => {
    expect(CANDIDATE_COLUMNS).toContain('aiAmbiguityReason');
    expect(CANDIDATE_COLUMNS).toContain('aiConfidence');
  });

  it('marks them advisory', () => {
    expect(ADVISORY_COLUMNS.has('aiAmbiguityReason')).toBe(true);
    expect(ADVISORY_COLUMNS.has('aiConfidence')).toBe(true);
  });

  /**
   * The reason advisory columns exist as a category: model wording varies
   * between runs, so hashing it would make the tamper check fail every time
   * and train reviewers to ignore a signal that should mean something.
   */
  it('excludes them from the generated-fields hash', () => {
    const base = {
      identityRows: [], groupRows: [], servantRows: [], aliasRows: [], duplicateRows: [],
      candidateRows: [candidateRow()],
    };
    const annotated = {
      ...base,
      candidateRows: [candidateRow({
        aiAmbiguityReason: 'أي نص يولّده النموذج',
        aiConfidence: 'عالية',
      })],
    };

    expect(generatedFieldsHash(annotated)).toBe(generatedFieldsHash(base));
  });

  it('still changes the hash when a real generated field changes', () => {
    const base = {
      identityRows: [], groupRows: [], servantRows: [], aliasRows: [], duplicateRows: [],
      candidateRows: [candidateRow()],
    };
    const tampered = {
      ...base,
      candidateRows: [candidateRow({ candidateFullName: 'شخص آخر' })],
    };

    expect(generatedFieldsHash(tampered)).not.toBe(generatedFieldsHash(base));
  });
});

describe('CLI flag', () => {
  const { parseArgs } = require('../../scripts/generateChurchServiceResolutionWorkbook');

  it('defaults to disabled', () => {
    expect(parseArgs([]).aiExplain).toBe(false);
  });

  it('enables with --ai-explain', () => {
    expect(parseArgs(['--ai-explain']).aiExplain).toBe(true);
  });

  it('accepts a row ceiling', () => {
    expect(parseArgs(['--ai-explain', '--ai-max-rows=50']).aiMaxRows).toBe(50);
  });

  it('still rejects an unknown argument', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });
});
