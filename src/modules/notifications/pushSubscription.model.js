const mongoose = require('mongoose');

const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    endpoint: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
      unique: true,
    },
    keys: {
      p256dh: {
        type: String,
        required: true,
        trim: true,
        maxlength: 512,
      },
      auth: {
        type: String,
        required: true,
        trim: true,
        maxlength: 256,
      },
    },
    expirationTime: {
      type: Date,
      default: null,
    },
    userAgent: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

pushSubscriptionSchema.index({ userId: 1, createdAt: -1 });

const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);

module.exports = PushSubscription;
