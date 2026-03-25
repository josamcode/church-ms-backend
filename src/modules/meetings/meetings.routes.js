const express = require('express');
const multer = require('multer');
const config = require('../../config/env');

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
const documentationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxDocumentationFileSize },
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

router.get(
  '/:id/documentation-settings',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_VIEW,
    PERMISSIONS.MEETINGS_VIEW_OWN,
    PERMISSIONS.MEETINGS_SETTINGS_MANAGE,
    PERMISSIONS.MEETINGS_DOCUMENTATION_MANAGE,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE
  ),
  validate(meetingsValidators.meetingDocumentationSettingsQuery),
  meetingsController.getMeetingDocumentationSettings
);

router.get(
  '/reminder-settings',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_TEMPLATES_MANAGE),
  meetingsController.listMeetingReminderSettings
);

router.put(
  '/:id/documentation-settings',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_VIEW,
    PERMISSIONS.MEETINGS_VIEW_OWN,
    PERMISSIONS.MEETINGS_SETTINGS_MANAGE,
    PERMISSIONS.MEETINGS_DOCUMENTATION_MANAGE,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE
  ),
  validate(meetingsValidators.updateMeetingDocumentationSettings),
  meetingsController.updateMeetingDocumentationSettings
);

router.post(
  '/documentation/upload-asset',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_DOCUMENTATION_MANAGE,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE
  ),
  uploadLimiter,
  documentationUpload.single('file'),
  validate(meetingsValidators.uploadMeetingDocumentationAsset),
  meetingsController.uploadMeetingDocumentationAsset
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
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_VIEW,
    PERMISSIONS.MEETINGS_VIEW_OWN,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE,
    PERMISSIONS.MEETINGS_COMMITTEES_MANAGE,
    PERMISSIONS.MEETINGS_ACTIVITIES_MANAGE
  ),
  validate(meetingsValidators.listMeetings),
  meetingsController.listMeetings
);

router.get(
  '/:id/members/:memberId',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_VIEW,
    PERMISSIONS.MEETINGS_VIEW_OWN,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE,
    PERMISSIONS.MEETINGS_COMMITTEES_MANAGE,
    PERMISSIONS.MEETINGS_ACTIVITIES_MANAGE,
    PERMISSIONS.MEETINGS_MEMBERS_VIEW
  ),
  validate(meetingsValidators.memberParams),
  meetingsController.getMeetingMemberById
);

router.patch(
  '/:id/members/:memberId/notes',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE,
    PERMISSIONS.MEETINGS_MEMBERS_NOTES_UPDATE
  ),
  validate(meetingsValidators.updateMeetingMemberNotes),
  meetingsController.updateMeetingMemberNotes
);

router.get(
  '/:id/attendance',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_ATTENDANCE_MANAGE,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE
  ),
  validate(meetingsValidators.meetingAttendanceQuery),
  meetingsController.getMeetingAttendance
);

router.put(
  '/:id/attendance',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_ATTENDANCE_MANAGE,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE
  ),
  validate(meetingsValidators.updateMeetingAttendance),
  meetingsController.updateMeetingAttendance
);

router.get(
  '/:id/documentation',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_DOCUMENTATION_MANAGE,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE
  ),
  validate(meetingsValidators.meetingDocumentationQuery),
  meetingsController.getMeetingDocumentation
);

router.put(
  '/:id/documentation',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_DOCUMENTATION_MANAGE,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE
  ),
  validate(meetingsValidators.updateMeetingDocumentation),
  meetingsController.updateMeetingDocumentation
);

router.get(
  '/:id',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_VIEW,
    PERMISSIONS.MEETINGS_VIEW_OWN,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE,
    PERMISSIONS.MEETINGS_COMMITTEES_MANAGE,
    PERMISSIONS.MEETINGS_ACTIVITIES_MANAGE
  ),
  validate(meetingsValidators.idParam),
  meetingsController.getMeetingById
);

router.patch(
  '/:id/reminder-settings',
  authenticateJWT,
  authorizeAnyPermissions(
    PERMISSIONS.MEETINGS_VIEW,
    PERMISSIONS.MEETINGS_VIEW_OWN,
    PERMISSIONS.MEETINGS_UPDATE,
    PERMISSIONS.MEETINGS_SERVANTS_MANAGE,
    PERMISSIONS.MEETINGS_COMMITTEES_MANAGE,
    PERMISSIONS.MEETINGS_ACTIVITIES_MANAGE,
    PERMISSIONS.NOTIFICATIONS_TEMPLATES_MANAGE
  ),
  validate(meetingsValidators.updateMeetingReminderSettings),
  meetingsController.updateMeetingReminderSettings
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
