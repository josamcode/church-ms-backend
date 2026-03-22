const cloudinary = require('cloudinary').v2;
const config = require('./env');
const logger = require('../utils/logger');

if (config.cloudinary.enabled) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
  });

  logger.info('Cloudinary configuration loaded');
} else {
  logger.warn('Cloudinary is disabled; upload endpoints will reject requests until it is configured');
}

module.exports = cloudinary;
