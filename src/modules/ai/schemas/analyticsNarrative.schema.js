/**
 * Structured output schema for the analytics narrative feature.
 *
 * The central design decision is the split between `observations` and
 * `hypotheses`. Observations must be derivable from the numbers that were
 * supplied and each carries a `metricKey` that the server re-checks against the
 * payload it actually sent — that check is what makes numeric hallucination
 * detectable rather than plausible. Hypotheses are interpretations and are
 * typed as such, so the UI can render them under a different heading.
 *
 * Merging the two into one paragraph defeats the feature's entire safety
 * argument, which is why they are separate arrays rather than one list with a
 * `kind` field that a renderer could ignore.
 */

const ANALYTICS_NARRATIVE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['narrative_ar', 'observations', 'hypotheses'],
  properties: {
    narrative_ar: { type: 'string' },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['statement_ar', 'metricKey'],
        properties: {
          statement_ar: { type: 'string' },
          // Re-validated server-side against the supplied metric keys.
          metricKey: { type: 'string' },
        },
      },
    },
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['statement_ar', 'certainty'],
        properties: {
          statement_ar: { type: 'string' },
          certainty: { type: 'string', enum: ['speculative', 'plausible'] },
        },
      },
    },
    caveats: { type: 'array', items: { type: 'string' } },
  },
});

module.exports = { ANALYTICS_NARRATIVE_SCHEMA };
