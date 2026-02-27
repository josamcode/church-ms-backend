const mongoose = require('mongoose');

const divineLiturgyExceptionSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      index: true,
    },
    startTime: {
      type: String,
      required: true,
      trim: true,
    },
    endTime: {
      type: String,
      trim: true,
    },
    name: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    priestUserIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
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

divineLiturgyExceptionSchema.pre('validate', function (next) {
  if (typeof this.name === 'string') {
    this.name = this.name.trim();
    if (!this.name) this.name = undefined;
  }
  if (typeof this.endTime === 'string') {
    this.endTime = this.endTime.trim();
    if (!this.endTime) this.endTime = undefined;
  }
  next();
});

divineLiturgyExceptionSchema.index({ date: 1, startTime: 1 });

const DivineLiturgyException = mongoose.model(
  'DivineLiturgyException',
  divineLiturgyExceptionSchema
);

module.exports = DivineLiturgyException;
