const mongoose = require('mongoose');

const meetingResponsibilitySchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    normalizedLabel: {
      type: String,
      required: true,
      select: false,
      unique: true,
    },
    usageCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

meetingResponsibilitySchema.pre('validate', function (next) {
  if (typeof this.label === 'string') {
    this.label = this.label.trim();
    this.normalizedLabel = this.label.toLowerCase();
  }
  next();
});

meetingResponsibilitySchema.index({ usageCount: -1, lastUsedAt: -1, label: 1 });

const MeetingResponsibility = mongoose.model('MeetingResponsibility', meetingResponsibilitySchema);

module.exports = MeetingResponsibility;
