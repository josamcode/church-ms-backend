const asyncHandler = require('../../utils/asyncHandler');
const userService = require('./user.service');
const ApiResponse = require('../../utils/apiResponse');

const createUser = asyncHandler(async (req, res) => {
  const user = await userService.createUser(req.body, req.user.id);
  return ApiResponse.created(res, {
    message: 'تم إنشاء المستخدم بنجاح',
    data: user,
  });
});

const listUsers = asyncHandler(async (req, res) => {
  const { cursor, limit, sort, order, ...filters } = req.query;

  if (filters.tags && typeof filters.tags === 'string') {
    filters.tags = filters.tags.split(',').map((t) => t.trim());
  }

  const { users, meta } = await userService.listUsers({
    cursor,
    limit: parseInt(limit, 10) || 20,
    sort: sort || 'createdAt',
    order: order || 'desc',
    filters,
  });

  return ApiResponse.success(res, {
    message: 'تم جلب قائمة المستخدمين بنجاح',
    data: users,
    meta,
  });
});

const getUser = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  return ApiResponse.success(res, {
    message: 'تم جلب بيانات المستخدم بنجاح',
    data: user,
  });
});

const updateUser = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'تم تحديث بيانات المستخدم بنجاح',
    data: user,
  });
});

const deleteUser = asyncHandler(async (req, res) => {
  await userService.deleteUser(req.params.id, req.user.id);
  return ApiResponse.success(res, {
    message: 'تم حذف المستخدم بنجاح',
  });
});

const uploadAvatar = asyncHandler(async (req, res) => {
  const avatar = await userService.uploadAvatar(req.params.id, req.file, req.user.id);
  return ApiResponse.success(res, {
    message: 'تم رفع الصورة الشخصية بنجاح',
    data: avatar,
  });
});

const lockUser = asyncHandler(async (req, res) => {
  const user = await userService.lockUser(req.params.id, req.body.lockReason, req.user.id);
  return ApiResponse.success(res, {
    message: 'تم قفل الحساب بنجاح',
    data: user,
  });
});

const unlockUser = asyncHandler(async (req, res) => {
  const user = await userService.unlockUser(req.params.id, req.user.id);
  return ApiResponse.success(res, {
    message: 'تم فتح الحساب بنجاح',
    data: user,
  });
});

const manageTags = asyncHandler(async (req, res) => {
  const tags = await userService.manageTags(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'تم تعديل الوسوم بنجاح',
    data: { tags },
  });
});

const linkFamily = asyncHandler(async (req, res) => {
  const user = await userService.linkFamilyMember(req.params.id, req.body, req.user.id);
  return ApiResponse.success(res, {
    message: 'تم ربط فرد العائلة بنجاح',
    data: user,
  });
});

module.exports = {
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  uploadAvatar,
  lockUser,
  unlockUser,
  manageTags,
  linkFamily,
};
