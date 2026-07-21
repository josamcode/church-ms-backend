const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const visitationsService = require('./visitations.service');

const createVisitation = asyncHandler(async (req, res) => {
  const visitation = await visitationsService.createVisitation(req.body, req.user.id);
  return ApiResponse.created(res, {
    message: 'Pastoral visitation created successfully',
    data: visitation,
  });
});

const listVisitations = asyncHandler(async (req, res) => {
  const { cursor, limit, order, houseName, recordedByUserId, dateFrom, dateTo } = req.query;

  const { visitations, meta } = await visitationsService.listVisitations({
    cursor,
    limit: parseInt(limit, 10) || 20,
    order: order || 'desc',
    filters: {
      houseName,
      recordedByUserId,
      dateFrom,
      dateTo,
    },
    // Identity, not permissions: note visibility is decided by who recorded
    // the visit, and `req.user` is the same authenticated source the
    // authorization middleware uses.
    viewer: { viewerUserId: req.user.id, viewerRole: req.user.role },
  });

  return ApiResponse.success(res, {
    message: 'Pastoral visitations loaded successfully',
    data: visitations,
    meta,
  });
});

const getVisitationById = asyncHandler(async (req, res) => {
  const visitation = await visitationsService.getVisitationById(req.params.id, {
    viewerUserId: req.user.id,
    viewerRole: req.user.role,
  });
  return ApiResponse.success(res, {
    message: 'Pastoral visitation loaded successfully',
    data: visitation,
  });
});

const getAnalytics = asyncHandler(async (req, res) => {
  const analytics = await visitationsService.getAnalytics({
    months: parseInt(req.query.months, 10) || 6,
  });
  return ApiResponse.success(res, {
    message: 'Pastoral visitation analytics loaded successfully',
    data: analytics,
  });
});

module.exports = {
  createVisitation,
  listVisitations,
  getVisitationById,
  getAnalytics,
};
