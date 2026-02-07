const express = require('express');
const router = express.Router();
const authController = require('./auth.controller');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const validate = require('../../middlewares/validate');
const authValidators = require('./auth.validators');
const { authLimiter } = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');

// ═══════ عام (بدون مصادقة) ═══════

router.post(
  '/register',
  authLimiter,
  validate(authValidators.register),
  authController.register
);

router.post(
  '/login',
  authLimiter,
  validate(authValidators.login),
  authController.login
);

router.post(
  '/refresh',
  validate(authValidators.refreshToken),
  authController.refresh
);

// ═══════ يتطلب مصادقة ═══════

router.post(
  '/logout',
  authenticateJWT,
  validate(authValidators.logout),
  authController.logout
);

router.get(
  '/me',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.AUTH_VIEW_SELF),
  authController.getMe
);

router.post(
  '/change-password',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.AUTH_CHANGE_PASSWORD),
  validate(authValidators.changePassword),
  authController.changePassword
);

module.exports = router;
