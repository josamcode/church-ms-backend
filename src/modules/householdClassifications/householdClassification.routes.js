const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../../middlewares/auth');
const {
  authorizeAnyPermissions,
  authorizePermissions,
} = require('../../middlewares/permissions');
const validate = require('../../middlewares/validate');
const { PERMISSIONS } = require('../../constants/permissions');
const householdClassificationController = require('./householdClassification.controller');
const householdClassificationValidators = require('./householdClassification.validators');

router.get(
  '/categories',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_VIEW),
  householdClassificationController.listCategories
);

router.post(
  '/categories',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_MANAGE),
  validate(householdClassificationValidators.createCategory),
  householdClassificationController.createCategory
);

router.patch(
  '/categories/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_MANAGE),
  validate(householdClassificationValidators.updateCategory),
  householdClassificationController.updateCategory
);

router.delete(
  '/categories/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_MANAGE),
  validate(householdClassificationValidators.idParam),
  householdClassificationController.deleteCategory
);

router.get(
  '/households',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_VIEW),
  validate(householdClassificationValidators.listHouseholds),
  householdClassificationController.listHouseholds
);

router.get(
  '/households/details',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_VIEW),
  validate(householdClassificationValidators.getHouseholdByName),
  householdClassificationController.getHouseholdByName
);

router.patch(
  '/households/details',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.USERS_UPDATE,
    PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_MANAGE
  ),
  validate(householdClassificationValidators.updateHousehold),
  householdClassificationController.updateHousehold
);

module.exports = router;
