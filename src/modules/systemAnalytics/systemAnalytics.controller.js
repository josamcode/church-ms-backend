const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const systemAnalyticsService = require('./systemAnalytics.service');

const syncSession = asyncHandler(async (req, res) => {
  const result = await systemAnalyticsService.syncSession(req.body, req.user || null, {
    userAgent: req.get('user-agent'),
  });

  return ApiResponse.success(res, {
    message: 'Analytics session synced successfully',
    data: result,
    statusCode: 202,
  });
});

const getOverview = asyncHandler(async (req, res) => {
  const analytics = await systemAnalyticsService.getOverview({
    days: parseInt(req.query.days, 10) || 30,
    surface: req.query.surface || 'all',
    limit: parseInt(req.query.limit, 10) || 20,
  });

  return ApiResponse.success(res, {
    message: 'System analytics loaded successfully',
    data: analytics,
  });
});

module.exports = {
  syncSession,
  getOverview,
};
