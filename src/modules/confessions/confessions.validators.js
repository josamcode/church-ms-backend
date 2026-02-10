const Joi = require('joi');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const idParam = {
  params: Joi.object({
    id: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Invalid id',
      'any.required': 'Id is required',
    }),
  }),
};

const createSession = {
  body: Joi.object({
    attendeeUserId: Joi.string().pattern(OBJECT_ID_PATTERN).optional(),
    sessionTypeId: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Invalid session type id',
      'any.required': 'Session type is required',
    }),
    scheduledAt: Joi.date().iso().required().messages({
      'date.base': 'Invalid scheduled date',
      'any.required': 'Scheduled date is required',
    }),
    nextSessionAt: Joi.date().iso().greater(Joi.ref('scheduledAt')).optional().messages({
      'date.greater': 'Next session date must be after scheduled date',
    }),
    notes: Joi.string().trim().max(2000).allow('', null).optional(),
  }),
};

const listSessions = {
  query: Joi.object({
    cursor: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).default(20),
    order: Joi.string().valid('asc', 'desc').default('desc'),
    attendeeUserId: Joi.string().pattern(OBJECT_ID_PATTERN).optional(),
    sessionTypeId: Joi.string().pattern(OBJECT_ID_PATTERN).optional(),
    dateFrom: Joi.date().iso().optional(),
    dateTo: Joi.date().iso().optional(),
  }),
};

const createSessionType = {
  body: Joi.object({
    name: Joi.string().trim().min(2).max(120).required().messages({
      'string.empty': 'Session type name is required',
      'any.required': 'Session type name is required',
    }),
  }),
};

const updateAlertConfig = {
  body: Joi.object({
    alertThresholdDays: Joi.number().integer().min(1).max(3650).required().messages({
      'number.base': 'Threshold must be a number',
      'any.required': 'Threshold is required',
    }),
  }),
};

const alertsQuery = {
  query: Joi.object({
    fullName: Joi.string().trim().optional(),
    thresholdDays: Joi.number().integer().min(1).max(3650).optional(),
  }),
};

const analyticsQuery = {
  query: Joi.object({
    months: Joi.number().integer().min(1).max(24).default(6),
  }),
};

const searchUsers = {
  query: Joi.object({
    fullName: Joi.string().trim().min(1).optional(),
    phonePrimary: Joi.string().trim().min(1).optional(),
    limit: Joi.number().integer().min(1).max(50).default(15),
  })
    .or('fullName', 'phonePrimary')
    .messages({
      'object.missing': 'Provide fullName or phonePrimary for search',
    }),
};

module.exports = {
  idParam,
  createSession,
  listSessions,
  createSessionType,
  updateAlertConfig,
  alertsQuery,
  analyticsQuery,
  searchUsers,
};
