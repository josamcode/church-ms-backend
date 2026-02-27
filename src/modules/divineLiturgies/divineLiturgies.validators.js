const Joi = require('joi');
const { SERVICE_TYPES, DAYS_OF_WEEK } = require('./divineLiturgyRecurring.model');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const objectIdField = Joi.string().pattern(OBJECT_ID_PATTERN);

const idParam = {
  params: Joi.object({
    id: objectIdField.required().messages({
      'string.pattern.base': 'Invalid id',
      'any.required': 'Id is required',
    }),
  }),
};

const createRecurring = {
  body: Joi.object({
    serviceType: Joi.string()
      .valid(...Object.values(SERVICE_TYPES))
      .required(),
    dayOfWeek: Joi.string()
      .valid(...DAYS_OF_WEEK)
      .required(),
    startTime: Joi.string().trim().pattern(TIME_PATTERN).required().messages({
      'string.pattern.base': 'Start time must be HH:mm',
    }),
    endTime: Joi.string().trim().pattern(TIME_PATTERN).allow('', null).optional().messages({
      'string.pattern.base': 'End time must be HH:mm',
    }),
    name: Joi.string().trim().max(160).allow('', null).optional(),
    priestUserIds: Joi.array().items(objectIdField).default([]),
  }),
};

const updateRecurring = {
  params: idParam.params,
  body: Joi.object({
    serviceType: Joi.string()
      .valid(...Object.values(SERVICE_TYPES))
      .optional(),
    dayOfWeek: Joi.string()
      .valid(...DAYS_OF_WEEK)
      .optional(),
    startTime: Joi.string().trim().pattern(TIME_PATTERN).optional().messages({
      'string.pattern.base': 'Start time must be HH:mm',
    }),
    endTime: Joi.string().trim().pattern(TIME_PATTERN).allow('', null).optional().messages({
      'string.pattern.base': 'End time must be HH:mm',
    }),
    name: Joi.string().trim().max(160).allow('', null).optional(),
    priestUserIds: Joi.array().items(objectIdField).optional(),
  })
    .min(1)
    .messages({ 'object.min': 'Provide at least one field to update' }),
};

const createException = {
  body: Joi.object({
    date: Joi.date().iso().required(),
    startTime: Joi.string().trim().pattern(TIME_PATTERN).required().messages({
      'string.pattern.base': 'Start time must be HH:mm',
    }),
    endTime: Joi.string().trim().pattern(TIME_PATTERN).allow('', null).optional().messages({
      'string.pattern.base': 'End time must be HH:mm',
    }),
    name: Joi.string().trim().max(160).allow('', null).optional(),
    priestUserIds: Joi.array().items(objectIdField).default([]),
  }),
};

const updateException = {
  params: idParam.params,
  body: Joi.object({
    date: Joi.date().iso().optional(),
    startTime: Joi.string().trim().pattern(TIME_PATTERN).optional().messages({
      'string.pattern.base': 'Start time must be HH:mm',
    }),
    endTime: Joi.string().trim().pattern(TIME_PATTERN).allow('', null).optional().messages({
      'string.pattern.base': 'End time must be HH:mm',
    }),
    name: Joi.string().trim().max(160).allow('', null).optional(),
    priestUserIds: Joi.array().items(objectIdField).optional(),
  })
    .min(1)
    .messages({ 'object.min': 'Provide at least one field to update' }),
};

const setChurchPriests = {
  body: Joi.object({
    priestUserIds: Joi.array().items(objectIdField).required(),
  }),
};

module.exports = {
  idParam,
  createRecurring,
  updateRecurring,
  createException,
  updateException,
  setChurchPriests,
};
