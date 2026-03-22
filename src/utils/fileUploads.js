const path = require('path');
const streamifier = require('streamifier');
const cloudinary = require('../config/cloudinary');
const config = require('../config/env');
const ApiError = require('./ApiError');
const logger = require('./logger');

const FILE_SIGNATURES = [
  {
    kind: 'image',
    mimeType: 'image/jpeg',
    matches: (buffer) =>
      buffer?.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff,
  },
  {
    kind: 'image',
    mimeType: 'image/png',
    matches: (buffer) =>
      buffer?.length >= 8 &&
      buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    kind: 'image',
    mimeType: 'image/gif',
    matches: (buffer) =>
      buffer?.length >= 6 &&
      (buffer.slice(0, 6).equals(Buffer.from('GIF87a')) ||
        buffer.slice(0, 6).equals(Buffer.from('GIF89a'))),
  },
  {
    kind: 'image',
    mimeType: 'image/webp',
    matches: (buffer) =>
      buffer?.length >= 12 &&
      buffer.slice(0, 4).equals(Buffer.from('RIFF')) &&
      buffer.slice(8, 12).equals(Buffer.from('WEBP')),
  },
  {
    kind: 'document',
    mimeType: 'application/pdf',
    matches: (buffer) => buffer?.length >= 5 && buffer.slice(0, 5).equals(Buffer.from('%PDF-')),
  },
  {
    kind: 'document',
    mimeType: 'application/msword',
    matches: (buffer) =>
      buffer?.length >= 8 &&
      buffer.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  },
  {
    kind: 'document',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    matches: (buffer, extension) =>
      extension === '.docx' &&
      buffer?.length >= 4 &&
      (buffer.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
        buffer.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
        buffer.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]))),
  },
  {
    kind: 'video',
    mimeType: 'video/mp4',
    matches: (buffer) =>
      buffer?.length >= 12 &&
      buffer.slice(4, 8).equals(Buffer.from('ftyp')) &&
      ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'MSNV'].includes(
        buffer.slice(8, 12).toString('ascii')
      ),
  },
  {
    kind: 'video',
    mimeType: 'video/quicktime',
    matches: (buffer) =>
      buffer?.length >= 12 &&
      buffer.slice(4, 8).equals(Buffer.from('ftyp')) &&
      buffer.slice(8, 12).toString('ascii') === 'qt  ',
  },
  {
    kind: 'video',
    mimeType: 'video/webm',
    matches: (buffer) =>
      buffer?.length >= 4 &&
      buffer.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  },
];

const normalizeMimeType = (value) => String(value || '').trim().toLowerCase();

const getFileExtension = (fileName = '') => {
  const extension = path.extname(String(fileName || '')).trim().toLowerCase();
  return extension || '';
};

const isLikelyPlainText = (buffer) => {
  if (!buffer?.length) return false;

  const sample = buffer.slice(0, Math.min(buffer.length, 2048));
  if (sample.includes(0x00)) {
    return false;
  }

  let printableBytes = 0;
  for (const byte of sample) {
    const isLineBreak = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
    const isUtf8LeadByte = byte >= 0xc2;

    if (isLineBreak || isPrintableAscii || isUtf8LeadByte) {
      printableBytes += 1;
    }
  }

  return printableBytes / sample.length > 0.9;
};

const detectFileDetails = (file) => {
  const extension = getFileExtension(file?.originalname);

  for (const signature of FILE_SIGNATURES) {
    if (signature.matches(file?.buffer, extension)) {
      return signature;
    }
  }

  if (extension === '.txt' && isLikelyPlainText(file?.buffer)) {
    return {
      kind: 'document',
      mimeType: 'text/plain',
    };
  }

  return null;
};

const assertFileProvided = (file, label = 'file') => {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw ApiError.badRequest(`Please choose a ${label}`, 'UPLOAD_FAILED');
  }
};

const validateUpload = (
  file,
  {
    allowedMimeTypes = [],
    allowedKinds = [],
    maxBytes = config.upload.maxFileSize,
    emptyLabel = 'file',
    invalidTypeMessage = 'The selected file type is not allowed',
  } = {}
) => {
  assertFileProvided(file, emptyLabel);

  if (Number(file.size || 0) > Number(maxBytes || 0)) {
    throw ApiError.badRequest(
      `File exceeds size limit (${Math.round(Number(maxBytes || 0) / 1024 / 1024)} MB)`,
      'UPLOAD_FILE_TOO_LARGE'
    );
  }

  const detected = detectFileDetails(file);
  if (!detected) {
    throw ApiError.badRequest(invalidTypeMessage, 'UPLOAD_INVALID_TYPE');
  }

  if (allowedKinds.length > 0 && !allowedKinds.includes(detected.kind)) {
    throw ApiError.badRequest(invalidTypeMessage, 'UPLOAD_INVALID_TYPE');
  }

  if (allowedMimeTypes.length > 0 && !allowedMimeTypes.includes(detected.mimeType)) {
    throw ApiError.badRequest(invalidTypeMessage, 'UPLOAD_INVALID_TYPE');
  }

  const reportedMimeType = normalizeMimeType(file.mimetype);
  if (reportedMimeType && reportedMimeType !== detected.mimeType) {
    throw ApiError.badRequest(
      'The uploaded file content does not match the reported file type',
      'UPLOAD_INVALID_TYPE'
    );
  }

  return {
    kind: detected.kind,
    mimeType: detected.mimeType,
    originalName: String(file.originalname || '').trim(),
    size: Number(file.size || 0),
  };
};

const validateImageUpload = (file, options = {}) =>
  validateUpload(file, {
    allowedKinds: ['image'],
    allowedMimeTypes: config.upload.allowedImageTypes,
    maxBytes: config.upload.maxFileSize,
    emptyLabel: 'image',
    invalidTypeMessage: 'Unsupported image type. Allowed: JPEG, PNG, GIF, WEBP',
    ...options,
  });

const validateDocumentationUpload = (file, options = {}) =>
  validateUpload(file, {
    allowedKinds: ['image', 'video', 'document'],
    allowedMimeTypes: [
      ...config.upload.allowedImageTypes,
      ...(config.upload.allowedVideoTypes || []),
      ...(config.upload.allowedDocumentTypes || []),
    ],
    maxBytes: config.upload.maxDocumentationFileSize,
    emptyLabel: 'file',
    invalidTypeMessage:
      'Unsupported file type. Allowed: images, PDF, DOC, DOCX, TXT, MP4, MOV, WEBM',
    ...options,
  });

const uploadBufferToCloudinary = (file, options = {}, failureMessage = 'Failed to upload file') => {
  if (!config.cloudinary.enabled) {
    throw ApiError.serviceUnavailable('File uploads are not configured', 'UPLOADS_UNAVAILABLE');
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) {
        logger.error(`Cloudinary upload error: ${error.message}`);
        reject(ApiError.internal(failureMessage));
        return;
      }

      resolve(result);
    });

    streamifier.createReadStream(file.buffer).pipe(uploadStream);
  });
};

module.exports = {
  detectFileDetails,
  getFileExtension,
  uploadBufferToCloudinary,
  validateDocumentationUpload,
  validateImageUpload,
  validateUpload,
};
