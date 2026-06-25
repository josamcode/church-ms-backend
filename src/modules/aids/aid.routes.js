const express = require('express');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const validate = require('../../middlewares/validate');
const { PERMISSIONS } = require('../../constants/permissions');
const aidController = require('./aid.controller');
const aidValidators = require('./aid.validators');

const router = express.Router();

router.use(authenticateJWT);

router.post(
  '/bulk',
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_MANAGE),
  validate(aidValidators.createBulkAidsBody),
  aidController.createBulkAids
);

router.get(
  '/options',
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_VIEW),
  aidController.getAidOptions
);

router.get(
  '/',
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_VIEW),
  validate(aidValidators.getDisbursedAidsQuery),
  aidController.getDisbursedAids
);

router.get(
  '/details',
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_VIEW),
  validate(aidValidators.getAidDetailsQuery),
  aidController.getAidDetails
);

router.post(
  '/history/search',
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_VIEW),
  validate(aidValidators.searchAidHistoryBody),
  aidController.searchAidHistory
);

router.post(
  '/reminders/:id/approve',
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_MANAGE),
  validate(aidValidators.approveAidReminderParams),
  aidController.approveAidReminder
);

router.put(
  '/',
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_MANAGE),
  validate(aidValidators.updateFullAidGroupBody),
  aidController.updateFullAidGroup
);

module.exports = router;
