const express = require('express');
const multer = require('multer');
const config = require('../../config/env');
const landingContentController = require('./landingContent.controller');
const landingContentValidators = require('./landingContent.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
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

router.get('/public', publicReadLimiter, landingContentController.getPublicContent);

router.get(
  '/manage',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.LANDING_CONTENT_MANAGE),
  landingContentController.getManageContent
);

router.put(
  '/manage',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.LANDING_CONTENT_MANAGE),
  validate(landingContentValidators.updateLandingContent),
  landingContentController.updateContent
);

router.post(
  '/hero-image',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.LANDING_CONTENT_MANAGE),
  uploadLimiter,
  upload.single('image'),
  landingContentController.uploadHeroImage
);

router.delete(
  '/hero-image',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.LANDING_CONTENT_MANAGE),
  landingContentController.deleteHeroImage
);

module.exports = router;
