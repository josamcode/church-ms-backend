const mongoose = require('mongoose');

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

const householdProfileSchema = new mongoose.Schema(
  {
    householdKey: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    houseName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 160,
    },
    normalizedHouseName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    manualPrimaryClassificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HouseholdClassification',
      default: null,
    },
    financial: {
      incomeSources: {
        type: [{ type: String, trim: true }],
        default: [],
      },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

householdProfileSchema.pre('validate', function syncHouseholdKeys(next) {
  const normalizedHouseName = normalizeText(this.houseName);
  if (!normalizedHouseName) {
    return next(new Error('House name is required.'));
  }

  this.normalizedHouseName = normalizedHouseName;
  this.householdKey = `house:${normalizedHouseName}`;
  next();
});

householdProfileSchema.index({ householdKey: 1 }, { unique: true });
householdProfileSchema.index({ normalizedHouseName: 1 });

module.exports = mongoose.model('HouseholdProfile', householdProfileSchema);
