const mongoose = require('mongoose');

const notificationDetailSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['text', 'link', 'image'],
      required: true,
    },
    title: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    content: {
      type: String,
      trim: true,
      maxlength: 5000,
      required() {
        return this.kind === 'text';
      },
    },
    url: {
      type: String,
      trim: true,
      maxlength: 2000,
      required() {
        return this.kind === 'link' || this.kind === 'image';
      },
    },
  },
  { _id: true, timestamps: false }
);

const notificationSchema = new mongoose.Schema(
  {
    typeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NotificationType',
      required: true,
      index: true,
    },
    typeNameSnapshot: {
      type: String,
      trim: true,
      required: true,
      maxlength: 120,
    },
    name: {
      type: String,
      trim: true,
      required: true,
      maxlength: 200,
    },
    summary: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    details: {
      type: [notificationDetailSchema],
      default: [],
    },
    eventDate: {
      type: Date,
      index: true,
    },
    coverImageUrl: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
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
  },
  { timestamps: true }
);

notificationSchema.index({ createdAt: -1, _id: -1 });
notificationSchema.index({ typeId: 1, createdAt: -1 });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;
