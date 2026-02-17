const Joi = require('joi');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const createVisitation = {
  body: Joi.object({
    houseName: Joi.string().trim().min(2).max(160).required().messages({
      'string.empty': 'House name is required',
      'any.required': 'House name is required',
    }),
    durationMinutes: Joi.number().integer().min(1).max(720).default(10),
    visitedAt: Joi.date().iso().required().messages({
      'date.base': 'Invalid visitation date',
      'any.required': 'Visitation date is required',
    }),
    notes: Joi.string().trim().max(2000).allow('', null).optional(),
  }),
};

const listVisitations = {
  query: Joi.object({
    cursor: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).default(20),
    order: Joi.string().valid('asc', 'desc').default('desc'),
    houseName: Joi.string().trim().optional(),
    recordedByUserId: Joi.string().pattern(OBJECT_ID_PATTERN).optional(),
    dateFrom: Joi.date().iso().optional(),
    dateTo: Joi.date().iso().optional(),
  }),
};

const idParam = {
  params: Joi.object({
    id: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Invalid id',
      'any.required': 'Id is required',
    }),
  }),
};

const analyticsQuery = {
  query: Joi.object({
    months: Joi.number().integer().min(1).max(24).default(6),
  }),
};

module.exports = {
  createVisitation,
  listVisitations,
  idParam,
  analyticsQuery,
};
