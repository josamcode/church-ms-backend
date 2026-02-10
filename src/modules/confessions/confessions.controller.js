const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const confessionsService = require('./confessions.service');

const listSessionTypes = asyncHandler(async (req, res) => {
  const types = await confessionsService.listSessionTypes();
  return ApiResponse.success(res, {
    message: 'Confession session types loaded successfully',
    data: types,
  });
});

const createSessionType = asyncHandler(async (req, res) => {
  const type = await confessionsService.createSessionType(req.body.name, req.user.id);
  return ApiResponse.created(res, {
    message: 'Confession session type created successfully',
    data: type,
  });
});

const createSession = asyncHandler(async (req, res) => {
  const session = await confessionsService.createSession(req.body, req.user.id, req.userPermissions);
  return ApiResponse.created(res, {
    message: 'Confession session created successfully',
    data: session,
  });
});

const listSessions = asyncHandler(async (req, res) => {
  const { cursor, limit, order, attendeeUserId, sessionTypeId, dateFrom, dateTo } = req.query;

  const { sessions, meta } = await confessionsService.listSessions({
    cursor,
    limit: parseInt(limit, 10) || 20,
    order: order || 'desc',
    filters: {
      attendeeUserId,
      sessionTypeId,
      dateFrom,
      dateTo,
    },
  });

  return ApiResponse.success(res, {
    message: 'Confession sessions loaded successfully',
    data: sessions,
    meta,
  });
});

const searchUsers = asyncHandler(async (req, res) => {
  const users = await confessionsService.searchUsers({
    fullName: req.query.fullName,
    phonePrimary: req.query.phonePrimary,
    limit: parseInt(req.query.limit, 10) || 15,
  });

  return ApiResponse.success(res, {
    message: 'Users loaded successfully',
    data: users,
  });
});

const getAlertConfig = asyncHandler(async (req, res) => {
  const config = await confessionsService.getAlertConfig();
  return ApiResponse.success(res, {
    message: 'Confession alert settings loaded successfully',
    data: config,
  });
});

const updateAlertConfig = asyncHandler(async (req, res) => {
  const config = await confessionsService.updateAlertConfig(
    req.body.alertThresholdDays,
    req.user.id
  );
  return ApiResponse.success(res, {
    message: 'Confession alert settings updated successfully',
    data: config,
  });
});

const getAlerts = asyncHandler(async (req, res) => {
  const alerts = await confessionsService.getAlerts({
    thresholdDays: req.query.thresholdDays ? parseInt(req.query.thresholdDays, 10) : undefined,
    fullName: req.query.fullName,
  });
  return ApiResponse.success(res, {
    message: 'Confession alerts loaded successfully',
    data: alerts,
  });
});

const getAnalytics = asyncHandler(async (req, res) => {
  const analytics = await confessionsService.getAnalytics({
    months: parseInt(req.query.months, 10) || 6,
  });
  return ApiResponse.success(res, {
    message: 'Confession analytics loaded successfully',
    data: analytics,
  });
});

module.exports = {
  listSessionTypes,
  createSessionType,
  createSession,
  listSessions,
  searchUsers,
  getAlertConfig,
  updateAlertConfig,
  getAlerts,
  getAnalytics,
};
