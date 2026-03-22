const Joi = require('joi');
const { AGE_GROUPS_ARRAY } = require('../../constants/ageGroups');
const { EDUCATION_STAGE_VALUES } = require('../../constants/education');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const idParam = {
  params: Joi.object({
    id: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Invalid chat id',
      'any.required': 'Chat id is required',
    }),
  }),
};

const listChats = {
  query: Joi.object({
    type: Joi.string().valid('direct', 'group').optional(),
    q: Joi.string().trim().allow('').optional(),
  }),
};

const getMessages = {
  params: idParam.params,
  query: Joi.object({
    cursor: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).default(40),
  }),
};

const createDirectChat = {
  body: Joi.object({
    targetUserId: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Target user id is invalid',
      'any.required': 'Target user id is required',
    }),
  }),
};

const createGroupChat = {
  body: Joi.object({
    title: Joi.string().trim().min(2).max(120).required(),
    description: Joi.string().trim().allow('', null).max(500).optional(),
    memberIds: Joi.array()
      .items(Joi.string().pattern(OBJECT_ID_PATTERN))
      .min(1)
      .required(),
    adminUserIds: Joi.array()
      .items(Joi.string().pattern(OBJECT_ID_PATTERN))
      .optional()
      .default([]),
    allowMemberMessages: Joi.boolean().optional().default(true),
  }),
};

const updateGroupChat = {
  params: idParam.params,
  body: Joi.object({
    title: Joi.string().trim().min(2).max(120).optional(),
    description: Joi.string().trim().allow('', null).max(500).optional(),
    memberIdsToAdd: Joi.array()
      .items(Joi.string().pattern(OBJECT_ID_PATTERN))
      .optional(),
    memberIdsToRemove: Joi.array()
      .items(Joi.string().pattern(OBJECT_ID_PATTERN))
      .optional(),
    adminUserIds: Joi.array()
      .items(Joi.string().pattern(OBJECT_ID_PATTERN))
      .optional(),
    allowMemberMessages: Joi.boolean().optional(),
  })
    .min(1)
    .messages({
      'object.min': 'At least one group update field is required',
    }),
};

const sendMessage = {
  params: idParam.params,
  body: Joi.object({
    text: Joi.string().trim().min(1).max(2000).required(),
  }),
};

const markRead = {
  params: idParam.params,
  body: Joi.object({
    messageId: Joi.string().pattern(OBJECT_ID_PATTERN).allow(null).optional(),
  }),
};

const searchUsers = {
  query: Joi.object({
    q: Joi.string().trim().allow('').optional(),
    limit: Joi.number().integer().min(1).max(50).default(20),
    forBroadcast: Joi.boolean().optional().default(false),
    ageGroups: Joi.alternatives().try(
      Joi.array().items(Joi.string().valid(...AGE_GROUPS_ARRAY)),
      Joi.string().valid(...AGE_GROUPS_ARRAY)
    ).optional(),
    educationStages: Joi.alternatives().try(
      Joi.array().items(Joi.string().valid(...EDUCATION_STAGE_VALUES)),
      Joi.string().valid(...EDUCATION_STAGE_VALUES)
    ).optional(),
    tags: Joi.alternatives().try(
      Joi.array().items(Joi.string().trim().min(1)),
      Joi.string().trim().min(1)
    ).optional(),
    diseases: Joi.alternatives().try(
      Joi.array().items(Joi.string().trim().min(1)),
      Joi.string().trim().min(1)
    ).optional(),
    genders: Joi.alternatives().try(
      Joi.array().items(Joi.string().valid('male', 'female', 'other')),
      Joi.string().valid('male', 'female', 'other')
    ).optional(),
    familyNames: Joi.alternatives().try(
      Joi.array().items(Joi.string().trim().min(1)),
      Joi.string().trim().min(1)
    ).optional(),
    houseNames: Joi.alternatives().try(
      Joi.array().items(Joi.string().trim().min(1)),
      Joi.string().trim().min(1)
    ).optional(),
    includeLocked: Joi.boolean().optional().default(false),
    includeUsersWithoutLogin: Joi.boolean().optional().default(false),
    includeSelf: Joi.boolean().optional().default(false),
  }),
};

const createBroadcast = {
  body: Joi.object({
    template: Joi.string().trim().min(1).max(2000).required(),
    audience: Joi.object({
      userIds: Joi.array().items(Joi.string().pattern(OBJECT_ID_PATTERN)).optional(),
      tags: Joi.array().items(Joi.string().trim().min(1)).optional(),
      diseases: Joi.array().items(Joi.string().trim().min(1)).optional(),
      ageGroups: Joi.array().items(Joi.string().valid(...AGE_GROUPS_ARRAY)).optional(),
      educationStages: Joi.array().items(Joi.string().valid(...EDUCATION_STAGE_VALUES)).optional(),
      genders: Joi.array().items(Joi.string().valid('male', 'female', 'other')).optional(),
      familyNames: Joi.array().items(Joi.string().trim().min(1)).optional(),
      houseNames: Joi.array().items(Joi.string().trim().min(1)).optional(),
      includeLocked: Joi.boolean().optional().default(false),
      includeUsersWithoutLogin: Joi.boolean().optional().default(false),
      includeSelf: Joi.boolean().optional().default(false),
    }).required(),
  }),
};

module.exports = {
  idParam,
  listChats,
  getMessages,
  createDirectChat,
  createGroupChat,
  updateGroupChat,
  sendMessage,
  markRead,
  searchUsers,
  createBroadcast,
};
