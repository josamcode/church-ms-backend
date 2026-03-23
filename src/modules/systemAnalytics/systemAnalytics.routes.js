const express = require('express');

const router = express.Router();
const systemAnalyticsController = require('./systemAnalytics.controller');
const systemAnalyticsValidators = require('./systemAnalytics.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT, optionalAuth } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const { PERMISSIONS } = require('../../constants/permissions');

router.post(
  '/sessions/sync',
  optionalAuth,
  validate(systemAnalyticsValidators.syncSession),
  systemAnalyticsController.syncSession
);

router.get(
  '/overview',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.SYSTEM_ANALYTICS_VIEW),
  validate(systemAnalyticsValidators.overviewQuery),
  systemAnalyticsController.getOverview
);

module.exports = router;
