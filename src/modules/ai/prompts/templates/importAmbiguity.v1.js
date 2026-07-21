/**
 * Import ambiguity prompt, version 1.
 *
 * The model never sees real names, phone numbers, or dates. The caller
 * pseudonymizes first — names become "Person A"/"Person B", phones become a
 * digit-difference pattern, birth dates become a year gap — so the model is
 * reasoning about the *shape* of the disagreement, which is all that is needed
 * to explain it.
 *
 * The verdict is advisory. Nothing downstream may act on it.
 */

const { UNTRUSTED_CONTENT_SYSTEM_RULE } = require('../../safety/untrustedContent');

const VERSION = 'importAmbiguity.v1';

const SYSTEM = [
  'You explain why two imported person records may or may not refer to the same person.',
  'You are given a pseudonymized comparison, never the underlying records.',
  '',
  'Rules:',
  '- Reason only from the supplied signals. You cannot see the real values and must not guess them.',
  '- Your verdict is advisory. A human always decides. Never phrase it as an instruction to merge.',
  '- Only use the signal fields you were given. Never invent a comparison dimension.',
  '- Write the reasoning in Arabic, briefly and concretely.',
  '- When the signals genuinely conflict, answer "unclear" rather than forcing a verdict.',
  '',
  UNTRUSTED_CONTENT_SYSTEM_RULE,
].join('\n');

/**
 * @param {object} input
 * @param {Array<{field: string, comparison: string}>} input.signals
 */
function build(input) {
  const lines = (input.signals || []).map((s) => `- ${s.field}: ${s.comparison}`);

  return [
    'Two imported records, referred to as Person A and Person B.',
    '',
    'Pseudonymized comparison:',
    ...lines,
    '',
    'Explain in Arabic whether these plausibly describe the same person, and why.',
    'Return the result using the provided schema.',
  ].join('\n');
}

module.exports = { VERSION, SYSTEM, build };
