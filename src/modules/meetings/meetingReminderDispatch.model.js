const mongoose = require('mongoose');

const meetingReminderDispatchSchema = new mongoose.Schema(
  {
    meetingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Meeting',
      required: true,
      index: true,
    },
    occurrenceAt: {
      type: Date,
      required: true,
      index: true,
    },
    reminderAt: {
      type: Date,
      required: true,
      index: true,
    },
    reminderLeadMinutes: {
      type: Number,
      required: true,
      min: 0,
      max: 10080,
    },
    recipientCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

meetingReminderDispatchSchema.index(
  { meetingId: 1, occurrenceAt: 1 },
  { unique: true }
);

const MeetingReminderDispatch = mongoose.model(
  'MeetingReminderDispatch',
  meetingReminderDispatchSchema
);

module.exports = MeetingReminderDispatch;
