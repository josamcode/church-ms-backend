const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const aidService = require('./aid.service');

const createBulkAids = asyncHandler(async (req, res) => {
  const { houseNames, aid } = req.body;

  await aidService.createBulkAids(houseNames, aid, req.user.id);

  return ApiResponse.created(res);
});

const getAidOptions = asyncHandler(async (req, res) => {
  const data = await aidService.getAidOptions();

  return ApiResponse.success(res, { data });
});

const getDisbursedAids = asyncHandler(async (req, res) => {
  const { page, limit, search, category } = req.query;
  const data = await aidService.getDisbursedAids({ page, limit, search, category });

  return ApiResponse.success(res, { data: data.items, meta: data.meta });
});

const getAidDetails = asyncHandler(async (req, res) => {
  const { date, category, occurrence, description } = req.query;
  const data = await aidService.getAidDetails({ date, category, occurrence, description });

  return ApiResponse.success(res, { data });
});

const searchAidHistory = asyncHandler(async (req, res) => {
  const data = await aidService.searchAidHistory(req.body.houseNames);

  return ApiResponse.success(res, { data });
});

const approveAidReminder = asyncHandler(async (req, res) => {
  const data = await aidService.approveAidReminder(req.params.id, req.user.id);

  return ApiResponse.success(res, { data });
});

const updateFullAidGroup = asyncHandler(async (req, res) => {
  const { originalGroup, updatedData, houseNames } = req.body;
  const result = await aidService.updateFullAidGroup(originalGroup, updatedData, houseNames, req.user.id);

  return ApiResponse.success(res, { data: result });
});

module.exports = {
  approveAidReminder,
  createBulkAids,
  getAidOptions,
  getDisbursedAids,
  getAidDetails,
  searchAidHistory,
  updateFullAidGroup,
};
