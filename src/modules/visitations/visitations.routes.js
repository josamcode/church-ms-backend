const express = require('express');

const router = express.Router();
const visitationsController = require('./visitations.controller');
const visitationsValidators = require('./visitations.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const { PERMISSIONS } = require('../../constants/permissions');

router.post(
  '/',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.PASTORAL_VISITATIONS_CREATE),
  validate(visitationsValidators.createVisitation),
  visitationsController.createVisitation
);

router.get(
  '/',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.PASTORAL_VISITATIONS_VIEW),
  validate(visitationsValidators.listVisitations),
  visitationsController.listVisitations
);

router.get(
  '/analytics',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.PASTORAL_VISITATIONS_ANALYTICS_VIEW),
  validate(visitationsValidators.analyticsQuery),
  visitationsController.getAnalytics
);

router.get(
  '/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.PASTORAL_VISITATIONS_VIEW),
  validate(visitationsValidators.idParam),
  visitationsController.getVisitationById
);

module.exports = router;
