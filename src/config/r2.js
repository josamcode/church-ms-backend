const { S3Client } = require('@aws-sdk/client-s3');
const config = require('./env');
const logger = require('../utils/logger');

let client = null;

if (config.r2.enabled) {
  client = new S3Client({
    region: config.r2.region,
    endpoint: config.r2.endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });

  logger.info('R2 storage configuration loaded');
} else {
  logger.warn('R2 storage is disabled; upload endpoints will reject requests until it is configured');
}

module.exports = {
  client,
  enabled: config.r2.enabled,
};
