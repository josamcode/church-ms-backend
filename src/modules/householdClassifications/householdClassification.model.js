const mongoose = require('mongoose');
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

const criterionFiltersSchema = new mongoose.Schema(
  {
    genders: [
      {
        type: String,
        enum: ['male', 'female', 'other'],
      },
    ],
    ageGroups: [
      {
        type: String,
        enum: AGE_GROUPS_ARRAY,
      },
    ],
    educationStages: [
      {
        type: String,
        enum: EDUCATION_STAGE_FILTER_VALUES,
      },
    ],
    employmentStatuses: [
      {
        type: String,
        enum: EMPLOYMENT_STATUSES_ARRAY,
      },
    ],
    presenceStatuses: [
      {
        type: String,
        enum: PRESENCE_STATUSES_ARRAY,
      },
    ],
    diseases: [{ type: String, trim: true }],
    diseaseMatchMode: {
      type: String,
      enum: ['any', 'all'],
      default: 'any',
    },
    travelDestinations: [{ type: String, trim: true }],
    minMonthlyIncome: { type: Number, min: 0 },
    maxMonthlyIncome: { type: Number, min: 0 },
  },
  { _id: false }
);

const classificationCriterionSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    isRequired: { type: Boolean, default: true },
    metric: {
      type: String,
      required: true,
      enum: HOUSEHOLD_CLASSIFICATION_METRICS_ARRAY,
    },
    operator: {
      type: String,
      required: true,
      enum: HOUSEHOLD_CLASSIFICATION_OPERATORS_ARRAY,
    },
    value: { type: mongoose.Schema.Types.Mixed },
    minValue: { type: Number },
    maxValue: { type: Number },
    filters: criterionFiltersSchema,
  },
  { _id: true }
);

const householdClassificationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    color: {
      type: String,
      trim: true,
      default: '#2563eb',
    },
    priority: {
      type: Number,
      default: 100,
      min: 0,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    isLordsBrethren: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: { type: Date },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    criteria: {
      type: [classificationCriterionSchema],
      default: [],
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

householdClassificationSchema.index(
  { name: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  }
);
householdClassificationSchema.index({ isActive: 1, priority: 1, createdAt: 1 });

const HouseholdClassification = mongoose.model(
  'HouseholdClassification',
  householdClassificationSchema
);

module.exports = HouseholdClassification;
