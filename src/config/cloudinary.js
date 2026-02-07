const cloudinary = require('cloudinary').v2;
const config = require('./env');
const logger = require('../utils/logger');

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
});

logger.info('Cloudinary تم تهيئة إعدادات');

module.exports = cloudinary;
