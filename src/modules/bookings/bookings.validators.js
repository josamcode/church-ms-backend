const Joi = require('joi');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const timeRangeSchema = Joi.object({
  startTime: Joi.string().pattern(TIME_PATTERN).allow('', null).optional(),
  endTime: Joi.string().pattern(TIME_PATTERN).allow('', null).optional(),
});

const dateRangeSchema = Joi.object({
  startDate: Joi.string().pattern(DATE_PATTERN).allow('', null).optional(),
  endDate: Joi.string().pattern(DATE_PATTERN).allow('', null).optional(),
});

const specificDateSchema = Joi.object({
  date: Joi.string().pattern(DATE_PATTERN).required(),
  startTime: Joi.string().pattern(TIME_PATTERN).allow('', null).optional(),
  endTime: Joi.string().pattern(TIME_PATTERN).allow('', null).optional(),
  exactTimes: Joi.array().items(Joi.string().pattern(TIME_PATTERN)).default([]),
});

const explicitDateTimeSchema = Joi.object({
  date: Joi.string().pattern(DATE_PATTERN).required(),
  time: Joi.string().pattern(TIME_PATTERN).required(),
});

const fieldOptionSchema = Joi.object({
  label: Joi.string().trim().min(1).max(120).required(),
  value: Joi.string().trim().min(1).max(120).required(),
});

const dynamicFieldSchema = Joi.object({
  key: Joi.string().trim().pattern(FIELD_KEY_PATTERN).max(60).required().messages({
    'string.pattern.base': 'Field key must start with a letter and contain only letters, numbers, and underscores',
  }),
  label: Joi.string().trim().min(1).max(160).required(),
  type: Joi.string()
    .valid('text', 'textarea', 'number', 'email', 'phone', 'image', 'date', 'checkbox', 'select')
    .required(),
  required: Joi.boolean().default(false),
  placeholder: Joi.string().trim().max(240).allow('', null).optional(),
  helpText: Joi.string().trim().max(500).allow('', null).optional(),
  options: Joi.array().items(fieldOptionSchema).default([]),
}).custom((value, helpers) => {
  if (value.type === 'select' && (!Array.isArray(value.options) || value.options.length === 0)) {
    return helpers.message('Select fields require at least one option');
  }
  return value;
});

function validateTypePayload(value, helpers) {
  const mode = value.availabilityMode;
  const config = value.availabilityConfig || {};
  const timeRange = config.timeRange || {};
  const dateRange = config.dateRange || {};

  const hasTimeRange = Boolean(timeRange.startTime && timeRange.endTime);

  if (hasTimeRange && timeRange.startTime >= timeRange.endTime) {
    return helpers.message('Availability start time must be before end time');
  }

  if (dateRange.startDate && dateRange.endDate && dateRange.startDate > dateRange.endDate) {
    return helpers.message('Availability start date must be before end date');
  }

  if (mode === 'DATE_RANGE') {
    if (!dateRange.startDate || !dateRange.endDate) {
      return helpers.message('Date-range booking types require a start date and end date');
    }
  }

  if (mode === 'DATE_TIME_RANGE') {
    if (!dateRange.startDate || !dateRange.endDate) {
      return helpers.message('Date-and-time range booking types require a start date and end date');
    }
    if (!hasTimeRange) {
      return helpers.message('Date-and-time range booking types require a time range');
    }
  }

  if (mode === 'SPECIFIC_DAYS') {
    if (!Array.isArray(config.specificDays) || config.specificDays.length === 0) {
      return helpers.message('Specific-days booking types require at least one weekday');
    }
  }

  if (mode === 'SPECIFIC_DAYS_TIME') {
    if (!Array.isArray(config.specificDays) || config.specificDays.length === 0) {
      return helpers.message('Specific-days-and-times booking types require at least one weekday');
    }
    if (!hasTimeRange) {
      return helpers.message('Specific-days-and-times booking types require a time range');
    }
  }

  if (mode === 'SPECIFIC_DATES' && (!Array.isArray(config.specificDates) || config.specificDates.length === 0)) {
    return helpers.message('Specific-dates booking types require at least one configured date');
  }

  if (mode === 'SPECIFIC_DATES_TIME' || mode === 'DATE_TIME') {
    const hasSpecificDateTimes = (Array.isArray(config.specificDates) ? config.specificDates : []).some(
      (entry) => entry.date && Array.isArray(entry.exactTimes) && entry.exactTimes.length > 0
    );
    const hasLegacyExactDateTimes = Array.isArray(config.exactDateTimes) && config.exactDateTimes.length > 0;

    if (!hasSpecificDateTimes && !hasLegacyExactDateTimes) {
      return helpers.message('Specific-dates-and-times booking types require at least one exact time');
    }
  }

  return value;
}

const bookingTypeBody = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  description: Joi.string().trim().max(500).allow('', null).optional(),
  instructions: Joi.string().trim().max(5000).allow('', null).optional(),
  isActive: Joi.boolean().default(true),
  availabilityMode: Joi.string()
    .valid(
      'ALWAYS',
      'DATE_RANGE',
      'DATE_TIME_RANGE',
      'SPECIFIC_DAYS',
      'SPECIFIC_DAYS_TIME',
      'SPECIFIC_DATES',
      'SPECIFIC_DATES_TIME',
      'DATE_TIME',
      'NONE'
    )
    .required(),
  durationMinutes: Joi.number().integer().min(5).max(1440).default(30),
  slotIntervalMinutes: Joi.number().integer().min(5).max(1440).default(30),
  capacity: Joi.number().integer().min(1).max(100).default(1),
  bookingHorizonDays: Joi.number().integer().min(1).max(365).default(60),
  availabilityConfig: Joi.object({
    timezone: Joi.string().trim().max(80).default('Africa/Cairo'),
    timeRange: timeRangeSchema.default({}),
    dateRange: dateRangeSchema.default({}),
    specificDays: Joi.array().items(Joi.number().integer().min(0).max(6)).default([]),
    specificDates: Joi.array().items(specificDateSchema).default([]),
    exactDateTimes: Joi.array().items(explicitDateTimeSchema).default([]),
  })
    .default({})
    .required(),
  dynamicFields: Joi.array().items(dynamicFieldSchema).max(50).default([]),
}).custom(validateTypePayload);

const idParam = {
  params: Joi.object({
    id: Joi.string().pattern(OBJECT_ID_PATTERN).required(),
  }),
};

const createBookingType = {
  body: bookingTypeBody,
};

const updateBookingType = {
  params: idParam.params,
  body: bookingTypeBody,
};

const listPublicSlots = {
  params: idParam.params,
  query: Joi.object({
    fromDate: Joi.string().pattern(DATE_PATTERN).optional(),
    days: Joi.number().integer().min(1).max(120).default(45),
  }),
};

const createPublicBooking = {
  body: Joi.object({
    bookingTypeId: Joi.string().pattern(OBJECT_ID_PATTERN).required(),
    requesterName: Joi.string().trim().min(2).max(160).required(),
    requesterPhone: Joi.string().trim().min(3).max(40).required(),
    requesterEmail: Joi.string().email().trim().max(160).allow('', null).optional(),
    scheduledDate: Joi.string().pattern(DATE_PATTERN).required(),
    scheduledTime: Joi.string().pattern(TIME_PATTERN).allow('', null).optional(),
    notes: Joi.string().trim().max(5000).allow('', null).optional(),
    dynamicFields: Joi.array()
      .items(
        Joi.object({
          key: Joi.string().trim().pattern(FIELD_KEY_PATTERN).required(),
          value: Joi.any().allow(null),
        })
      )
      .default([]),
  }),
};

const listBookings = {
  query: Joi.object({
    cursor: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).default(20),
    order: Joi.string().valid('asc', 'desc').default('desc'),
    status: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled').optional(),
    bookingTypeId: Joi.string().pattern(OBJECT_ID_PATTERN).optional(),
    q: Joi.string().trim().max(200).optional(),
    dateFrom: Joi.string().pattern(DATE_PATTERN).optional(),
    dateTo: Joi.string().pattern(DATE_PATTERN).optional(),
  }),
};

const updateBooking = {
  params: idParam.params,
  body: Joi.object({
    status: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled').optional(),
    adminNotes: Joi.string().trim().max(5000).allow('', null).optional(),
  })
    .min(1)
    .messages({ 'object.min': 'At least one field must be provided for update' }),
};

module.exports = {
  idParam,
  createBookingType,
  updateBookingType,
  listPublicSlots,
  createPublicBooking,
  listBookings,
  updateBooking,
};
