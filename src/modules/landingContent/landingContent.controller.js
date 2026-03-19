const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const landingContentService = require('./landingContent.service');

const getPublicContent = asyncHandler(async (_req, res) => {
  const data = await landingContentService.getPublicContent();
  return ApiResponse.success(res, {
    message: 'Landing content loaded successfully',
    data,
  });
});

const getManageContent = asyncHandler(async (_req, res) => {
  const data = await landingContentService.getManageContent();
  return ApiResponse.success(res, {
    message: 'Landing content editor loaded successfully',
    data,
  });
});

const updateContent = asyncHandler(async (req, res) => {
  const data = await landingContentService.updateContent(req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'Landing content saved successfully',
    data,
  });
});

const uploadHeroImage = asyncHandler(async (req, res) => {
  const data = await landingContentService.uploadHeroImage(req.file, req.user.id);
  return ApiResponse.success(res, {
    message: 'Landing hero image uploaded successfully',
    data,
  });
});

const deleteHeroImage = asyncHandler(async (req, res) => {
  await landingContentService.deleteHeroImage(req.user.id);
  return ApiResponse.success(res, {
    message: 'Landing hero image deleted successfully',
    data: null,
  });
});

module.exports = {
  getPublicContent,
  getManageContent,
  updateContent,
  uploadHeroImage,
  deleteHeroImage,
};

