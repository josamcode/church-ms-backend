const Joi = require('joi');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * Input validation for AI endpoints.
 *
 * Tight bounds are a cost control as much as a correctness one: every accepted
 * character becomes prompt tokens the project pays for, so the limits here are
 * sized to real announcements rather than left generous.
 */

const draftNotificationBody = {
  body: Joi.object({
    notificationTypeId: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Invalid notification type id',
      'any.required': 'Notification type is required',
    }),
    audienceType: Joi.string().valid('all', 'permissions').default('all'),
    bulletPoints: Joi.array()
      .items(Joi.string().trim().min(1).max(500))
      .min(1)
      .max(12)
      .required()
      .messages({
        'array.min': 'At least one point is required',
        'array.max': 'At most 12 points are allowed',
        'any.required': 'Points are required',
      }),
    tone: Joi.string().valid('formal', 'warm', 'urgent', 'celebratory').optional(),
    eventDate: Joi.date().iso().optional().allow(null, ''),
    language: Joi.string().valid('ar', 'en').default('ar'),
  }),
};

const narrateAnalyticsBody = {
  body: Joi.object({
    // The client selects a window and a scope; the server assembles the
    // numbers. There is deliberately no way to pass metrics in — that would
    // let a caller put arbitrary text into the prompt and would break the
    // metricKey validation that makes this feature trustworthy.
    period: Joi.string().valid('week', 'month', 'quarter').default('month'),
    scope: Joi.string().valid('site', 'meetings').default('site'),
  }),
};

const feedbackBody = {
  body: Joi.object({
    requestId: Joi.string().trim().max(128).required(),
    feedback: Joi.string().valid('positive', 'negative').required(),
    editDistance: Joi.number().min(0).max(1).optional(),
  }),
};

module.exports = { draftNotificationBody, narrateAnalyticsBody, feedbackBody };
