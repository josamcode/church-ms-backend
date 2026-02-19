const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const meetingsService = require('./meetings.service');

const createSector = asyncHandler(async (req, res) => {
  const sector = await meetingsService.createSector(req.body, req.user.id);
  return ApiResponse.created(res, {
    message: 'Sector created successfully',
    data: sector,
  });
});

const listSectors = asyncHandler(async (req, res) => {
  const { cursor, limit, order, search } = req.query;
  const { sectors, meta } = await meetingsService.listSectors({
    cursor,
    limit: parseInt(limit, 10) || 20,
    order: order || 'asc',
    search,
  });

  return ApiResponse.success(res, {
    message: 'Sectors loaded successfully',
    data: sectors,
    meta,
  });
});

const getSectorById = asyncHandler(async (req, res) => {
  const sector = await meetingsService.getSectorById(req.params.id);
  return ApiResponse.success(res, {
    message: 'Sector loaded successfully',
    data: sector,
  });
});

const updateSector = asyncHandler(async (req, res) => {
  const sector = await meetingsService.updateSector(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'Sector updated successfully',
    data: sector,
  });
});

const deleteSector = asyncHandler(async (req, res) => {
  await meetingsService.deleteSector(req.params.id, req.user.id);
  return ApiResponse.success(res, {
    message: 'Sector deleted successfully',
    data: null,
  });
});

const createMeeting = asyncHandler(async (req, res) => {
  const meeting = await meetingsService.createMeeting(req.body, req.user.id, req.userPermissions || []);
  return ApiResponse.created(res, {
    message: 'Meeting created successfully',
    data: meeting,
  });
});

const listMeetings = asyncHandler(async (req, res) => {
  const { cursor, limit, order, sectorId, day, search } = req.query;
  const { meetings, meta } = await meetingsService.listMeetings({
    cursor,
    limit: parseInt(limit, 10) || 20,
    order: order || 'desc',
    filters: {
      sectorId,
      day,
      search,
    },
  });

  return ApiResponse.success(res, {
    message: 'Meetings loaded successfully',
    data: meetings,
    meta,
  });
});

const getMeetingById = asyncHandler(async (req, res) => {
  const meeting = await meetingsService.getMeetingById(req.params.id);
  return ApiResponse.success(res, {
    message: 'Meeting loaded successfully',
    data: meeting,
  });
});

const updateMeetingBasic = asyncHandler(async (req, res) => {
  const meeting = await meetingsService.updateMeetingBasic(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'Meeting updated successfully',
    data: meeting,
  });
});

const updateMeetingServants = asyncHandler(async (req, res) => {
  const meeting = await meetingsService.updateMeetingServants(req.params.id, req.body.servants, req.user.id);
  return ApiResponse.success(res, {
    message: 'Meeting servants updated successfully',
    data: meeting,
  });
});

const updateMeetingCommittees = asyncHandler(async (req, res) => {
  const meeting = await meetingsService.updateMeetingCommittees(
    req.params.id,
    req.body.committees,
    req.user.id
  );
  return ApiResponse.success(res, {
    message: 'Meeting committees updated successfully',
    data: meeting,
  });
});

const updateMeetingActivities = asyncHandler(async (req, res) => {
  const meeting = await meetingsService.updateMeetingActivities(
    req.params.id,
    req.body.activities,
    req.user.id
  );
  return ApiResponse.success(res, {
    message: 'Meeting activities updated successfully',
    data: meeting,
  });
});

const deleteMeeting = asyncHandler(async (req, res) => {
  await meetingsService.deleteMeeting(req.params.id, req.user.id);
  return ApiResponse.success(res, {
    message: 'Meeting deleted successfully',
    data: null,
  });
});

const listResponsibilitySuggestions = asyncHandler(async (req, res) => {
  const suggestions = await meetingsService.listResponsibilitySuggestions({
    search: req.query.search,
    limit: parseInt(req.query.limit, 10) || 30,
  });

  return ApiResponse.success(res, {
    message: 'Responsibility suggestions loaded successfully',
    data: suggestions,
  });
});

const getServantHistory = asyncHandler(async (req, res) => {
  const result = await meetingsService.getServantHistory({
    userId: req.query.userId,
    name: req.query.name,
    limit: parseInt(req.query.limit, 10) || 10,
  });

  return ApiResponse.success(res, {
    message: 'Servant history loaded successfully',
    data: result,
  });
});

const uploadSectorAvatarImage = asyncHandler(async (req, res) => {
  const avatar = await meetingsService.uploadImageToCloudinary(req.file);
  return ApiResponse.success(res, {
    message: 'Sector avatar uploaded successfully',
    data: avatar,
  });
});

const uploadMeetingAvatarImage = asyncHandler(async (req, res) => {
  const avatar = await meetingsService.uploadImageToCloudinary(req.file);
  return ApiResponse.success(res, {
    message: 'Meeting avatar uploaded successfully',
    data: avatar,
  });
});

module.exports = {
  createSector,
  listSectors,
  getSectorById,
  updateSector,
  deleteSector,
  uploadSectorAvatarImage,
  uploadMeetingAvatarImage,
  createMeeting,
  listMeetings,
  getMeetingById,
  updateMeetingBasic,
  updateMeetingServants,
  updateMeetingCommittees,
  updateMeetingActivities,
  deleteMeeting,
  listResponsibilitySuggestions,
  getServantHistory,
};
