const mongoose = require('mongoose');

const DEFAULT_SESSION_TYPES = [
  { name: 'Follow-up session', order: 1 },
  { name: 'Counseling session', order: 2 },
  { name: 'Full confession', order: 3 },
  { name: 'Short prayer', order: 4 },
];

const confessionSessionTypeSchema = new mongoose.Schema(
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
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

confessionSessionTypeSchema.pre('validate', function (next) {
  if (typeof this.name === 'string') {
    this.name = this.name.trim();
    this.normalizedName = this.name.toLowerCase();
  }
  next();
});

confessionSessionTypeSchema.index({ order: 1, name: 1 });

const ConfessionSessionType = mongoose.model('ConfessionSessionType', confessionSessionTypeSchema);

async function seedDefaultSessionTypes() {
  for (const { name, order } of DEFAULT_SESSION_TYPES) {
    const normalizedName = name.toLowerCase();
    const exists = await ConfessionSessionType.findOne({ normalizedName }).lean();
    if (!exists) {
      await ConfessionSessionType.create({
        name,
        normalizedName,
        isDefault: true,
        order,
      });
    }
  }
}

module.exports = ConfessionSessionType;
module.exports.seedDefaultSessionTypes = seedDefaultSessionTypes;
module.exports.DEFAULT_SESSION_TYPES = DEFAULT_SESSION_TYPES;
