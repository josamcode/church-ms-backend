const express = require('express');
const router = express.Router();

const confessionsController = require('./confessions.controller');
const confessionsValidators = require('./confessions.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const { PERMISSIONS } = require('../../constants/permissions');

router.get(
  '/session-types',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.CONFESSIONS_VIEW),
  confessionsController.listSessionTypes
);

router.post(
  '/session-types',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.CONFESSIONS_SESSION_TYPES_MANAGE),
  validate(confessionsValidators.createSessionType),
  confessionsController.createSessionType
);

router.get(
  '/users/search',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.CONFESSIONS_ASSIGN_USER),
  validate(confessionsValidators.searchUsers),
  confessionsController.searchUsers
);

router.post(
  '/sessions',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.CONFESSIONS_CREATE),
  validate(confessionsValidators.createSession),
  confessionsController.createSession
);

router.get(
  '/sessions',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.CONFESSIONS_VIEW),
  validate(confessionsValidators.listSessions),
  confessionsController.listSessions
);

router.get(
  '/config',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.CONFESSIONS_ALERTS_VIEW),
  confessionsController.getAlertConfig
);

router.patch(
  '/config',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.CONFESSIONS_ALERTS_MANAGE),
  validate(confessionsValidators.updateAlertConfig),
  confessionsController.updateAlertConfig
);

router.get(
  '/alerts',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.CONFESSIONS_ALERTS_VIEW),
  validate(confessionsValidators.alertsQuery),
  confessionsController.getAlerts
);

router.get(
  '/analytics',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.CONFESSIONS_ANALYTICS_VIEW),
  validate(confessionsValidators.analyticsQuery),
  confessionsController.getAnalytics
);

module.exports = router;
