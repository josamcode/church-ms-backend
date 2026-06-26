const express = require('express');
const multer = require('multer');
const config = require('../../config/env');
const archiveController = require('./archive.controller');
const archiveValidators = require('./archive.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizeAnyPermissions, authorizePermissions } = require('../../middlewares/permissions');
const { publicReadLimiter, uploadLimiter } = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.upload.maxFileSize,
    files: 1,
    fields: 8,
    parts: 10,
  },
});

const archiveWorkspacePermissions = [
  PERMISSIONS.ARCHIVE_VIEW,
  PERMISSIONS.ARCHIVE_UPLOAD,
  PERMISSIONS.ARCHIVE_COLLECTIONS_MANAGE,
  PERMISSIONS.ARCHIVE_STORIES_MANAGE,
  PERMISSIONS.ARCHIVE_HONOREES_MANAGE,
  PERMISSIONS.ARCHIVE_PUBLISH,
];

router.get('/public', publicReadLimiter, archiveController.getPublicContent);

router.get(
  '/manage',
  authenticateJWT,
  authorizeAnyPermissions(...archiveWorkspacePermissions),
  archiveController.getManageContent
);

router.post(
  '/upload-image',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_UPLOAD),
  uploadLimiter,
  upload.single('image'),
  archiveController.uploadArchiveImage
);

router.post(
  '/collections',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_COLLECTIONS_MANAGE),
  validate(archiveValidators.createCollection),
  archiveController.createCollection
);

router.patch(
  '/collections/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_COLLECTIONS_MANAGE),
  validate(archiveValidators.idParam),
  validate(archiveValidators.updateCollection),
  archiveController.updateCollection
);

router.delete(
  '/collections/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_COLLECTIONS_MANAGE),
  validate(archiveValidators.idParam),
  archiveController.deleteCollection
);

router.post(
  '/stories',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_STORIES_MANAGE),
  validate(archiveValidators.createStory),
  archiveController.createStory
);

router.patch(
  '/stories/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_STORIES_MANAGE),
  validate(archiveValidators.idParam),
  validate(archiveValidators.updateStory),
  archiveController.updateStory
);

router.delete(
  '/stories/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_STORIES_MANAGE),
  validate(archiveValidators.idParam),
  archiveController.deleteStory
);

router.post(
  '/honorees',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_HONOREES_MANAGE),
  validate(archiveValidators.createHonoree),
  archiveController.createHonoree
);

router.patch(
  '/honorees/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_HONOREES_MANAGE),
  validate(archiveValidators.idParam),
  validate(archiveValidators.updateHonoree),
  archiveController.updateHonoree
);

router.delete(
  '/honorees/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.ARCHIVE_HONOREES_MANAGE),
  validate(archiveValidators.idParam),
  archiveController.deleteHonoree
);

module.exports = router;
