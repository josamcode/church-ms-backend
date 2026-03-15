const Joi = require('joi');
const { AGE_GROUPS_ARRAY } = require('../../constants/ageGroups');
const { EDUCATION_STAGE_FILTER_VALUES } = require('../../constants/education');
const {
  EMPLOYMENT_STATUSES_ARRAY,
  PRESENCE_STATUSES_ARRAY,
} = require('../../constants/householdProfiles');
const {
  HOUSEHOLD_CLASSIFICATION_METRICS_ARRAY,
  HOUSEHOLD_CLASSIFICATION_OPERATORS_ARRAY,
} = require('./householdClassification.catalog');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const criterionFiltersSchema = Joi.object({
  genders: Joi.array().items(Joi.string().valid('male', 'female', 'other')).optional(),
  ageGroups: Joi.array().items(Joi.string().valid(...AGE_GROUPS_ARRAY)).optional(),
  educationStages: Joi.array().items(Joi.string().valid(...EDUCATION_STAGE_FILTER_VALUES)).optional(),
  employmentStatuses: Joi.array()
    .items(Joi.string().valid(...EMPLOYMENT_STATUSES_ARRAY))
    .optional(),
  presenceStatuses: Joi.array()
    .items(Joi.string().valid(...PRESENCE_STATUSES_ARRAY))
    .optional(),
  diseases: Joi.array().items(Joi.string().trim().min(1)).optional(),
  diseaseMatchMode: Joi.string().valid('any', 'all').optional(),
  travelDestinations: Joi.array().items(Joi.string().trim().min(1)).optional(),
  minMonthlyIncome: Joi.number().min(0).optional(),
  maxMonthlyIncome: Joi.number().min(0).optional(),
}).optional();

const criterionSchema = Joi.object({
  label: Joi.string().trim().allow('', null).optional(),
  isRequired: Joi.boolean().optional(),
  metric: Joi.string().valid(...HOUSEHOLD_CLASSIFICATION_METRICS_ARRAY).required(),
  operator: Joi.string().valid(...HOUSEHOLD_CLASSIFICATION_OPERATORS_ARRAY).required(),
  value: Joi.alternatives().try(Joi.number(), Joi.boolean()).optional(),
  minValue: Joi.number().optional(),
  maxValue: Joi.number().optional(),
  filters: criterionFiltersSchema,
});

const categoryBody = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  description: Joi.string().trim().allow('', null).max(1000).optional(),
  color: Joi.string().trim().allow('', null).optional(),
  priority: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().optional(),
  isLordsBrethren: Joi.boolean().optional(),
  criteria: Joi.array().items(criterionSchema).optional(),
});

const idParam = {
  params: Joi.object({
    id: Joi.string().pattern(OBJECT_ID_PATTERN).required(),
  }),
};

const createCategory = {
  body: categoryBody,
};

const updateCategory = {
  params: idParam.params,
  body: categoryBody.min(1),
};

const listHouseholds = {
  query: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(12),
    search: Joi.string().trim().allow('', null).optional(),
    classificationId: Joi.string().pattern(OBJECT_ID_PATTERN).optional(),
    includeUnclassified: Joi.boolean().optional(),
    isLordsBrethren: Joi.boolean().optional(),
  }),
};

const getHouseholdByName = {
  query: Joi.object({
    houseName: Joi.string().trim().min(2).max(160).required(),
  }),
};

const updateHousehold = {
  body: Joi.object({
    currentHouseName: Joi.string().trim().min(2).max(160).required(),
    houseName: Joi.string().trim().min(2).max(160).optional(),
    manualPrimaryClassificationId: Joi.string()
      .pattern(OBJECT_ID_PATTERN)
      .allow('', null)
      .optional(),
    totalIncome: Joi.number().min(0).optional(),
    incomeSources: Joi.array().items(Joi.string().trim().min(1)).optional(),
  })
    .min(1)
    .messages({ 'object.min': 'At least one household field must be provided.' }),
};

module.exports = {
  createCategory,
  getHouseholdByName,
  idParam,
  listHouseholds,
  updateHousehold,
  updateCategory,
};
