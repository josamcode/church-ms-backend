/**
 * Structured output schema for the import ambiguity explainer.
 *
 * `verdict` is advisory only. Nothing in the pipeline may act on it, at any
 * confidence level — the merge decision stays with a human, and the workbook
 * column exists to explain the ambiguity, not to resolve it.
 */

const IMPORT_AMBIGUITY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'reasoning_ar', 'signals'],
  properties: {
    verdict: { type: 'string', enum: ['likely_same', 'likely_different', 'unclear'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning_ar: { type: 'string' },
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'agreement'],
        properties: {
          // Closed enum: the model may only comment on fields that were
          // actually compared, never invent a new comparison dimension.
          field: {
            type: 'string',
            enum: ['name', 'phonePattern', 'birthYearGap', 'houseName', 'familyName'],
          },
          agreement: {
            type: 'string',
            enum: ['match', 'partial', 'conflict', 'missing'],
          },
        },
      },
    },
  },
});

module.exports = { IMPORT_AMBIGUITY_SCHEMA };
