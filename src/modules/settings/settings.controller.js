const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const config = require('../../config/env');

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

module.exports = {
  getPublicSite,
};
