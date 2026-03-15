const mongoose = require('mongoose');

const MEETING_DOCUMENTATION_FIELD_TYPES = [
  'text',
  'number',
  'image',
  'video',
  'document',
];

const meetingDocumentationFieldConfigSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    type: {
      type: String,
      enum: MEETING_DOCUMENTATION_FIELD_TYPES,
      required: true,
    },
    required: {
      type: Boolean,
      default: false,
    },
    placeholder: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    helpText: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: true }
);

const meetingDocumentationConfigSchema = new mongoose.Schema(
  {
    singletonKey: {
      type: String,
      default: 'main',
      unique: true,
      index: true,
    },
    fields: {
      type: [meetingDocumentationFieldConfigSchema],
      default: [],
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

const MeetingDocumentationConfig = mongoose.model(
  'MeetingDocumentationConfig',
  meetingDocumentationConfigSchema
);

async function getOrCreateMeetingDocumentationConfig() {
  let config = await MeetingDocumentationConfig.findOne({ singletonKey: 'main' });
  if (!config) {
    config = await MeetingDocumentationConfig.create({
      singletonKey: 'main',
      fields: [],
    });
  }
  return config;
}

module.exports = MeetingDocumentationConfig;
module.exports.MEETING_DOCUMENTATION_FIELD_TYPES = MEETING_DOCUMENTATION_FIELD_TYPES;
module.exports.getOrCreateMeetingDocumentationConfig = getOrCreateMeetingDocumentationConfig;
