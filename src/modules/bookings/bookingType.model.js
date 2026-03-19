const mongoose = require('mongoose');

const AVAILABILITY_MODES = Object.freeze({
  ALWAYS: 'ALWAYS',
  DATE_RANGE: 'DATE_RANGE',
  DATE_TIME_RANGE: 'DATE_TIME_RANGE',
  SPECIFIC_DAYS: 'SPECIFIC_DAYS',
  SPECIFIC_DAYS_TIME: 'SPECIFIC_DAYS_TIME',
  SPECIFIC_DATES: 'SPECIFIC_DATES',
  SPECIFIC_DATES_TIME: 'SPECIFIC_DATES_TIME',
  DATE_TIME: 'DATE_TIME',
  NONE: 'NONE',
});

const AVAILABILITY_MODE_VALUES = Object.freeze(Object.values(AVAILABILITY_MODES));

const FIELD_TYPES = Object.freeze({
  TEXT: 'text',
  TEXTAREA: 'textarea',
  NUMBER: 'number',
  EMAIL: 'email',
  PHONE: 'phone',
  IMAGE: 'image',
  DATE: 'date',
  CHECKBOX: 'checkbox',
  SELECT: 'select',
});

const FIELD_TYPE_VALUES = Object.freeze(Object.values(FIELD_TYPES));

const timeRangeSchema = new mongoose.Schema(
  {
    startTime: { type: String, trim: true },
    endTime: { type: String, trim: true },
  },
  { _id: false }
);

const dateRangeSchema = new mongoose.Schema(
  {
    startDate: { type: String, trim: true },
    endDate: { type: String, trim: true },
  },
  { _id: false }
);

const explicitDateTimeSchema = new mongoose.Schema(
  {
    date: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    time: {
      type: String,
      required: true,
      trim: true,
      match: /^([01]\d|2[0-3]):([0-5]\d)$/,
    },
  },
  { _id: false }
);

const specificDateSchema = new mongoose.Schema(
  {
    date: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    startTime: {
      type: String,
      trim: true,
      match: /^([01]\d|2[0-3]):([0-5]\d)$/,
    },
    endTime: {
      type: String,
      trim: true,
      match: /^([01]\d|2[0-3]):([0-5]\d)$/,
    },
    exactTimes: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const fieldOptionSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    value: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
  },
  { _id: false }
);

const dynamicFieldSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    type: {
      type: String,
      enum: FIELD_TYPE_VALUES,
      required: true,
    },
    required: {
      type: Boolean,
      default: false,
    },
    placeholder: {
      type: String,
      trim: true,
      maxlength: 240,
    },
    helpText: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    options: {
      type: [fieldOptionSchema],
      default: [],
    },
  },
  { _id: false }
);

const bookingTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    normalizedName: {
      type: String,
      required: true,
      unique: true,
      select: false,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    instructions: {
      type: String,
      trim: true,
      maxlength: 5000,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    availabilityMode: {
      type: String,
      enum: AVAILABILITY_MODE_VALUES,
      default: AVAILABILITY_MODES.NONE,
    },
    durationMinutes: {
      type: Number,
      min: 5,
      max: 1440,
      default: 30,
    },
    slotIntervalMinutes: {
      type: Number,
      min: 5,
      max: 1440,
      default: 30,
    },
    capacity: {
      type: Number,
      min: 1,
      max: 100,
      default: 1,
    },
    bookingHorizonDays: {
      type: Number,
      min: 1,
      max: 365,
      default: 60,
    },
    availabilityConfig: {
      timezone: {
        type: String,
        trim: true,
        default: 'Africa/Cairo',
      },
      timeRange: {
        type: timeRangeSchema,
        default: () => ({}),
      },
      dateRange: {
        type: dateRangeSchema,
        default: () => ({}),
      },
      specificDays: {
        type: [Number],
        default: [],
      },
      specificDates: {
        type: [specificDateSchema],
        default: [],
      },
      exactDateTimes: {
        type: [explicitDateTimeSchema],
        default: [],
      },
    },
    dynamicFields: {
      type: [dynamicFieldSchema],
      default: [],
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

bookingTypeSchema.pre('validate', function (next) {
  if (typeof this.name === 'string') {
    this.name = this.name.trim();
    this.normalizedName = this.name.toLowerCase();
  }

  if (Array.isArray(this.dynamicFields)) {
    this.dynamicFields = this.dynamicFields.map((field) => ({
      ...field,
      key: typeof field.key === 'string' ? field.key.trim() : field.key,
      label: typeof field.label === 'string' ? field.label.trim() : field.label,
      placeholder:
        typeof field.placeholder === 'string' ? field.placeholder.trim() : field.placeholder,
      helpText: typeof field.helpText === 'string' ? field.helpText.trim() : field.helpText,
      options: Array.isArray(field.options)
        ? field.options
            .map((option) => ({
              ...option,
              label: typeof option.label === 'string' ? option.label.trim() : option.label,
              value: typeof option.value === 'string' ? option.value.trim() : option.value,
            }))
            .filter((option) => option.label && option.value)
        : [],
    }));
  }

  next();
});

bookingTypeSchema.index({ isActive: 1, name: 1 });
bookingTypeSchema.index({ availabilityMode: 1, isActive: 1 });

const BookingType = mongoose.model('BookingType', bookingTypeSchema);

module.exports = BookingType;
module.exports.AVAILABILITY_MODES = AVAILABILITY_MODES;
module.exports.AVAILABILITY_MODE_VALUES = AVAILABILITY_MODE_VALUES;
module.exports.FIELD_TYPES = FIELD_TYPES;
module.exports.FIELD_TYPE_VALUES = FIELD_TYPE_VALUES;
