const Joi = require('joi');

const TRACKING_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

const syncSession = {
  body: Joi.object({
    sessionId: Joi.string().pattern(TRACKING_ID_PATTERN).required().messages({
      'string.pattern.base': 'Invalid session id',
      'any.required': 'Session id is required',
    }),
    visitorId: Joi.string().pattern(TRACKING_ID_PATTERN).required().messages({
      'string.pattern.base': 'Invalid visitor id',
      'any.required': 'Visitor id is required',
    }),
    occurredAt: Joi.date().iso().optional(),
    currentPath: Joi.string().trim().max(255).optional(),
    currentTitle: Joi.string().trim().max(160).allow('').optional(),
    referrer: Joi.string().trim().max(500).allow('').optional(),
    language: Joi.string().trim().max(32).allow('').optional(),
    timezone: Joi.string().trim().max(64).allow('').optional(),
    screenWidth: Joi.number().integer().min(0).max(20000).optional(),
    screenHeight: Joi.number().integer().min(0).max(20000).optional(),
    isFinal: Joi.boolean().optional(),
    pageDeltas: Joi.array()
      .items(
        Joi.object({
          path: Joi.string().trim().max(255).required(),
          title: Joi.string().trim().max(160).allow('').optional(),
          views: Joi.number().integer().min(0).max(25).default(0),
          activeSeconds: Joi.number().integer().min(0).max(1800).default(0),
        })
      )
      .max(25)
      .default([]),
  }),
};

const overviewQuery = {
  query: Joi.object({
    days: Joi.number().integer().min(1).max(90).default(30),
    surface: Joi.string().valid('all', 'public', 'auth', 'dashboard', 'other').default('all'),
    limit: Joi.number().integer().min(5).max(50).default(20),
  }),
};

module.exports = {
  syncSession,
  overviewQuery,
};
