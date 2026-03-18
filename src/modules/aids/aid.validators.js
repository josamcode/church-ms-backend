const Joi = require('joi');

const createBulkAidsBody = {
  body: Joi.object({
    houseNames: Joi.array().items(Joi.string().trim().max(160)).min(1).required(),
    aid: Joi.object({
      category: Joi.string().trim().max(100).required(),
      occurrence: Joi.string().trim().max(100).required(),
      description: Joi.string().trim().max(500).required(),
      notes: Joi.string().trim().allow('', null).max(2000).optional(),
      date: Joi.date().iso().required(),
    }).required(),
  })
};

const getDisbursedAidsQuery = {
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    search: Joi.string().trim().allow('', null).optional(),
    category: Joi.string().trim().allow('', null).optional(),
  }),
};

const getAidDetailsQuery = {
  query: Joi.object({
    date: Joi.date().iso().required(),
    category: Joi.string().trim().required(),
    occurrence: Joi.string().trim().required(),
    description: Joi.string().trim().required(),
  }),
};

const searchAidHistoryBody = {
  body: Joi.object({
    houseNames: Joi.array().items(Joi.string().trim().max(160)).min(1).required(),
  }),
};

const approveAidReminderParams = {
  params: Joi.object({
    id: Joi.string().trim().hex().length(24).required(),
  }),
};

const updateFullAidGroupBody = {
  body: Joi.object({
    originalGroup: Joi.object({
      date: Joi.date().iso().required(),
      category: Joi.string().trim().required(),
      occurrence: Joi.string().trim().required(),
      description: Joi.string().trim().required(),
    }).required(),
    updatedData: Joi.object({
      date: Joi.date().iso().required(),
      category: Joi.string().trim().max(100).required(),
      occurrence: Joi.string().trim().max(100).required(),
      description: Joi.string().trim().max(500).required(),
      notes: Joi.string().trim().allow('', null).max(2000).optional(),
    }).required(),
    houseNames: Joi.array().items(Joi.string().trim().max(160)).min(1).required(),
  }),
};

module.exports = {
  approveAidReminderParams,
  createBulkAidsBody,
  getDisbursedAidsQuery,
  getAidDetailsQuery,
  searchAidHistoryBody,
  updateFullAidGroupBody,
};
