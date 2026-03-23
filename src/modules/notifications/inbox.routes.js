const express = require('express');
const { authenticateJWT } = require('../../middlewares/auth');
const { authorizePermissions } = require('../../middlewares/permissions');
const validate = require('../../middlewares/validate');
const { PERMISSIONS } = require('../../constants/permissions');
const inboxController = require('./inbox.controller');
const inboxValidators = require('./inbox.validators');

const router = express.Router();

router.get(
  '/',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_VIEW),
  validate(inboxValidators.listNotifications),
  inboxController.listNotifications
);

router.get(
  '/unread-count',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_VIEW),
  inboxController.getUnreadCount
);

router.patch(
  '/read-all',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_VIEW),
  inboxController.markAllAsRead
);

router.patch(
  '/threads/:threadId/read',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_VIEW),
  validate(inboxValidators.markThreadRead),
  inboxController.markThreadAsRead
);

router.patch(
  '/:id/read',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_VIEW),
  validate(inboxValidators.markRead),
  inboxController.markAsRead
);

router.post(
  '/system',
  authenticateJWT,
  authorizePermissions(PERMISSIONS.NOTIFICATIONS_CREATE),
  validate(inboxValidators.sendSystemNotification),
  inboxController.sendSystemNotification
);

module.exports = router;
