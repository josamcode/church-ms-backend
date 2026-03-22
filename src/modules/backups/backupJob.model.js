const mongoose = require('mongoose');

const backupJobSchema = new mongoose.Schema(
  {
    jobName: {
      type: String,
      trim: true,
      required: true,
      unique: true,
      maxlength: 80,
    },
    running: {
      type: Boolean,
      default: false,
      index: true,
    },
    currentRunId: {
      type: String,
      trim: true,
      default: '',
      maxlength: 80,
    },
    lockAcquiredAt: {
      type: Date,
      default: null,
    },
    lockExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastRunStartedAt: {
      type: Date,
      default: null,
    },
    lastRunCompletedAt: {
      type: Date,
      default: null,
    },
    lastSuccessAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastFailureAt: {
      type: Date,
      default: null,
    },
    lastStatus: {
      type: String,
      enum: ['idle', 'running', 'success', 'failed'],
      default: 'idle',
    },
    lastTrigger: {
      type: String,
      trim: true,
      default: '',
      maxlength: 60,
    },
    lastError: {
      type: String,
      trim: true,
      default: '',
      maxlength: 5000,
    },
    lastBackupFilename: {
      type: String,
      trim: true,
      default: '',
      maxlength: 255,
    },
    lastBackupSizeBytes: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastUploadedFileId: {
      type: String,
      trim: true,
      default: '',
      maxlength: 255,
    },
    lastUploadedFileLink: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },
    lastCleanupAt: {
      type: Date,
      default: null,
    },
    lastCleanupError: {
      type: String,
      trim: true,
      default: '',
      maxlength: 5000,
    },
  },
  { timestamps: true }
);

const BackupJob = mongoose.model('BackupJob', backupJobSchema);

module.exports = BackupJob;
