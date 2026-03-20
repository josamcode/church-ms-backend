const mongoose = require('mongoose');
const {
  ARCHIVE_DOCUMENT_KEY,
  ARCHIVE_STATUSES,
  ARCHIVE_STATUSES_ARRAY,
} = require('./archive.constants');

const archivePhotoSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      trim: true,
      required: true,
    },
    publicId: {
      type: String,
      trim: true,
      default: null,
    },
    caption: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { _id: false }
);

const auditFields = {
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
};

const archiveCollectionSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      required: true,
      maxlength: 160,
    },
    slug: {
      type: String,
      trim: true,
      required: true,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500,
    },
    narrative: {
      type: String,
      trim: true,
      default: '',
      maxlength: 10000,
    },
    photos: {
      type: [archivePhotoSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ARCHIVE_STATUSES_ARRAY,
      default: ARCHIVE_STATUSES.DRAFT,
    },
    ...auditFields,
  },
  { timestamps: true }
);

const archiveStorySchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      required: true,
      maxlength: 160,
    },
    slug: {
      type: String,
      trim: true,
      required: true,
      maxlength: 200,
    },
    summary: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500,
    },
    narrative: {
      type: String,
      trim: true,
      default: '',
      maxlength: 10000,
    },
    collectionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    photos: {
      type: [archivePhotoSchema],
      default: [],
    },
    eventDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ARCHIVE_STATUSES_ARRAY,
      default: ARCHIVE_STATUSES.DRAFT,
    },
    ...auditFields,
  },
  { timestamps: true }
);

const archiveHonoreeSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      trim: true,
      required: true,
      maxlength: 160,
    },
    honorTitle: {
      type: String,
      trim: true,
      default: '',
      maxlength: 200,
    },
    summary: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500,
    },
    narrative: {
      type: String,
      trim: true,
      default: '',
      maxlength: 10000,
    },
    collectionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    photos: {
      type: [archivePhotoSchema],
      default: [],
    },
    honorDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ARCHIVE_STATUSES_ARRAY,
      default: ARCHIVE_STATUSES.DRAFT,
    },
    ...auditFields,
  },
  { timestamps: true }
);

const archiveContentSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      trim: true,
      unique: true,
      default: ARCHIVE_DOCUMENT_KEY,
    },
    collections: {
      type: [archiveCollectionSchema],
      default: [],
    },
    stories: {
      type: [archiveStorySchema],
      default: [],
    },
    honorees: {
      type: [archiveHonoreeSchema],
      default: [],
    },
    ...auditFields,
  },
  { timestamps: true }
);

const ArchiveContent = mongoose.model('ArchiveContent', archiveContentSchema);

module.exports = ArchiveContent;
