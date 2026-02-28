const express = require('express');
const multer = require('multer');

const router = express.Router();
const notificationsController = require('./notifications.controller');
const notificationsValidators = require('./notifications.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizeAnyPermissions, authorizePermissions } = require('../../middlewares/permissions');
const { uploadLimiter } = require('../../middlewares/rateLimit');
const { PERMISSIONS } = require('../../constants/permissions');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get(
  '/types',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_VIEW),
  notificationsController.listNotificationTypes
);

router.post(
  '/types',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_TYPES_MANAGE),
  validate(notificationsValidators.createNotificationType),
  notificationsController.createNotificationType
);

router.post(
  '/upload-image',
  authenticateJWT,
  authorizeAnyPermissions(PERMISSIONS.NOTIFICATIONS_CREATE, PERMISSIONS.NOTIFICATIONS_UPDATE),
  uploadLimiter,
  upload.single('image'),
  notificationsController.uploadNotificationImage
);

router.get(
  '/',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_VIEW),
  validate(notificationsValidators.listNotifications),
  notificationsController.listNotifications
);

router.post(
  '/',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_CREATE),
  validate(notificationsValidators.createNotification),
  notificationsController.createNotification
);

router.get(
  '/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_VIEW),
  validate(notificationsValidators.idParam),
  notificationsController.getNotificationById
);

router.patch(
  '/:id',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_UPDATE),
  validate(notificationsValidators.updateNotification),
  notificationsController.updateNotification
);

module.exports = router;
