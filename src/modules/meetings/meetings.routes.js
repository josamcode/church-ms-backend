const express = require('express');
const multer = require('multer');

const router = express.Router();
const meetingsController = require('./meetings.controller');
const meetingsValidators = require('./meetings.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizeAnyPermissions, authorizePermissions } = require('../../middlewares/permissions');
const { uploadLimiter } = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post(
  '/sectors',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.SECTORS_CREATE),
  validate(meetingsValidators.createSector),
  meetingsController.createSector
);

router.get(
  '/sectors',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.SECTORS_VIEW),
  validate(meetingsValidators.listSectors),
  meetingsController.listSectors
);

router.post(
  '/sectors/upload-avatar',
  authenticateJWT,
  authorizeAnyPermissions(PERMISSIONS.SECTORS_CREATE, PERMISSIONS.SECTORS_UPDATE),
  uploadLimiter,
  upload.single('avatar'),
  meetingsController.uploadSectorAvatarImage
);

router.get(
  '/sectors/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.SECTORS_VIEW),
  validate(meetingsValidators.idParam),
  meetingsController.getSectorById
);

router.patch(
  '/sectors/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.SECTORS_UPDATE),
  validate(meetingsValidators.updateSector),
  meetingsController.updateSector
);

router.delete(
  '/sectors/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.SECTORS_DELETE),
  validate(meetingsValidators.idParam),
  meetingsController.deleteSector
);

router.get(
  '/responsibilities',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_RESPONSIBILITIES_VIEW),
  validate(meetingsValidators.responsibilitySuggestions),
  meetingsController.listResponsibilitySuggestions
);

router.get(
  '/servants/history',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_SERVANT_HISTORY_VIEW),
  validate(meetingsValidators.servantHistory),
  meetingsController.getServantHistory
);

router.post(
  '/upload-avatar',
  authenticateJWT,
  authorizeAnyPermissions(PERMISSIONS.MEETINGS_CREATE, PERMISSIONS.MEETINGS_UPDATE),
  uploadLimiter,
  upload.single('avatar'),
  meetingsController.uploadMeetingAvatarImage
);

router.post(
  '/',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_CREATE),
  validate(meetingsValidators.createMeeting),
  meetingsController.createMeeting
);

router.get(
  '/',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_VIEW),
  validate(meetingsValidators.listMeetings),
  meetingsController.listMeetings
);

router.get(
  '/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_VIEW),
  validate(meetingsValidators.idParam),
  meetingsController.getMeetingById
);

router.patch(
  '/:id/basic',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_UPDATE),
  validate(meetingsValidators.updateMeetingBasic),
  meetingsController.updateMeetingBasic
);

router.patch(
  '/:id/servants',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_SERVANTS_MANAGE),
  validate(meetingsValidators.updateMeetingServants),
  meetingsController.updateMeetingServants
);

router.patch(
  '/:id/committees',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_COMMITTEES_MANAGE),
  validate(meetingsValidators.updateMeetingCommittees),
  meetingsController.updateMeetingCommittees
);

router.patch(
  '/:id/activities',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_ACTIVITIES_MANAGE),
  validate(meetingsValidators.updateMeetingActivities),
  meetingsController.updateMeetingActivities
);

router.delete(
  '/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_DELETE),
  validate(meetingsValidators.idParam),
  meetingsController.deleteMeeting
);

module.exports = router;
