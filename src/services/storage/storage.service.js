const { DeleteObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const config = require('../../config/env');
const r2 = require('../../config/r2');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { createObjectKey } = require('./storage.keys');

const ensureStorageConfigured = () => {
  if (!config.r2.enabled || !r2.client) {
    throw ApiError.serviceUnavailable('File uploads are not configured', 'UPLOADS_UNAVAILABLE');
  }
};

const buildPublicUrl = (storageKey) =>
  `${config.r2.publicBaseUrl.replace(/\/+$/, '')}/${String(storageKey || '').replace(/^\/+/, '')}`;

const toMetadataValue = (value) => String(value || '').slice(0, 1024);

const uploadFile = async (
  file,
  { prefix, key, fileDetails = {}, metadata = {}, failureMessage = 'Failed to upload file' } = {}
) => {
  ensureStorageConfigured();

  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw ApiError.badRequest('Please choose a file', 'UPLOAD_FAILED');
  }

  const mimeType = fileDetails.mimeType || file.mimetype || 'application/octet-stream';
  const originalName = fileDetails.originalName || file.originalname || '';
  const size = Number(fileDetails.size || file.size || file.buffer.length || 0);
  const storageKey = key || createObjectKey({ prefix, originalName, mimeType });

  try {
    await r2.client.send(
      new PutObjectCommand({
        Bucket: config.r2.bucketName,
        Key: storageKey,
        Body: file.buffer,
        ContentType: mimeType,
        ContentLength: size,
        Metadata: Object.fromEntries(
          Object.entries({
            originalName,
            kind: fileDetails.kind,
            ...metadata,
          })
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([metaKey, value]) => [metaKey, toMetadataValue(value)])
        ),
      })
    );
  } catch (error) {
    logger.error(`R2 upload error for ${storageKey}: ${error.message}`);
    throw ApiError.internal(failureMessage);
  }

  return {
    url: buildPublicUrl(storageKey),
    storageKey,
    provider: 'r2',
    bucket: config.r2.bucketName,
    mimeType,
    size,
    originalName,
    kind: fileDetails.kind,
  };
};

const deleteFile = async (storageKey) => {
  const key = String(storageKey || '').trim();
  if (!key) return;
  ensureStorageConfigured();

  try {
    await r2.client.send(
      new DeleteObjectCommand({
        Bucket: config.r2.bucketName,
        Key: key,
      })
    );
  } catch (error) {
    logger.warn(`R2 delete failed for ${key}: ${error.message}`);
  }
};

const deleteFiles = async (storageKeys = []) => {
  const uniqueKeys = [...new Set((storageKeys || []).map((key) => String(key || '').trim()).filter(Boolean))];
  if (!uniqueKeys.length) return;

  await Promise.allSettled(uniqueKeys.map((storageKey) => deleteFile(storageKey)));
};

module.exports = {
  buildPublicUrl,
  deleteFile,
  deleteFiles,
  uploadFile,
};
