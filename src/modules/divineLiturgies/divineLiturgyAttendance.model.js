const mongoose = require('mongoose');
const { SERVICE_TYPES } = require('./divineLiturgyRecurring.model');

const DIVINE_LITURGY_ATTENDANCE_ENTRY_TYPES = Object.freeze(['recurring', 'exception']);

const divineLiturgyAttendanceAuditEntrySchema = new mongoose.Schema(
  {
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    previousAttendedUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    attendedUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    action: {
      type: String,
      default: 'attendance_check_in_saved',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true, timestamps: false }
);

const divineLiturgyAttendanceSchema = new mongoose.Schema(
  {
    entryType: {
      type: String,
      enum: DIVINE_LITURGY_ATTENDANCE_ENTRY_TYPES,
      required: true,
      index: true,
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    serviceType: {
      type: String,
      enum: Object.values(SERVICE_TYPES),
      required: true,
      index: true,
    },
    attendanceDate: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    attendedUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    auditLog: {
      type: [divineLiturgyAttendanceAuditEntrySchema],
      default: [],
    },
  },
  { timestamps: true }
);

divineLiturgyAttendanceSchema.index(
  { entryType: 1, serviceId: 1, attendanceDate: 1 },
  { unique: true }
);
divineLiturgyAttendanceSchema.index({ 'auditLog.actorUserId': 1, 'auditLog.createdAt': -1 });

const DivineLiturgyAttendance = mongoose.model(
  'DivineLiturgyAttendance',
  divineLiturgyAttendanceSchema
);

module.exports = DivineLiturgyAttendance;
module.exports.DIVINE_LITURGY_ATTENDANCE_ENTRY_TYPES = DIVINE_LITURGY_ATTENDANCE_ENTRY_TYPES;
