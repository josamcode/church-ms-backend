/**
 * MVP-3 — import ambiguity explainer.
 *
 * Runs from a maintenance script, not from the API, so it adds no new network
 * surface. Its defining property is that the model never receives the records:
 * `pseudonymizeComparison` converts a pair of candidate records into a set of
 * abstract agreement signals before anything is sent.
 *
 * The verdict is advisory at every confidence level. No caller may act on it.
 */

const { orchestrate } = require('../ai.orchestrator');
const { IMPORT_AMBIGUITY_SCHEMA } = require('../schemas/importAmbiguity.schema');
const { AI_FEATURES, AI_WORKLOADS, AI_SENSITIVITY, AI_OUTPUT_LIMITS } = require('../ai.constants');

/** The only comparison dimensions the model is ever told about. */
const COMPARABLE_FIELDS = Object.freeze([
  'name', 'phonePattern', 'birthYearGap', 'houseName', 'familyName',
]);

function agreementOf(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left && !right) return 'missing';
  if (!left || !right) return 'missing';
  if (left === right) return 'match';
  if (left.includes(right) || right.includes(left)) return 'partial';
  return 'conflict';
}

/**
 * Describe how two phone numbers differ without transmitting either.
 *
 * The useful signal for a human reviewer is "these differ in the last two
 * digits" versus "these are unrelated numbers" — which is expressible without
 * the digits themselves.
 */
function phonePattern(a, b) {
  const left = String(a || '').replace(/\D/g, '');
  const right = String(b || '').replace(/\D/g, '');
  if (!left || !right) return { field: 'phonePattern', comparison: 'one or both missing' };
  if (left === right) return { field: 'phonePattern', comparison: 'identical' };
  if (left.length !== right.length) {
    return { field: 'phonePattern', comparison: 'different lengths' };
  }

  let differing = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) differing += 1;
  }
  return {
    field: 'phonePattern',
    comparison: `same length, ${differing} of ${left.length} digits differ`,
  };
}

function birthYearGap(a, b) {
  const yearOf = (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getFullYear();
  };
  const left = yearOf(a);
  const right = yearOf(b);

  if (left === null || right === null) {
    return { field: 'birthYearGap', comparison: 'one or both missing' };
  }
  const gap = Math.abs(left - right);
  return {
    field: 'birthYearGap',
    comparison: gap === 0 ? 'same year' : `${gap} year gap`,
  };
}

/**
 * Convert two candidate records into abstract signals.
 *
 * Nothing returned by this function contains a name, a phone number, a date, or
 * any other value from either record — only the relationship between them.
 * This is what allows the feature to exist at all.
 *
 * @returns {{signals: Array<{field: string, comparison: string}>}}
 */
function pseudonymizeComparison(recordA = {}, recordB = {}) {
  const signals = [
    { field: 'name', comparison: agreementOf(recordA.fullName, recordB.fullName) },
    phonePattern(recordA.phonePrimary, recordB.phonePrimary),
    birthYearGap(recordA.birthDate, recordB.birthDate),
    { field: 'houseName', comparison: agreementOf(recordA.houseName, recordB.houseName) },
    { field: 'familyName', comparison: agreementOf(recordA.familyName, recordB.familyName) },
  ];

  return { signals: signals.filter((signal) => COMPARABLE_FIELDS.includes(signal.field)) };
}

function postValidate(explanation) {
  const invented = (explanation.signals || [])
    .map((signal) => signal.field)
    .filter((field) => !COMPARABLE_FIELDS.includes(field));

  if (invented.length > 0) {
    throw new Error(`Explanation referenced unknown fields: ${invented.join(', ')}`);
  }

  if (String(explanation.reasoning_ar || '').length > AI_OUTPUT_LIMITS.reasoningLength) {
    throw new Error('Explanation reasoning exceeds the maximum length');
  }
  if (/<[^>]+>/.test(JSON.stringify(explanation))) {
    throw new Error('Explanation contains HTML markup');
  }
  // The field is named `_ar`; a response that answered in another language is
  // a wrong answer, not a formatting quirk. Consistent with the other features.
  if (!/[؀-ۿ]/.test(String(explanation.reasoning_ar || ''))) {
    throw new Error('Explanation reasoning is not in Arabic');
  }

  return explanation;
}

/**
 * Explain one ambiguous pair.
 * @param {object} comparison  output of `pseudonymizeComparison`
 */
async function explainAmbiguity(comparison, context) {
  return orchestrate({
    feature: AI_FEATURES.IMPORT_AMBIGUITY,
    workload: AI_WORKLOADS.BATCH_ANALYSIS,
    sensitivity: AI_SENSITIVITY.INTERNAL,
    capability: 'generateStructured',
    schema: IMPORT_AMBIGUITY_SCHEMA,
    schemaName: 'ImportAmbiguity',
    promptKey: 'importAmbiguity',
    input: comparison,
    context,
    postValidate,
    maxTokens: 1024,
  });
}

/**
 * Explain many pairs with bounded concurrency.
 *
 * A failure on one pair must not abort the batch: the workbook is still useful
 * with some explanation columns empty, and an import run that dies halfway
 * because of a provider hiccup is worse than a partial one.
 */
async function explainAmbiguityBatch(comparisons, context, { concurrency = 3 } = {}) {
  const items = Array.isArray(comparisons) ? comparisons : [];
  const results = new Array(items.length);

  // A single shared cursor. Deriving the index from a queue's length instead
  // would race: two workers can observe the same length before either shifts,
  // and both would then write to the same slot.
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      try {
        const result = await explainAmbiguity(items[index], context);
        results[index] = { ok: true, data: result.data, meta: result.meta };
      } catch (error) {
        // One failed pair leaves one empty column, not an aborted import run.
        results[index] = { ok: false, error: error.message };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(Math.min(concurrency, items.length), 0) }, () => worker())
  );

  return results;
}

module.exports = {
  explainAmbiguity,
  explainAmbiguityBatch,
  pseudonymizeComparison,
  postValidate,
  COMPARABLE_FIELDS,
};
