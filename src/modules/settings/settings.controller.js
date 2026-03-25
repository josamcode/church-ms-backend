const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/ApiError');
const config = require('../../config/env');
const { ROLES } = require('../../constants/roles');
const platformSettingsService = require('./platformSettings.service');

const getPublicSite = asyncHandler(async (_req, res) => {
  const registrationEnabled = await platformSettingsService.isRegistrationEnabled();
  const site = {
    name: config.site?.name || 'كنيسة الملاك ميخائيل',
    tagline: config.site?.tagline || 'قرية القطوشة - التابعة لإيبارشية مطاى',
    registrationEnabled,
  };

  return ApiResponse.success(res, {
    message: 'تم جلب إعدادات الموقع بنجاح',
    data: site,
  });
});

const getPlatformSettings = asyncHandler(async (_req, res) => {
  const data = await platformSettingsService.getManageSettings();
  return ApiResponse.success(res, {
    message: 'تم جلب إعدادات المنصة بنجاح',
    data,
  });
});

const updatePlatformSettings = asyncHandler(async (req, res) => {
  if (
    Object.prototype.hasOwnProperty.call(req.body || {}, 'registrationEnabled') &&
    req.user?.role !== ROLES.SUPER_ADMIN
  ) {
    throw ApiError.forbidden(
      'يمكن فقط للمشرف العام التحكم في إتاحة التسجيل العام.',
      'PERMISSION_DENIED'
    );
  }

  const data = await platformSettingsService.updateManageSettings(req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'تم تحديث إعدادات المنصة بنجاح',
    data,
  });
});

module.exports = {
  getPublicSite,
  getPlatformSettings,
  updatePlatformSettings,
};
