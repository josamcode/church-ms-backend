/**
 * Analytics narrative prompt, version 1.
 *
 * The prompt's whole job is to enforce the observation/hypothesis split that
 * the schema encodes. Every observation must cite a `metricKey` from the
 * supplied set; the server rejects the response outright if any key was
 * invented, which is what turns "please don't hallucinate numbers" from a
 * request into a check.
 *
 * The payload contains aggregate counts only. No member, no identifier, and no
 * free text from the database is included.
 */

const { UNTRUSTED_CONTENT_SYSTEM_RULE } = require('../../safety/untrustedContent');

const VERSION = 'analyticsNarrative.v1';

const SYSTEM = [
  'You explain aggregate church activity statistics to administrators, in Arabic.',
  '',
  'Rules:',
  '- Every entry in "observations" must restate something directly visible in the supplied numbers,',
  '  and must cite the exact metricKey it came from.',
  '- Never state a number that was not supplied. Never compute a figure you were not given.',
  '- Anything explanatory, causal, or predictive belongs in "hypotheses", never in "observations".',
  '- Mark each hypothesis "speculative" or "plausible" honestly. Prefer "speculative".',
  '- You have no information about why any number changed. Do not imply that you do.',
  '- If the data is too thin to say anything useful, say so in "caveats" and return few observations.',
  '',
  UNTRUSTED_CONTENT_SYSTEM_RULE,
].join('\n');

/**
 * @param {object} input
 * @param {string} input.period
 * @param {string} input.scope
 * @param {Array<{key: string, label: string, value: number, previousValue?: number}>} input.metrics
 */
function build(input) {
  const metricLines = (input.metrics || []).map((metric) => {
    const delta = Number.isFinite(metric.previousValue)
      ? ` (previous period: ${metric.previousValue})`
      : '';
    return `- ${metric.key}: ${metric.label} = ${metric.value}${delta}`;
  });

  return [
    `Period: ${input.period}`,
    `Scope: ${input.scope}`,
    '',
    'Metrics:',
    ...metricLines,
    '',
    `The only valid metricKey values are: ${(input.metrics || []).map((m) => m.key).join(', ')}.`,
    'Using any other metricKey invalidates the whole response.',
    '',
    'Write a short Arabic narrative, then the observations and hypotheses separately.',
    'Return the result using the provided schema.',
  ].join('\n');
}

module.exports = { VERSION, SYSTEM, build };
