const mongoose = require('mongoose');

const DEFAULT_NOTIFICATION_TYPES = [
  { name: 'General Announcement', order: 1 },
  { name: 'Event', order: 2 },
  { name: 'Congratulations', order: 3 },
];

const notificationTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    normalizedName: {
      type: String,
      required: true,
      unique: true,
      select: false,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    order: {
      type: Number,
      default: 99,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

notificationTypeSchema.pre('validate', function (next) {
  if (typeof this.name === 'string') {
    this.name = this.name.trim();
    this.normalizedName = this.name.toLowerCase();
  }
  next();
});

notificationTypeSchema.index({ order: 1, name: 1 });

const NotificationType = mongoose.model('NotificationType', notificationTypeSchema);

async function seedDefaultNotificationTypes() {
  for (const { name, order } of DEFAULT_NOTIFICATION_TYPES) {
    const normalizedName = name.toLowerCase();
    const exists = await NotificationType.findOne({ normalizedName }).lean();
    if (!exists) {
      await NotificationType.create({
        name,
        normalizedName,
        isDefault: true,
        order,
      });
    }
  }
}

module.exports = NotificationType;
module.exports.DEFAULT_NOTIFICATION_TYPES = DEFAULT_NOTIFICATION_TYPES;
module.exports.seedDefaultNotificationTypes = seedDefaultNotificationTypes;
