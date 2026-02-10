const mongoose = require('mongoose');

const confessionSessionSchema = new mongoose.Schema(
  {
    attendeeUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    attendeeNameSnapshot: {
      type: String,
      trim: true,
      required: true,
      maxlength: 120,
    },
    sessionTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConfessionSessionType',
      required: true,
      index: true,
    },
    sessionTypeNameSnapshot: {
      type: String,
      trim: true,
      required: true,
      maxlength: 120,
    },
    scheduledAt: {
      type: Date,
      required: true,
      index: true,
    },
    nextSessionAt: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

confessionSessionSchema.index({ attendeeUserId: 1, scheduledAt: -1 });
confessionSessionSchema.index({ sessionTypeId: 1, scheduledAt: -1 });

const ConfessionSession = mongoose.model('ConfessionSession', confessionSessionSchema);

module.exports = ConfessionSession;
