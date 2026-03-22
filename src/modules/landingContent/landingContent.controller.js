const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const landingContentService = require('./landingContent.service');
const { validateImageUpload } = require('../../utils/fileUploads');

function buildSafePublicContent(data = {}) {
  return {
    texts: data?.texts || { en: {}, ar: {} },
    heroImage:
      data?.heroImage && data.heroImage.url
        ? {
            url: data.heroImage.url,
          }
        : null,
    stats: {
      items: Array.isArray(data?.stats?.items) ? data.stats.items : [],
    },
    priests: (Array.isArray(data?.priests) ? data.priests : []).map((entry) => ({
      user: {
        fullName: entry?.user?.fullName || null,
        avatar:
          entry?.user?.avatar && entry.user.avatar.url
            ? {
                url: entry.user.avatar.url,
              }
            : null,
      },
      role: entry?.role || { en: '', ar: '' },
      bio: entry?.bio || { en: '', ar: '' },
      alt: entry?.alt || { en: '', ar: '' },
    })),
    location: data?.location || {},
    socialLinks: Array.isArray(data?.socialLinks) ? data.socialLinks : [],
    updatedAt: data?.updatedAt || null,
  };
}

const getPublicContent = asyncHandler(async (_req, res) => {
  const data = await landingContentService.getPublicContent();
  return ApiResponse.success(res, {
    message: 'Landing content loaded successfully',
    data: buildSafePublicContent(data),
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
  validateImageUpload(req.file, { emptyLabel: 'image' });
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
