const mongoose = require('mongoose');

const notificationReadSchema = new mongoose.Schema(
  {
    notificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notification',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    readAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

// Each user can only read a notification once
notificationReadSchema.index({ notificationId: 1, userId: 1 }, { unique: true });

const NotificationRead = mongoose.model('NotificationRead', notificationReadSchema);

module.exports = NotificationRead;
