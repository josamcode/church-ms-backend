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

const detailItem = Joi.object({
  kind: Joi.string().valid('text', 'link', 'image').required().messages({
    'any.only': 'Detail kind must be text, link, or image',
    'any.required': 'Detail kind is required',
  }),
  title: Joi.string().trim().max(160).allow('', null).optional(),
  content: Joi.string().trim().max(5000).allow('', null).optional(),
  url: Joi.string().uri().max(2000).allow('', null).optional(),
}).custom((value, helpers) => {
  if (value.kind === 'text' && !value.content) {
    return helpers.message('Detail content is required for text items');
  }

  if ((value.kind === 'link' || value.kind === 'image') && !value.url) {
    return helpers.message('Detail url is required for link/image items');
  }

  return value;
});

const createNotification = {
  body: Joi.object({
    typeId: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Invalid notification type id',
      'any.required': 'Notification type is required',
    }),
    name: Joi.string().trim().min(2).max(200).required().messages({
      'string.empty': 'Notification name is required',
      'any.required': 'Notification name is required',
    }),
    summary: Joi.string().trim().max(1000).allow('', null).optional(),
    details: Joi.array().items(detailItem).min(1).max(100).required().messages({
      'array.min': 'At least one notification detail is required',
      'any.required': 'Notification details are required',
    }),
    eventDate: Joi.date().iso().allow(null).optional(),
    coverImageUrl: Joi.string().uri().max(2000).allow('', null).optional(),
    isActive: Joi.boolean().optional(),
  }),
};

const updateNotification = {
  params: idParam.params,
  body: Joi.object({
    typeId: Joi.string().pattern(OBJECT_ID_PATTERN).optional(),
    name: Joi.string().trim().min(2).max(200).optional(),
    summary: Joi.string().trim().max(1000).allow('', null).optional(),
    details: Joi.array().items(detailItem).min(1).max(100).optional(),
    eventDate: Joi.date().iso().allow(null).optional(),
    coverImageUrl: Joi.string().uri().max(2000).allow('', null).optional(),
    isActive: Joi.boolean().optional(),
  })
    .min(1)
    .messages({ 'object.min': 'At least one field must be provided for update' }),
};

const listNotifications = {
  query: Joi.object({
    cursor: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).default(20),
    order: Joi.string().valid('asc', 'desc').default('desc'),
    typeId: Joi.string().pattern(OBJECT_ID_PATTERN).optional(),
    q: Joi.string().trim().max(200).optional(),
    isActive: Joi.boolean().optional(),
  }),
};

const createNotificationType = {
  body: Joi.object({
    name: Joi.string().trim().min(2).max(120).required().messages({
      'string.empty': 'Notification type name is required',
      'any.required': 'Notification type name is required',
    }),
  }),
};

module.exports = {
  idParam,
  createNotification,
  updateNotification,
  listNotifications,
  createNotificationType,
};
