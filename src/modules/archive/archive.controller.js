const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const archiveService = require('./archive.service');

const getPublicContent = asyncHandler(async (_req, res) => {
  const data = await archiveService.getPublicContent();
  return ApiResponse.success(res, {
    message: 'Archive content loaded successfully',
    data,
  });
});

const getManageContent = asyncHandler(async (_req, res) => {
  const data = await archiveService.getManageContent();
  return ApiResponse.success(res, {
    message: 'Archive workspace loaded successfully',
    data,
  });
});

const uploadArchiveImage = asyncHandler(async (req, res) => {
  const data = await archiveService.uploadImage(req.file);
  return ApiResponse.success(res, {
    message: 'Archive image uploaded successfully',
    data,
  });
});

const createCollection = asyncHandler(async (req, res) => {
  const data = await archiveService.createCollection(req.body, req.user.id, req.userPermissions);
  return ApiResponse.created(res, {
    message: 'Archive collection created successfully',
    data,
  });
});

const updateCollection = asyncHandler(async (req, res) => {
  const data = await archiveService.updateCollection(
    req.params.id,
    req.body,
    req.user.id,
    req.userPermissions
  );
  return ApiResponse.success(res, {
    message: 'Archive collection updated successfully',
    data,
  });
});

const deleteCollection = asyncHandler(async (req, res) => {
  const data = await archiveService.deleteCollection(req.params.id, req.user.id, req.userPermissions);
  return ApiResponse.success(res, {
    message: 'Archive collection deleted successfully',
    data,
  });
});

const createStory = asyncHandler(async (req, res) => {
  const data = await archiveService.createStory(req.body, req.user.id, req.userPermissions);
  return ApiResponse.created(res, {
    message: 'Archive story created successfully',
    data,
  });
});

const updateStory = asyncHandler(async (req, res) => {
  const data = await archiveService.updateStory(
    req.params.id,
    req.body,
    req.user.id,
    req.userPermissions
  );
  return ApiResponse.success(res, {
    message: 'Archive story updated successfully',
    data,
  });
});

const deleteStory = asyncHandler(async (req, res) => {
  const data = await archiveService.deleteStory(req.params.id, req.user.id, req.userPermissions);
  return ApiResponse.success(res, {
    message: 'Archive story deleted successfully',
    data,
  });
});

const createHonoree = asyncHandler(async (req, res) => {
  const data = await archiveService.createHonoree(req.body, req.user.id, req.userPermissions);
  return ApiResponse.created(res, {
    message: 'Honoree entry created successfully',
    data,
  });
});

const updateHonoree = asyncHandler(async (req, res) => {
  const data = await archiveService.updateHonoree(
    req.params.id,
    req.body,
    req.user.id,
    req.userPermissions
  );
  return ApiResponse.success(res, {
    message: 'Honoree entry updated successfully',
    data,
  });
});

const deleteHonoree = asyncHandler(async (req, res) => {
  const data = await archiveService.deleteHonoree(req.params.id, req.user.id, req.userPermissions);
  return ApiResponse.success(res, {
    message: 'Honoree entry deleted successfully',
    data,
  });
});

module.exports = {
  getPublicContent,
  getManageContent,
  uploadArchiveImage,
  createCollection,
  updateCollection,
  deleteCollection,
  createStory,
  updateStory,
  deleteStory,
  createHonoree,
  updateHonoree,
  deleteHonoree,
};
