const Joi = require('joi');
const { ACTIVITY_TYPES } = require('./meeting.model');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const objectIdField = Joi.string().pattern(OBJECT_ID_PATTERN);

const avatarSchema = Joi.object({
  url: Joi.string().uri().required(),
  publicId: Joi.string().trim().allow('', null).optional(),
}).optional();

const personLinkSchema = Joi.object({
  userId: objectIdField.optional(),
  name: Joi.string().trim().min(2).max(160).optional(),
})
  .or('userId', 'name')
  .required();

const sectorOfficialSchema = Joi.object({
  userId: objectIdField.optional(),
  name: Joi.string().trim().min(2).max(160).optional(),
  title: Joi.string().trim().max(160).allow('', null).optional(),
  notes: Joi.string().trim().max(500).allow('', null).optional(),
}).or('userId', 'name');

const servantGroupAssignmentSchema = Joi.object({
  group: Joi.string().trim().max(120).required(),
  servedUserIds: Joi.array().items(objectIdField).default([]),
});

const meetingGroupAssignmentSchema = Joi.object({
  group: Joi.string().trim().max(120).required(),
  servedUserIds: Joi.array().items(objectIdField).default([]),
});

const servantSchema = Joi.object({
  userId: objectIdField.optional(),
  name: Joi.string().trim().min(2).max(160).optional(),
  responsibility: Joi.string().trim().max(160).allow('', null).optional(),
  groupsManaged: Joi.array().items(Joi.string().trim().max(120)).default([]),
  groupAssignments: Joi.array().items(servantGroupAssignmentSchema).default([]),
  servedUserIds: Joi.array().items(objectIdField).default([]),
  notes: Joi.string().trim().max(1000).allow('', null).optional(),
}).or('userId', 'name');

const committeeSchema = Joi.object({
  name: Joi.string().trim().min(2).max(160).required(),
  memberUserIds: Joi.array().items(objectIdField).default([]),
  memberNames: Joi.array().items(Joi.string().trim().max(160)).default([]),
  details: Joi.object().unknown(true).default({}),
  notes: Joi.string().trim().max(1000).allow('', null).optional(),
});

const meetingActivitySchema = Joi.object({
  name: Joi.string().trim().min(2).max(160).required(),
  type: Joi.string()
    .valid(...ACTIVITY_TYPES)
    .default('other'),
  scheduledAt: Joi.date().iso().optional(),
  notes: Joi.string().trim().max(1000).allow('', null).optional(),
});

const idParam = {
  params: Joi.object({
    id: objectIdField.required().messages({
      'string.pattern.base': 'Invalid id',
      'any.required': 'Id is required',
    }),
  }),
};

const memberParams = {
  params: Joi.object({
    id: objectIdField.required().messages({
      'string.pattern.base': 'Invalid id',
      'any.required': 'Id is required',
    }),
    memberId: objectIdField.required().messages({
      'string.pattern.base': 'Invalid member id',
      'any.required': 'Member id is required',
    }),
  }),
};

const createSector = {
  body: Joi.object({
    name: Joi.string().trim().min(2).max(160).required().messages({
      'string.empty': 'Sector name is required',
      'any.required': 'Sector name is required',
    }),
    avatar: avatarSchema,
    officials: Joi.array().items(sectorOfficialSchema).default([]),
    notes: Joi.string().trim().max(2000).allow('', null).optional(),
  }),
};

const updateSector = {
  params: idParam.params,
  body: Joi.object({
    name: Joi.string().trim().min(2).max(160).optional(),
    avatar: avatarSchema.allow(null),
    officials: Joi.array().items(sectorOfficialSchema).optional(),
    notes: Joi.string().trim().max(2000).allow('', null).optional(),
  })
    .min(1)
    .messages({ 'object.min': 'Provide at least one field to update' }),
};

const listSectors = {
  query: Joi.object({
    cursor: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(200).default(20),
    order: Joi.string().valid('asc', 'desc').default('asc'),
    search: Joi.string().trim().allow('', null).optional(),
  }),
};

const createMeeting = {
  body: Joi.object({
    sectorId: objectIdField.required().messages({
      'string.pattern.base': 'Sector id is invalid',
      'any.required': 'Sector id is required',
    }),
    name: Joi.string().trim().min(2).max(160).required().messages({
      'string.empty': 'Meeting name is required',
      'any.required': 'Meeting name is required',
    }),
    day: Joi.string().trim().min(2).max(32).required().messages({
      'string.empty': 'Meeting day is required',
      'any.required': 'Meeting day is required',
    }),
    time: Joi.string().trim().pattern(TIME_PATTERN).required().messages({
      'string.pattern.base': 'Meeting time must be HH:mm',
      'any.required': 'Meeting time is required',
    }),
    avatar: avatarSchema,
    serviceSecretary: personLinkSchema.optional(),
    assistantSecretaries: Joi.array().items(personLinkSchema).default([]),
    servants: Joi.array().items(servantSchema).default([]),
    servedUserIds: Joi.array().items(objectIdField).default([]),
    groups: Joi.array().items(Joi.string().trim().max(120)).default([]),
    groupAssignments: Joi.array().items(meetingGroupAssignmentSchema).default([]),
    committees: Joi.array().items(committeeSchema).default([]),
    activities: Joi.array().items(meetingActivitySchema).default([]),
    notes: Joi.string().trim().max(3000).allow('', null).optional(),
  }),
};

const listMeetings = {
  query: Joi.object({
    cursor: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).default(20),
    order: Joi.string().valid('asc', 'desc').default('desc'),
    sectorId: objectIdField.optional(),
    day: Joi.string().trim().max(32).optional(),
    search: Joi.string().trim().allow('', null).optional(),
  }),
};

const updateMeetingBasic = {
  params: idParam.params,
  body: Joi.object({
    sectorId: objectIdField.optional(),
    name: Joi.string().trim().min(2).max(160).optional(),
    day: Joi.string().trim().min(2).max(32).optional(),
    time: Joi.string().trim().pattern(TIME_PATTERN).optional().messages({
      'string.pattern.base': 'Meeting time must be HH:mm',
    }),
    avatar: avatarSchema.allow(null),
    serviceSecretary: personLinkSchema.allow(null).optional(),
    assistantSecretaries: Joi.array().items(personLinkSchema).optional(),
    servedUserIds: Joi.array().items(objectIdField).optional(),
    groups: Joi.array().items(Joi.string().trim().max(120)).optional(),
    groupAssignments: Joi.array().items(meetingGroupAssignmentSchema).optional(),
    notes: Joi.string().trim().max(3000).allow('', null).optional(),
  })
    .min(1)
    .messages({ 'object.min': 'Provide at least one field to update' }),
};

const updateMeetingServants = {
  params: idParam.params,
  body: Joi.object({
    servants: Joi.array().items(servantSchema).required(),
  }),
};

const updateMeetingCommittees = {
  params: idParam.params,
  body: Joi.object({
    committees: Joi.array().items(committeeSchema).required(),
  }),
};

const updateMeetingActivities = {
  params: idParam.params,
  body: Joi.object({
    activities: Joi.array().items(meetingActivitySchema).required(),
  }),
};

const responsibilitySuggestions = {
  query: Joi.object({
    search: Joi.string().trim().allow('', null).optional(),
    limit: Joi.number().integer().min(1).max(100).default(30),
  }),
};

const servantHistory = {
  query: Joi.object({
    userId: objectIdField.optional(),
    name: Joi.string().trim().min(2).max(160).optional(),
    limit: Joi.number().integer().min(1).max(20).default(10),
  })
    .or('userId', 'name')
    .messages({ 'object.missing': 'Provide userId or name' }),
};

const updateMeetingMemberNotes = {
  params: memberParams.params,
  body: Joi.object({
    notes: Joi.string().trim().max(1000).allow('', null).required(),
  }),
};

module.exports = {
  idParam,
  memberParams,
  createSector,
  updateSector,
  listSectors,
  createMeeting,
  listMeetings,
  updateMeetingBasic,
  updateMeetingServants,
  updateMeetingCommittees,
  updateMeetingActivities,
  responsibilitySuggestions,
  servantHistory,
  updateMeetingMemberNotes,
};
