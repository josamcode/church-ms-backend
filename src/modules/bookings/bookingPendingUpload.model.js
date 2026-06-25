const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Pending image upload created via POST /api/bookings/public/upload-image.
 *
 * Exists BEFORE the booking is created.  When the booking is submitted the
 * uploaded images must reference an unconsumed, unexpired record that matches
 * the same booking type and field key.
 *
 * Expiry:  default 30 minutes.  Cleanup helper deletes expired storage objects
 *          then removes the DB record.
 */

const DEFAULT_UPLOAD_EXPIRY_MINUTES = 30;

function generateUploadToken() {
  return crypto.randomBytes(24).toString('base64url');
}

const bookingPendingUploadSchema = new mongoose.Schema(
  {
    uploadToken: {
      type: String,
      required: true,
      unique: true,
      default: generateUploadToken,
    },
    bookingTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BookingType',
      required: true,
      index: true,
    },
    fieldKey: {
      type: String,
      required: true,
      trim: true,
    },
    storageKey: {
      type: String,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    mimeType: {
      type: String,
      default: '',
    },
    size: {
      type: Number,
      default: 0,
    },
    originalName: {
      type: String,
      default: '',
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
  },
  { timestamps: true }
);

bookingPendingUploadSchema.index({ storageKey: 1 });
bookingPendingUploadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ── Instance helpers ──

bookingPendingUploadSchema.methods.isExpired = function () {
  return new Date() > this.expiresAt;
};

bookingPendingUploadSchema.methods.isConsumed = function () {
  return this.consumedAt !== null;
};

bookingPendingUploadSchema.methods.markConsumed = function (bookingId) {
  this.consumedAt = new Date();
  this.bookingId = bookingId;
};

// ── Static helpers ──

bookingPendingUploadSchema.statics.DEFAULT_UPLOAD_EXPIRY_MINUTES = DEFAULT_UPLOAD_EXPIRY_MINUTES;

const BookingPendingUpload = mongoose.model('BookingPendingUpload', bookingPendingUploadSchema);

module.exports = BookingPendingUpload;
