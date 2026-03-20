const Joi = require('joi');
const { ARCHIVE_STATUSES, ARCHIVE_STATUSES_ARRAY } = require('./archive.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const idParam = {
  params: Joi.object({
    id: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'Invalid archive item id',
    }),
  }),
};

const optionalObjectId = Joi.alternatives()
  .try(
    Joi.string().pattern(OBJECT_ID_PATTERN).messages({
      'string.pattern.base': 'Invalid archive collection id',
    }),
    Joi.valid(null, '')
  )
  .optional();

const photoSchema = Joi.object({
  url: Joi.string().uri().max(2000).required(),
  publicId: Joi.string().trim().max(400).allow('', null).default(null),
  caption: Joi.string().trim().max(240).allow('').default(''),
});

const createCollection = {
  body: Joi.object({
    title: Joi.string().trim().max(160).required(),
    slug: Joi.string().trim().max(200).allow('').default(''),
    description: Joi.string().trim().max(500).allow('').default(''),
    narrative: Joi.string().trim().max(10000).allow('').default(''),
    photos: Joi.array().items(photoSchema).max(60).default([]),
    status: Joi.string().valid(...ARCHIVE_STATUSES_ARRAY).default(ARCHIVE_STATUSES.DRAFT),
  }),
};

const updateCollection = {
  body: Joi.object({
    title: Joi.string().trim().max(160).optional(),
    slug: Joi.string().trim().max(200).allow('').optional(),
    description: Joi.string().trim().max(500).allow('').optional(),
    narrative: Joi.string().trim().max(10000).allow('').optional(),
    photos: Joi.array().items(photoSchema).max(60).optional(),
    status: Joi.string().valid(...ARCHIVE_STATUSES_ARRAY).optional(),
  }),
};

const createStory = {
  body: Joi.object({
    title: Joi.string().trim().max(160).required(),
    slug: Joi.string().trim().max(200).allow('').default(''),
    summary: Joi.string().trim().max(500).allow('').default(''),
    narrative: Joi.string().trim().max(10000).allow('').default(''),
    collectionId: optionalObjectId,
    photos: Joi.array().items(photoSchema).max(60).default([]),
    eventDate: Joi.alternatives().try(Joi.date().iso(), Joi.valid(null, '')).default(null),
    status: Joi.string().valid(...ARCHIVE_STATUSES_ARRAY).default(ARCHIVE_STATUSES.DRAFT),
  }),
};

const updateStory = {
  body: Joi.object({
    title: Joi.string().trim().max(160).optional(),
    slug: Joi.string().trim().max(200).allow('').optional(),
    summary: Joi.string().trim().max(500).allow('').optional(),
    narrative: Joi.string().trim().max(10000).allow('').optional(),
    collectionId: optionalObjectId,
    photos: Joi.array().items(photoSchema).max(60).optional(),
    eventDate: Joi.alternatives().try(Joi.date().iso(), Joi.valid(null, '')).optional(),
    status: Joi.string().valid(...ARCHIVE_STATUSES_ARRAY).optional(),
  }),
};

const createHonoree = {
  body: Joi.object({
    fullName: Joi.string().trim().max(160).required(),
    honorTitle: Joi.string().trim().max(200).allow('').default(''),
    summary: Joi.string().trim().max(500).allow('').default(''),
    narrative: Joi.string().trim().max(10000).allow('').default(''),
    collectionId: optionalObjectId,
    photos: Joi.array().items(photoSchema).max(60).default([]),
    honorDate: Joi.alternatives().try(Joi.date().iso(), Joi.valid(null, '')).default(null),
    status: Joi.string().valid(...ARCHIVE_STATUSES_ARRAY).default(ARCHIVE_STATUSES.DRAFT),
  }),
};

const updateHonoree = {
  body: Joi.object({
    fullName: Joi.string().trim().max(160).optional(),
    honorTitle: Joi.string().trim().max(200).allow('').optional(),
    summary: Joi.string().trim().max(500).allow('').optional(),
    narrative: Joi.string().trim().max(10000).allow('').optional(),
    collectionId: optionalObjectId,
    photos: Joi.array().items(photoSchema).max(60).optional(),
    honorDate: Joi.alternatives().try(Joi.date().iso(), Joi.valid(null, '')).optional(),
    status: Joi.string().valid(...ARCHIVE_STATUSES_ARRAY).optional(),
  }),
};

module.exports = {
  idParam,
  createCollection,
  updateCollection,
  createStory,
  updateStory,
  createHonoree,
  updateHonoree,
};
