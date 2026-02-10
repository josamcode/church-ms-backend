const mongoose = require('mongoose');

const confessionConfigSchema = new mongoose.Schema(
  {
    singletonKey: {
      type: String,
      default: 'main',
      unique: true,
      index: true,
    },
    alertThresholdDays: {
      type: Number,
      default: 40,
      min: 1,
      max: 3650,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const ConfessionConfig = mongoose.model('ConfessionConfig', confessionConfigSchema);

async function getOrCreateConfessionConfig() {
  let config = await ConfessionConfig.findOne({ singletonKey: 'main' });
  if (!config) {
    config = await ConfessionConfig.create({
      singletonKey: 'main',
      alertThresholdDays: 40,
    });
  }
  return config;
}

module.exports = ConfessionConfig;
module.exports.getOrCreateConfessionConfig = getOrCreateConfessionConfig;
