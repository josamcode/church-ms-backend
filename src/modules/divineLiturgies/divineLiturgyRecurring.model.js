const mongoose = require('mongoose');

const SERVICE_TYPES = Object.freeze({
  DIVINE_LITURGY: 'DIVINE_LITURGY',
  VESPERS: 'VESPERS',
});

const DAYS_OF_WEEK = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

const divineLiturgyRecurringSchema = new mongoose.Schema(
  {
    serviceType: {
      type: String,
      enum: Object.values(SERVICE_TYPES),
      required: true,
      index: true,
    },
    dayOfWeek: {
      type: String,
      enum: DAYS_OF_WEEK,
      required: true,
      index: true,
    },
    startTime: {
      type: String,
      required: true,
      trim: true,
    },
    endTime: {
      type: String,
      trim: true,
    },
    name: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    priestUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

divineLiturgyRecurringSchema.pre('validate', function (next) {
  if (typeof this.name === 'string') {
    this.name = this.name.trim();
    if (!this.name) this.name = undefined;
  }
  if (typeof this.endTime === 'string') {
    this.endTime = this.endTime.trim();
    if (!this.endTime) this.endTime = undefined;
  }
  next();
});

divineLiturgyRecurringSchema.index({
  serviceType: 1,
  dayOfWeek: 1,
  startTime: 1,
});

const DivineLiturgyRecurring = mongoose.model(
  'DivineLiturgyRecurring',
  divineLiturgyRecurringSchema
);

module.exports = DivineLiturgyRecurring;
module.exports.SERVICE_TYPES = SERVICE_TYPES;
module.exports.DAYS_OF_WEEK = DAYS_OF_WEEK;
