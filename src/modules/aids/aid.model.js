const mongoose = require('mongoose');

const aidSchema = new mongoose.Schema(
  {
    houseName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      index: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      index: true,
    },
    occurrence: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    isRecurringSource: {
      type: Boolean,
      default: true,
      index: true,
    },
    recurrenceAnchorDate: {
      type: Date,
      index: true,
    },
    reminderNotificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notification',
      index: true,
    },
  },
  { timestamps: true }
);

aidSchema.index({ date: -1, _id: -1 });

const Aid = mongoose.model('Aid', aidSchema);

module.exports = Aid;
