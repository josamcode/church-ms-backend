const mongoose = require('mongoose');
const {
  AUDIT_OUTCOME_VALUES,
  AUDIT_RETENTION_DAYS,
} = require('./audit.constants');

/**
 * Central audit log.
 *
 * Deliberately a standalone collection, NOT an embedded array. The existing
 * embedded audit arrays (`meeting.model.js`, `divineLiturgyAttendance.model.js`)
 * grow without bound inside their parent document and will eventually hit the
 * 16 MB BSON limit; that pattern must not be repeated.
 *
 * The collection stores WHO did WHAT to WHICH record — never the record's
 * contents. `resourceIds` holds identifiers only, and `metadata` is passed
 * through a sanitizer before it is written.
 */
const auditLogSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      index: true,
    },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    actorRole: {
      type: String,
      trim: true,
      maxlength: 40,
      default: null,
    },
    // Correlates an audit entry with the application logs for the same request.
    requestId: {
      type: String,
      trim: true,
      maxlength: 128,
      default: null,
      index: true,
    },
    outcome: {
      type: String,
      enum: AUDIT_OUTCOME_VALUES,
      required: true,
      index: true,
    },
    resource: {
      type: String,
      trim: true,
      maxlength: 80,
      default: null,
    },
    resourceIds: [
      {
        type: String,
        trim: true,
        maxlength: 128,
      },
    ],
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    ip: {
      type: String,
      trim: true,
      maxlength: 64,
      default: null,
    },
    userAgent: {
      type: String,
      trim: true,
      maxlength: 256,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      // No inline `index: true` here. It would generate a plain `createdAt_1`
      // index that collides by name with the TTL index declared below; Mongo
      // rejects the second declaration and the TTL is silently never created,
      // so nothing would ever expire.
    },
  },
  // `createdAt` is managed explicitly so the TTL index has a single owner.
  { timestamps: false }
);

// Common investigation queries: "what did this actor do", "what happened to
// this event type", both newest-first.
auditLogSchema.index({ actorUserId: 1, createdAt: -1 });
auditLogSchema.index({ eventType: 1, createdAt: -1 });

// TTL — MongoDB removes documents older than the retention window.
auditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: AUDIT_RETENTION_DAYS * 24 * 60 * 60 }
);

// Guarded registration: this model is reached transitively from the
// authorization middleware, so a test that calls `jest.resetModules()` can
// re-require it within one mongoose instance and hit OverwriteModelError.
const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
