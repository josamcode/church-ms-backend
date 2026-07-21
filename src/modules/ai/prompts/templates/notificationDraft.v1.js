/**
 * Notification drafting prompt, version 1.
 *
 * Prompts are versioned files rather than inline strings so a change is
 * reviewable, and so `promptVersion` on each usage record identifies exactly
 * which text produced a given output.
 *
 * Every input here is typed by the admin in the form. Nothing is read from the
 * member database, which is what makes an entire class of privacy risk
 * inapplicable to this feature by construction rather than by filtering.
 */

const {
  wrapUntrustedList,
  wrapUntrusted,
  UNTRUSTED_CONTENT_SYSTEM_RULE,
} = require('../../safety/untrustedContent');

const VERSION = 'notificationDraft.v1';

const SYSTEM = [
  'You draft church notification announcements for St. Michael Church.',
  'You write in Modern Standard Arabic and in English.',
  '',
  'Rules:',
  '- Use only the facts supplied. Never invent dates, times, places, names, prices, or contact details.',
  '- If a needed fact is missing, write the announcement without it and list what is missing in "warnings".',
  '- Arabic must be natural and church-appropriate, not a literal translation of the English.',
  '- Keep the Arabic title under 160 characters and the summary under 500 characters.',
  '- Do not include URLs, phone numbers, or email addresses unless they appear in the supplied points.',
  '- Do not address individuals by name.',
  '',
  UNTRUSTED_CONTENT_SYSTEM_RULE,
].join('\n');

/**
 * @param {object} input
 * @param {string} input.notificationTypeName
 * @param {string} input.audienceLabel
 * @param {string[]} input.bulletPoints
 * @param {string} [input.tone]
 * @param {string} [input.eventDate]
 */
function build(input) {
  const parts = [
    `Notification type: ${wrapUntrusted(input.notificationTypeName, { label: 'notification type name', maxLength: 120 })}`,
    `Audience: ${wrapUntrusted(input.audienceLabel, { label: 'audience label', maxLength: 120 })}`,
  ];

  if (input.eventDate) {
    parts.push(`Event date: ${String(input.eventDate).slice(0, 40)}`);
  }
  if (input.tone) {
    parts.push(`Requested tone: ${input.tone}`);
  }

  parts.push(
    '',
    'Points to communicate:',
    wrapUntrustedList(input.bulletPoints, { label: 'points written by the announcement author' }),
    '',
    'Produce one announcement in Arabic and the same announcement in English.',
    'Return the result using the provided schema.'
  );

  return parts.join('\n');
}

module.exports = { VERSION, SYSTEM, build };
