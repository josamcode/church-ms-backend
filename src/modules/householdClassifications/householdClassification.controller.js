const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const householdClassificationService = require('./householdClassification.service');

const listCategories = asyncHandler(async (_req, res) => {
  const categories = await householdClassificationService.listCategories();
  return ApiResponse.success(res, {
    message: 'Household classifications loaded successfully.',
    data: categories,
  });
});

const createCategory = asyncHandler(async (req, res) => {
  const category = await householdClassificationService.createCategory(req.body, req.user.id);
  return ApiResponse.created(res, {
    message: 'Household classification created successfully.',
    data: category,
  });
});

const updateCategory = asyncHandler(async (req, res) => {
  const category = await householdClassificationService.updateCategory(
    req.params.id,
    req.body,
    req.user.id
  );
  return ApiResponse.success(res, {
    message: 'Household classification updated successfully.',
    data: category,
  });
});

const deleteCategory = asyncHandler(async (req, res) => {
  await householdClassificationService.deleteCategory(req.params.id, req.user.id);
  return ApiResponse.success(res, {
    message: 'Household classification deleted successfully.',
  });
});

const listHouseholds = asyncHandler(async (req, res) => {
  const { page, limit, search, classificationId, includeUnclassified, isLordsBrethren } = req.query;
  const result = await householdClassificationService.listHouseholds({
    page,
    limit,
    search,
    classificationId,
    includeUnclassified:
      includeUnclassified === undefined ? true : String(includeUnclassified) === 'true',
    isLordsBrethren: isLordsBrethren !== undefined ? String(isLordsBrethren) === 'true' : undefined,
  });

  return ApiResponse.success(res, {
    message: 'Household classifications evaluated successfully.',
    data: result.households,
    meta: result.meta,
    summary: result.summary,
  });
});

const getHouseholdByName = asyncHandler(async (req, res) => {
  const household = await householdClassificationService.getHouseholdByName(req.query.houseName);
  return ApiResponse.success(res, {
    message: 'Household loaded successfully.',
    data: household,
  });
});

const updateHousehold = asyncHandler(async (req, res) => {
  const household = await householdClassificationService.updateHousehold(
    req.body,
    req.user.id,
    req.userPermissions
  );
  return ApiResponse.success(res, {
    message: 'Household updated successfully.',
    data: household,
  });
});

module.exports = {
  createCategory,
  deleteCategory,
  getHouseholdByName,
  listCategories,
  listHouseholds,
  updateHousehold,
  updateCategory,
};
