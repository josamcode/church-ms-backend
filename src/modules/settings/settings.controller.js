const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const config = require('../../config/env');
const platformSettingsService = require('./platformSettings.service');

const getPublicSite = asyncHandler(async (req, res) => {
  const site = {
    name: config.site?.name || 'كنيسة الملاك ميخائيل',
    tagline: config.site?.tagline || 'قرية القطوشة - التابعة لإيبارشية مطاى',
  };
  return ApiResponse.success(res, {
    message: 'تم جلب إعدادات الموقع بنجاح',
    data: site,
  });
});

const getPlatformSettings = asyncHandler(async (_req, res) => {
  const data = await platformSettingsService.getManageSettings();
  return ApiResponse.success(res, {
    message: 'Platform settings loaded successfully',
    data,
  });
});

const updatePlatformSettings = asyncHandler(async (req, res) => {
  const data = await platformSettingsService.updateManageSettings(req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'Platform settings updated successfully',
    data,
  });
});

module.exports = {
  getPublicSite,
  getPlatformSettings,
  updatePlatformSettings,
};
