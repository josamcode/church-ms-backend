const mongoose = require('mongoose');

const avatarSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true },
    publicId: { type: String, trim: true },
  },
  { _id: false }
);

const sectorOfficialSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    title: {
      type: String,
      trim: true,
      maxlength: 160,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 500,
    },
  },
  { _id: true }
);

const sectorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
    },
    normalizedName: {
      type: String,
      required: true,
      select: false,
    },
    avatar: {
      type: avatarSchema,
      default: undefined,
    },
    officials: {
      type: [sectorOfficialSchema],
      default: [],
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

sectorSchema.pre('validate', function (next) {
  if (typeof this.name === 'string') {
    this.name = this.name.trim();
    this.normalizedName = this.name.toLowerCase();
  }
  next();
});

sectorSchema.index(
  { normalizedName: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: { $ne: true } },
  }
);
sectorSchema.index({ isDeleted: 1, name: 1 });

const Sector = mongoose.model('Sector', sectorSchema);

module.exports = Sector;
