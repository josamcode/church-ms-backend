/**
 * Structured output schema for the notification drafting feature.
 *
 * `additionalProperties: false` is mandatory for both Anthropic and OpenAI
 * strict structured-output modes.
 *
 * Length limits are deliberately NOT expressed here. Anthropic's structured
 * output does not support `minLength`/`maxLength`/`minimum`/`maximum`, so a
 * limit written into the schema would be silently unenforced — worse than no
 * limit, because it reads as a guarantee. Lengths are enforced server-side
 * after receipt, which is the correct place regardless.
 */

const NOTIFICATION_DRAFT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['ar', 'en', 'tone', 'confidence'],
  properties: {
    ar: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'summary'],
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        details: { type: 'array', items: { type: 'string' } },
      },
    },
    en: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'summary'],
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        details: { type: 'array', items: { type: 'string' } },
      },
    },
    tone: { type: 'string', enum: ['formal', 'warm', 'urgent', 'celebratory'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    warnings: { type: 'array', items: { type: 'string' } },
  },
});

module.exports = { NOTIFICATION_DRAFT_SCHEMA };
