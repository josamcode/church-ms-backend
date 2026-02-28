const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const notificationsService = require('./notifications.service');

const listNotificationTypes = asyncHandler(async (req, res) => {
  const types = await notificationsService.listNotificationTypes();
  return ApiResponse.success(res, {
    message: 'Notification types loaded successfully',
    data: types,
  });
});

const createNotificationType = asyncHandler(async (req, res) => {
  const type = await notificationsService.createNotificationType(req.body.name, req.user.id);
  return ApiResponse.created(res, {
    message: 'Notification type created successfully',
    data: type,
  });
});

const uploadNotificationImage = asyncHandler(async (req, res) => {
  const image = await notificationsService.uploadImageToCloudinary(req.file);
  return ApiResponse.success(res, {
    message: 'Notification image uploaded successfully',
    data: image,
  });
});

const listNotifications = asyncHandler(async (req, res) => {
  const { cursor, limit, order, typeId, q, isActive } = req.query;

  const parsedIsActive =
    isActive === undefined
      ? undefined
      : isActive === true || isActive === 'true'
        ? true
        : isActive === false || isActive === 'false'
          ? false
          : undefined;

  const { notifications, meta } = await notificationsService.listNotifications({
    cursor,
    limit: parseInt(limit, 10) || 20,
    order: order || 'desc',
    filters: {
      typeId,
      q,
      isActive: parsedIsActive,
    },
  });

  return ApiResponse.success(res, {
    message: 'Notifications loaded successfully',
    data: notifications,
    meta,
  });
});

const createNotification = asyncHandler(async (req, res) => {
  const notification = await notificationsService.createNotification(req.body, req.user.id);
  return ApiResponse.created(res, {
    message: 'Notification created successfully',
    data: notification,
  });
});

const getNotificationById = asyncHandler(async (req, res) => {
  const notification = await notificationsService.getNotificationById(req.params.id);
  return ApiResponse.success(res, {
    message: 'Notification loaded successfully',
    data: notification,
  });
});

const updateNotification = asyncHandler(async (req, res) => {
  const notification = await notificationsService.updateNotification(
    req.params.id,
    req.body,
    req.user.id
  );
  return ApiResponse.success(res, {
    message: 'Notification updated successfully',
    data: notification,
  });
});

module.exports = {
  listNotificationTypes,
  createNotificationType,
  uploadNotificationImage,
  listNotifications,
  createNotification,
  getNotificationById,
  updateNotification,
};
