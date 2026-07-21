/**
 * MVP-1 — notification drafting.
 *
 * Note what this file does NOT contain: any provider name, any model name, any
 * API call. It states a workload, a sensitivity, and a capability; the router
 * resolves those to a concrete model. Changing model or provider never touches
 * this file, which is the practical test of whether the abstraction is real.
 *
 * The inputs are all typed by the admin in the form. Nothing is read from the
 * member database, so an entire category of privacy risk does not apply here by
 * construction rather than by filtering.
 */

const { orchestrate } = require('../ai.orchestrator');
const { NOTIFICATION_DRAFT_SCHEMA } = require('../schemas/notificationDraft.schema');
const { AI_FEATURES, AI_WORKLOADS, AI_SENSITIVITY, AI_OUTPUT_LIMITS } = require('../ai.constants');
const { sanitizeNotificationLink } = require('../../../utils/sanitizeNotificationLink');

const HTML_TAG_PATTERN = /<[^>]+>/;
const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z0-9+\-.]*:\/\/\S+/gi;
// Leading `/{1,2}` on purpose. Matching only `/x` would let a protocol-relative
// URL (`//evil.com/x`) through both this check and the absolute-URL check,
// since it carries no scheme — and that is precisely the off-site redirect
// `sanitizeNotificationLink` exists to reject.
const PATH_LIKE_PATTERN = /(?:^|\s)(\/{1,2}[^\s"']+)/g;

/**
 * Server-side checks applied after schema validation.
 *
 * Schema conformance proves shape, not safety and not correctness. These are
 * the checks that matter operationally:
 *   - lengths must fit the Mongoose limits, or saving the draft would fail;
 *   - no HTML, because the draft is rendered as text;
 *   - any URL the model produced goes through the same link sanitizer that
 *     protects hand-written notifications — model output gets no exemption.
 */
function postValidate(draft) {
  const assertText = (value, max, label) => {
    const text = String(value || '');
    if (text.length > max) {
      throw new Error(`Generated ${label} exceeds ${max} characters`);
    }
    if (HTML_TAG_PATTERN.test(text)) {
      throw new Error(`Generated ${label} contains HTML markup`);
    }
    return text;
  };

  for (const language of ['ar', 'en']) {
    const block = draft[language];
    assertText(block.title, AI_OUTPUT_LIMITS.notificationTitle, `${language} title`);
    assertText(block.summary, AI_OUTPUT_LIMITS.notificationSummary, `${language} summary`);
    (block.details || []).forEach((detail, index) => {
      assertText(detail, AI_OUTPUT_LIMITS.notificationSummary, `${language} detail ${index + 1}`);
    });
  }

  // Arabic output must actually be Arabic. A model that silently answered in
  // English produces a draft an admin would paste without noticing.
  if (!/[؀-ۿ]/.test(String(draft.ar.title) + String(draft.ar.summary))) {
    throw new Error('Arabic draft does not contain Arabic text');
  }

  // Links get no exemption for being model-generated: they go through the same
  // `sanitizeNotificationLink` that protects hand-written notifications, which
  // accepts same-origin relative paths only.
  //
  // Consequence, stated plainly: a draft may not contain an absolute URL. The
  // notification's link is a separate field the admin sets in the form and
  // which is sanitized there. Rejecting is right rather than stripping — a
  // silently removed link produces an announcement that reads as if it had one.
  const allText = JSON.stringify(draft);

  if (ABSOLUTE_URL_PATTERN.test(allText)) {
    ABSOLUTE_URL_PATTERN.lastIndex = 0;
    throw new Error(
      'Generated draft contains a link. Add links using the notification link field instead.'
    );
  }
  ABSOLUTE_URL_PATTERN.lastIndex = 0;

  let match;
  while ((match = PATH_LIKE_PATTERN.exec(allText)) !== null) {
    const candidate = match[1].replace(/["'\\,}\]]+$/, '');
    if (!sanitizeNotificationLink(candidate)) {
      PATH_LIKE_PATTERN.lastIndex = 0;
      throw new Error('Generated draft contains an unsafe link');
    }
  }
  PATH_LIKE_PATTERN.lastIndex = 0;

  return draft;
}

/**
 * @param {object} input
 * @param {string} input.notificationTypeName
 * @param {string} input.audienceLabel
 * @param {string[]} input.bulletPoints
 * @param {string} [input.tone]
 * @param {string} [input.eventDate]
 * @param {import('../providers/provider.interface').AiRequestContext} context
 */
async function draftNotification(input, context) {
  return orchestrate({
    feature: AI_FEATURES.NOTIFICATION_DRAFT,
    workload: AI_WORKLOADS.ARABIC_DRAFTING,
    sensitivity: AI_SENSITIVITY.INTERNAL,
    capability: 'generateStructured',
    schema: NOTIFICATION_DRAFT_SCHEMA,
    schemaName: 'NotificationDraft',
    promptKey: 'notificationDraft',
    input,
    context,
    postValidate,
    maxTokens: 2048,
  });
}

module.exports = { draftNotification, postValidate };
