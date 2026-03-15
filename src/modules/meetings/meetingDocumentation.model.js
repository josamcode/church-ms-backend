const mongoose = require('mongoose');
const { MEETING_DOCUMENTATION_FIELD_TYPES } = require('./meetingDocumentationConfig.model');

const MEETING_DOCUMENTATION_ASSET_KINDS = ['image', 'video', 'document'];

const meetingDocumentationAssetSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true,
    },
    publicId: {
      type: String,
      trim: true,
    },
    originalName: {
      type: String,
      trim: true,
      maxlength: 260,
    },
    mimeType: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    kind: {
      type: String,
      enum: MEETING_DOCUMENTATION_ASSET_KINDS,
      required: true,
    },
    resourceType: {
      type: String,
      enum: ['image', 'video', 'raw'],
      required: true,
    },
    bytes: {
      type: Number,
      min: 0,
    },
  },
  { _id: false }
);

const meetingDocumentationFieldResponseSchema = new mongoose.Schema(
  {
    fieldId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    fieldLabel: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    fieldType: {
      type: String,
      enum: MEETING_DOCUMENTATION_FIELD_TYPES,
      required: true,
    },
    textValue: {
      type: String,
      trim: true,
      maxlength: 4000,
    },
    numberValue: {
      type: Number,
    },
    assets: {
      type: [meetingDocumentationAssetSchema],
      default: [],
    },
  },
  { _id: false }
);

const meetingDocumentationSnapshotSchema = new mongoose.Schema(
  {
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    accessLevel: {
      type: String,
      enum: ['full', 'servant', 'member'],
      required: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 4000,
    },
    attachments: {
      type: [meetingDocumentationAssetSchema],
      default: [],
    },
    fieldResponses: {
      type: [meetingDocumentationFieldResponseSchema],
      default: [],
    },
    action: {
      type: String,
      default: 'documentation_saved',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const meetingDocumentationSchema = new mongoose.Schema(
  {
    meetingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Meeting',
      required: true,
      index: true,
    },
    documentationDate: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 4000,
    },
    attachments: {
      type: [meetingDocumentationAssetSchema],
      default: [],
    },
    fieldResponses: {
      type: [meetingDocumentationFieldResponseSchema],
      default: [],
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
    history: {
      type: [meetingDocumentationSnapshotSchema],
      default: [],
    },
  },
  { timestamps: true }
);

meetingDocumentationSchema.index({ meetingId: 1, documentationDate: 1 }, { unique: true });

const MeetingDocumentation = mongoose.model('MeetingDocumentation', meetingDocumentationSchema);

module.exports = MeetingDocumentation;
module.exports.MEETING_DOCUMENTATION_ASSET_KINDS = MEETING_DOCUMENTATION_ASSET_KINDS;
