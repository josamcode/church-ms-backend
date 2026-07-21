/**
 * The structured-output hard gate.
 *
 * Model output is untrusted input. These tests pin that a response is accepted
 * only when it matches the declared shape exactly.
 */

const {
  validateAgainstSchema,
  checkAgainstSchema,
  parseModelJson,
  SchemaValidationError,
} = require('../../src/modules/ai/schemas/schema.validator');

const { NOTIFICATION_DRAFT_SCHEMA } = require('../../src/modules/ai/schemas/notificationDraft.schema');
const { ANALYTICS_NARRATIVE_SCHEMA } = require('../../src/modules/ai/schemas/analyticsNarrative.schema');
const { IMPORT_AMBIGUITY_SCHEMA } = require('../../src/modules/ai/schemas/importAmbiguity.schema');

const VALID_DRAFT = {
  ar: { title: 'إعلان', summary: 'ملخص الإعلان', details: ['تفصيل'] },
  en: { title: 'Notice', summary: 'Summary', details: ['detail'] },
  tone: 'formal',
  confidence: 'high',
  warnings: [],
};

describe('validateAgainstSchema', () => {
  it('accepts a conforming object', () => {
    expect(() => validateAgainstSchema(VALID_DRAFT, NOTIFICATION_DRAFT_SCHEMA, 'draft')).not.toThrow();
  });

  it('rejects a missing required property', () => {
    const { tone, ...withoutTone } = VALID_DRAFT;
    expect(() => validateAgainstSchema(withoutTone, NOTIFICATION_DRAFT_SCHEMA, 'draft'))
      .toThrow(SchemaValidationError);
  });

  it('rejects a missing nested required property', () => {
    const broken = { ...VALID_DRAFT, ar: { summary: 'no title' } };
    const { valid, errors } = checkAgainstSchema(broken, NOTIFICATION_DRAFT_SCHEMA);
    expect(valid).toBe(false);
    expect(errors.join()).toContain('ar.title');
  });

  it('rejects a value outside an enum', () => {
    const broken = { ...VALID_DRAFT, tone: 'sarcastic' };
    expect(() => validateAgainstSchema(broken, NOTIFICATION_DRAFT_SCHEMA, 'draft'))
      .toThrow(/not in enum/);
  });

  // additionalProperties: false is the guard against a model smuggling extra
  // keys into an object the application will later spread or persist.
  it('rejects an unexpected top-level property', () => {
    const broken = { ...VALID_DRAFT, injectedField: 'surprise' };
    expect(() => validateAgainstSchema(broken, NOTIFICATION_DRAFT_SCHEMA, 'draft'))
      .toThrow(/unexpected property/);
  });

  it('rejects an unexpected nested property', () => {
    const broken = { ...VALID_DRAFT, ar: { ...VALID_DRAFT.ar, sneaky: 'x' } };
    expect(() => validateAgainstSchema(broken, NOTIFICATION_DRAFT_SCHEMA, 'draft'))
      .toThrow(/unexpected property/);
  });

  it('rejects a wrong type', () => {
    const broken = { ...VALID_DRAFT, ar: { title: 42, summary: 'x' } };
    expect(() => validateAgainstSchema(broken, NOTIFICATION_DRAFT_SCHEMA, 'draft'))
      .toThrow(/expected string/);
  });

  it('rejects an array where an object is required', () => {
    expect(() => validateAgainstSchema([], NOTIFICATION_DRAFT_SCHEMA, 'draft'))
      .toThrow(/expected object, received array/);
  });

  it('rejects null', () => {
    expect(() => validateAgainstSchema(null, NOTIFICATION_DRAFT_SCHEMA, 'draft'))
      .toThrow(SchemaValidationError);
  });

  it('validates array item shape', () => {
    const broken = { ...VALID_DRAFT, ar: { ...VALID_DRAFT.ar, details: [123] } };
    expect(() => validateAgainstSchema(broken, NOTIFICATION_DRAFT_SCHEMA, 'draft'))
      .toThrow(/expected string/);
  });

  it('names the schema in the error so the failure is attributable', () => {
    try {
      validateAgainstSchema({}, NOTIFICATION_DRAFT_SCHEMA, 'NotificationDraft');
    } catch (error) {
      expect(error.errors[0]).toContain('NotificationDraft');
    }
  });
});

describe('analytics narrative schema', () => {
  const VALID = {
    narrative_ar: 'سرد',
    observations: [{ statement_ar: 'ملاحظة', metricKey: 'total_sessions' }],
    hypotheses: [{ statement_ar: 'فرضية', certainty: 'speculative' }],
    caveats: [],
  };

  it('accepts a conforming narrative', () => {
    expect(() => validateAgainstSchema(VALID, ANALYTICS_NARRATIVE_SCHEMA, 'n')).not.toThrow();
  });

  it('requires a metricKey on every observation', () => {
    const broken = { ...VALID, observations: [{ statement_ar: 'بلا مفتاح' }] };
    expect(() => validateAgainstSchema(broken, ANALYTICS_NARRATIVE_SCHEMA, 'n'))
      .toThrow(/metricKey/);
  });

  it('constrains hypothesis certainty to the declared values', () => {
    const broken = { ...VALID, hypotheses: [{ statement_ar: 'x', certainty: 'certain' }] };
    expect(() => validateAgainstSchema(broken, ANALYTICS_NARRATIVE_SCHEMA, 'n'))
      .toThrow(/not in enum/);
  });

  // Structural proof that the two categories cannot be merged by the model.
  it('keeps observations and hypotheses as separate arrays', () => {
    expect(ANALYTICS_NARRATIVE_SCHEMA.properties.observations.type).toBe('array');
    expect(ANALYTICS_NARRATIVE_SCHEMA.properties.hypotheses.type).toBe('array');
    expect(ANALYTICS_NARRATIVE_SCHEMA.required).toEqual(
      expect.arrayContaining(['observations', 'hypotheses'])
    );
  });
});

describe('import ambiguity schema', () => {
  const VALID = {
    verdict: 'unclear',
    confidence: 'low',
    reasoning_ar: 'الأسماء متطابقة لكن الهواتف مختلفة',
    signals: [{ field: 'name', agreement: 'match' }],
  };

  it('accepts a conforming explanation', () => {
    expect(() => validateAgainstSchema(VALID, IMPORT_AMBIGUITY_SCHEMA, 'i')).not.toThrow();
  });

  it('rejects a signal field outside the comparable set', () => {
    const broken = { ...VALID, signals: [{ field: 'nationalId', agreement: 'match' }] };
    expect(() => validateAgainstSchema(broken, IMPORT_AMBIGUITY_SCHEMA, 'i'))
      .toThrow(/not in enum/);
  });

  it('rejects an invented verdict', () => {
    const broken = { ...VALID, verdict: 'merge_them' };
    expect(() => validateAgainstSchema(broken, IMPORT_AMBIGUITY_SCHEMA, 'i'))
      .toThrow(/not in enum/);
  });
});

describe('parseModelJson', () => {
  it('passes an object straight through', () => {
    expect(parseModelJson({ a: 1 })).toEqual({ a: 1 });
  });

  it('parses plain JSON text', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  // The one deviation tolerated: providers sometimes fence JSON even in
  // structured mode.
  it('unwraps a markdown code fence', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('throws on empty output', () => {
    expect(() => parseModelJson('')).toThrow(SchemaValidationError);
    expect(() => parseModelJson(null)).toThrow(SchemaValidationError);
  });

  // Guessing at malformed model output is how invented data enters a system.
  it('throws rather than repairing malformed JSON', () => {
    expect(() => parseModelJson('{"a": 1,')).toThrow(SchemaValidationError);
    expect(() => parseModelJson('I think the answer is 42')).toThrow(SchemaValidationError);
  });
});

describe('every AI schema is strict', () => {
  it.each([
    ['NotificationDraft', NOTIFICATION_DRAFT_SCHEMA],
    ['AnalyticsNarrative', ANALYTICS_NARRATIVE_SCHEMA],
    ['ImportAmbiguity', IMPORT_AMBIGUITY_SCHEMA],
  ])('%s sets additionalProperties: false on every object node', (_name, schema) => {
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') {
        expect({ path, value: node.additionalProperties }).toEqual({ path, value: false });
        Object.entries(node.properties || {}).forEach(([key, child]) => {
          walk(child, `${path}.${key}`);
        });
      }
      if (node.type === 'array') walk(node.items, `${path}[]`);
    };
    walk(schema, 'root');
  });
});
