const mongoose = require('mongoose');

const normalizeType = (value) => String(value || '').trim().toLowerCase();

const userNotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 80,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },
    link: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

userNotificationSchema.pre('validate', function normalizeNotificationType(next) {
  if (this.type) {
    this.type = normalizeType(this.type);
  }
  next();
});

userNotificationSchema.index({ userId: 1, createdAt: -1, _id: -1 });
userNotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1, _id: -1 });

const UserNotification = mongoose.model('UserNotification', userNotificationSchema);

module.exports = UserNotification;
