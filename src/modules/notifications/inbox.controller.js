const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const userNotificationsService = require('./userNotifications.service');

const listNotifications = asyncHandler(async (req, res) => {
  const { notifications, meta } = await userNotificationsService.listNotifications({
    userId: req.user.id,
    cursor: req.query.cursor,
    limit: Number(req.query.limit || 20),
  });

  return ApiResponse.success(res, {
    message: 'User notifications loaded successfully',
    data: notifications,
    meta,
  });
});

const getUnreadCount = asyncHandler(async (req, res) => {
  const payload = await userNotificationsService.getUnreadCount(req.user.id);
  return ApiResponse.success(res, {
    message: 'Unread notification count loaded successfully',
    data: payload,
  });
});

const markAsRead = asyncHandler(async (req, res) => {
  const payload = await userNotificationsService.markAsRead(req.params.id, req.user.id);
  return ApiResponse.success(res, {
    message: 'Notification marked as read successfully',
    data: payload,
  });
});

const markAllAsRead = asyncHandler(async (req, res) => {
  const payload = await userNotificationsService.markAllAsRead(req.user.id);
  return ApiResponse.success(res, {
    message: 'All notifications marked as read successfully',
    data: payload,
  });
});

const sendSystemNotification = asyncHandler(async (req, res) => {
  const payload = await userNotificationsService.sendSystemNotification({
    actorUserId: req.user.id,
    type: req.body.type,
    title: req.body.title,
    message: req.body.message,
    link: req.body.link,
    metadata: req.body.metadata,
    userIds: req.body.userIds,
    targetPermissions: req.body.targetPermissions,
    broadcastToAll: req.body.broadcastToAll,
  });

  return ApiResponse.created(res, {
    message: 'System notification sent successfully',
    data: payload,
  });
});

module.exports = {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  sendSystemNotification,
};
