const express = require('express');
const router = express.Router();
const settingsController = require('./settings.controller');
const settingsValidators = require('./settings.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const { publicReadLimiter } = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');

// ═══════ عام (بدون مصادقة) ═══════

router.get('/public/site', publicReadLimiter, settingsController.getPublicSite);

router.get(
  '/platform',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_TEMPLATES_MANAGE),
  settingsController.getPlatformSettings
);

router.patch(
  '/platform',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_TEMPLATES_MANAGE),
  validate(settingsValidators.updatePlatformSettings),
  settingsController.updatePlatformSettings
);

module.exports = router;
