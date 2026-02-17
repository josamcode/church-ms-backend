const mongoose = require('mongoose');

const pastoralVisitationSchema = new mongoose.Schema(
  {
    houseName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 160,
      index: true,
    },
    normalizedHouseName: {
      type: String,
      required: true,
      select: false,
      index: true,
    },
    durationMinutes: {
      type: Number,
      default: 10,
      min: 1,
      max: 720,
    },
    visitedAt: {
      type: Date,
      required: true,
      index: true,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

pastoralVisitationSchema.pre('validate', function (next) {
  if (typeof this.houseName === 'string') {
    this.houseName = this.houseName.trim();
    this.normalizedHouseName = this.houseName.toLowerCase();
  }
  next();
});

pastoralVisitationSchema.index({ visitedAt: -1, _id: -1 });
pastoralVisitationSchema.index({ recordedBy: 1, visitedAt: -1 });

const PastoralVisitation = mongoose.model('PastoralVisitation', pastoralVisitationSchema);

module.exports = PastoralVisitation;
