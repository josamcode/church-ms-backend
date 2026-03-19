const express = require('express');
const multer = require('multer');
const landingContentController = require('./landingContent.controller');
const landingContentValidators = require('./landingContent.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const { uploadLimiter } = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/public', landingContentController.getPublicContent);

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
