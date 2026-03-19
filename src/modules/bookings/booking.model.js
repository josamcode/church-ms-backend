const mongoose = require('mongoose');

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const BOOKING_STATUSES = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

const BOOKING_STATUS_VALUES = Object.freeze(Object.values(BOOKING_STATUSES));

const requesterSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 40,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 160,
    },
  },
  { _id: false }
);

const additionalFieldSchema = new mongoose.Schema(
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
      required: true,
      trim: true,
      maxlength: 40,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { _id: false }
);

const bookingSchema = new mongoose.Schema(
  {
    bookingTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BookingType',
      required: true,
      index: true,
    },
    bookingTypeNameSnapshot: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    requester: {
      type: requesterSchema,
      required: true,
    },
    scheduledDate: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    scheduledTime: {
      type: String,
      default: null,
      trim: true,
      validate: {
        validator: (value) => value == null || TIME_PATTERN.test(value),
        message: 'Scheduled time must be a valid HH:mm value',
      },
    },
    scheduledAt: {
      type: Date,
      required: true,
      index: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 5000,
    },
    additionalFields: {
      type: [additionalFieldSchema],
      default: [],
    },
    status: {
      type: String,
      enum: BOOKING_STATUS_VALUES,
      default: BOOKING_STATUSES.PENDING,
      index: true,
    },
    adminNotes: {
      type: String,
      trim: true,
      maxlength: 5000,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    source: {
      type: String,
      trim: true,
      default: 'public',
      maxlength: 40,
    },
  },
  { timestamps: true }
);

bookingSchema.index({ bookingTypeId: 1, scheduledDate: 1, scheduledTime: 1, status: 1 });
bookingSchema.index({ 'requester.name': 1, 'requester.phone': 1 });

const Booking = mongoose.model('Booking', bookingSchema);

module.exports = Booking;
module.exports.BOOKING_STATUSES = BOOKING_STATUSES;
module.exports.BOOKING_STATUS_VALUES = BOOKING_STATUS_VALUES;
