const express = require('express');
const router = express.Router();
const authController = require('./auth.controller');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const validate = require('../../middlewares/validate');
const authValidators = require('./auth.validators');
const {
  authLoginLimiter,
  authSessionLimiter,
  passwordLimiter,
  publicReadLimiter,
  registerLimiter,
} = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');

// ═══════ عام (بدون مصادقة) ═══════

router.post(
  '/register',
  registerLimiter,
  validate(authValidators.register),
  authController.register
);

router.get(
  '/register/options',
  publicReadLimiter,
  authController.getRegistrationOptions
);

router.post(
  '/login',
  authLoginLimiter,
  validate(authValidators.login),
  authController.login
);

router.post(
  '/refresh',
  authSessionLimiter,
  validate(authValidators.refreshToken),
  authController.refresh
);

// ═══════ يتطلب مصادقة ═══════

router.post(
  '/logout',
  authSessionLimiter,
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

router.patch(
  '/me/settings',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.AUTH_VIEW_SELF),
  validate(authValidators.updateMySettings),
  authController.updateMySettings
);

router.post(
  '/change-password',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.AUTH_CHANGE_PASSWORD),
  passwordLimiter,
  validate(authValidators.changePassword),
  authController.changePassword
);

module.exports = router;
