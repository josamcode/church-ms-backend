const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const divineLiturgiesService = require('./divineLiturgies.service');

const getOverview = asyncHandler(async (_req, res) => {
  const data = await divineLiturgiesService.getOverview();
  return ApiResponse.success(res, {
    message: 'Divine liturgy data loaded successfully',
    data,
  });
});

const getPublicOverview = asyncHandler(async (_req, res) => {
  const data = await divineLiturgiesService.getPublicOverview();
  return ApiResponse.success(res, {
    message: 'Divine liturgy schedule loaded successfully',
    data,
  });
});

const getAttendanceContext = asyncHandler(async (req, res) => {
  const data = await divineLiturgiesService.getAttendanceContext(req.params.entryType, req.params.id, {
    actorUserId: req.user.id,
    userPermissions: req.userPermissions,
  });
  return ApiResponse.success(res, {
    message: 'Divine liturgy attendance context loaded successfully',
    data,
  });
});

const getAttendance = asyncHandler(async (req, res) => {
  const data = await divineLiturgiesService.getAttendance(
    req.params.entryType,
    req.params.id,
    req.query.attendanceDate,
    {
      actorUserId: req.user.id,
      userPermissions: req.userPermissions,
    }
  );
  return ApiResponse.success(res, {
    message: 'Divine liturgy attendance loaded successfully',
    data,
  });
});

const updateAttendance = asyncHandler(async (req, res) => {
  const data = await divineLiturgiesService.updateAttendance(
    req.params.entryType,
    req.params.id,
    req.body.attendanceDate,
    req.body.attendedUserIds,
    {
      actorUserId: req.user.id,
      userPermissions: req.userPermissions,
    }
  );
  return ApiResponse.success(res, {
    message: 'Divine liturgy attendance saved successfully',
    data,
  });
});

const createRecurring = asyncHandler(async (req, res) => {
  const record = await divineLiturgiesService.createRecurring(req.body, req.user.id);
  return ApiResponse.created(res, {
    message: 'Recurring service created successfully',
    data: record,
  });
});

const updateRecurring = asyncHandler(async (req, res) => {
  const record = await divineLiturgiesService.updateRecurring(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'Recurring service updated successfully',
    data: record,
  });
});

const deleteRecurring = asyncHandler(async (req, res) => {
  await divineLiturgiesService.deleteRecurring(req.params.id);
  return ApiResponse.success(res, {
    message: 'Recurring service deleted successfully',
    data: null,
  });
});

const createException = asyncHandler(async (req, res) => {
  const record = await divineLiturgiesService.createException(req.body, req.user.id);
  return ApiResponse.created(res, {
    message: 'Exceptional divine liturgy created successfully',
    data: record,
  });
});

const updateException = asyncHandler(async (req, res) => {
  const record = await divineLiturgiesService.updateException(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'Exceptional divine liturgy updated successfully',
    data: record,
  });
});

const deleteException = asyncHandler(async (req, res) => {
  await divineLiturgiesService.deleteException(req.params.id);
  return ApiResponse.success(res, {
    message: 'Exceptional divine liturgy deleted successfully',
    data: null,
  });
});

const setChurchPriests = asyncHandler(async (req, res) => {
  const data = await divineLiturgiesService.setChurchPriests(req.body.priestUserIds, req.user.id);
  return ApiResponse.success(res, {
    message: 'Church priests updated successfully',
    data,
  });
});

module.exports = {
  getOverview,
  getPublicOverview,
  getAttendanceContext,
  getAttendance,
  updateAttendance,
  createRecurring,
  updateRecurring,
  deleteRecurring,
  createException,
  updateException,
  deleteException,
  setChurchPriests,
};
