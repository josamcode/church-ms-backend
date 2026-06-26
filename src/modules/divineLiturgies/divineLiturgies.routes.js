const express = require('express');

const router = express.Router();
const divineLiturgiesController = require('./divineLiturgies.controller');
const divineLiturgiesValidators = require('./divineLiturgies.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizeAnyPermissions, authorizePermissions } = require('../../middlewares/permissions');
const { publicReadLimiter } = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');

router.get('/public', publicReadLimiter, divineLiturgiesController.getPublicOverview);

router.get(
  '/',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.DIVINE_LITURGIES_VIEW,
    PERMISSIONS.DIVINE_LITURGIES_MANAGE,
    PERMISSIONS.DIVINE_LITURGIES_ATTENDANCE_MANAGE,
    PERMISSIONS.DIVINE_LITURGIES_ATTENDANCE_MANAGE_ASSIGNED_USERS
  ),
  divineLiturgiesController.getOverview
);

router.get(
  '/attendance/:entryType/:id/context',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.DIVINE_LITURGIES_ATTENDANCE_MANAGE,
    PERMISSIONS.DIVINE_LITURGIES_MANAGE,
    PERMISSIONS.DIVINE_LITURGIES_ATTENDANCE_MANAGE_ASSIGNED_USERS
  ),
  validate(divineLiturgiesValidators.attendanceParams),
  divineLiturgiesController.getAttendanceContext
);

router.get(
  '/attendance/:entryType/:id',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.DIVINE_LITURGIES_ATTENDANCE_MANAGE,
    PERMISSIONS.DIVINE_LITURGIES_MANAGE,
    PERMISSIONS.DIVINE_LITURGIES_ATTENDANCE_MANAGE_ASSIGNED_USERS
  ),
  validate(divineLiturgiesValidators.attendanceQuery),
  divineLiturgiesController.getAttendance
);

router.put(
  '/attendance/:entryType/:id',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.DIVINE_LITURGIES_ATTENDANCE_MANAGE,
    PERMISSIONS.DIVINE_LITURGIES_MANAGE,
    PERMISSIONS.DIVINE_LITURGIES_ATTENDANCE_MANAGE_ASSIGNED_USERS
  ),
  validate(divineLiturgiesValidators.updateAttendance),
  divineLiturgiesController.updateAttendance
);

router.post(
  '/recurring',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.DIVINE_LITURGIES_MANAGE),
  validate(divineLiturgiesValidators.createRecurring),
  divineLiturgiesController.createRecurring
);

router.patch(
  '/recurring/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.DIVINE_LITURGIES_MANAGE),
  validate(divineLiturgiesValidators.updateRecurring),
  divineLiturgiesController.updateRecurring
);

router.delete(
  '/recurring/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.DIVINE_LITURGIES_MANAGE),
  validate(divineLiturgiesValidators.idParam),
  divineLiturgiesController.deleteRecurring
);

router.post(
  '/exceptions',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.DIVINE_LITURGIES_MANAGE),
  validate(divineLiturgiesValidators.createException),
  divineLiturgiesController.createException
);

router.patch(
  '/exceptions/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.DIVINE_LITURGIES_MANAGE),
  validate(divineLiturgiesValidators.updateException),
  divineLiturgiesController.updateException
);

router.delete(
  '/exceptions/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.DIVINE_LITURGIES_MANAGE),
  validate(divineLiturgiesValidators.idParam),
  divineLiturgiesController.deleteException
);

router.put(
  '/priests',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.DIVINE_LITURGIES_PRIESTS_MANAGE),
  validate(divineLiturgiesValidators.setChurchPriests),
  divineLiturgiesController.setChurchPriests
);

module.exports = router;
