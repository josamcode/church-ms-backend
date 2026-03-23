const Joi = require('joi');
const { PERMISSIONS_ARRAY } = require('../../constants/permissions');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const listNotifications = {
  query: Joi.object({
    cursor: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(50).default(20),
  }),
};

const markRead = {
  params: Joi.object({
    id: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Notification id is invalid',
      'any.required': 'Notification id is required',
    }),
  }),
};

const markThreadRead = {
  params: Joi.object({
    threadId: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Thread id is invalid',
      'any.required': 'Thread id is required',
    }),
  }),
};

const sendSystemNotification = {
  body: Joi.object({
    type: Joi.string()
      .trim()
      .pattern(/^[a-z0-9_:-]{2,80}$/)
      .default('admin'),
    title: Joi.string().trim().min(1).max(160).required(),
    message: Joi.string().trim().min(1).max(2000).required(),
    link: Joi.string().trim().max(2000).allow('', null).optional(),
    metadata: Joi.object().unknown(true).allow(null).optional(),
    userIds: Joi.array()
      .items(Joi.string().pattern(OBJECT_ID_PATTERN))
      .optional()
      .default([]),
    targetPermissions: Joi.array()
      .items(Joi.string().valid(...PERMISSIONS_ARRAY))
      .optional()
      .default([]),
    broadcastToAll: Joi.boolean().optional().default(false),
  }).custom((value, helpers) => {
    if (
      value.broadcastToAll !== true &&
      (!Array.isArray(value.userIds) || value.userIds.length === 0) &&
      (!Array.isArray(value.targetPermissions) || value.targetPermissions.length === 0)
    ) {
      return helpers.error('any.custom', {
        message:
          'Choose at least one target user, one target permission, or enable broadcastToAll.',
      });
    }

    return value;
  }, 'notification audience validation').messages({
    'any.custom': '{{#message}}',
  }),
};

module.exports = {
  listNotifications,
  markRead,
  markThreadRead,
  sendSystemNotification,
};
