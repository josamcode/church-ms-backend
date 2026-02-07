const asyncHandler = require('../../utils/asyncHandler');
const authService = require('./auth.service');
const ApiResponse = require('../../utils/apiResponse');

const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);
  return ApiResponse.created(res, {
    message: 'تم التسجيل بنجاح',
    data: {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
  });
});

const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body);
  return ApiResponse.success(res, {
    message: 'تم تسجيل الدخول بنجاح',
    data: {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
  });
});

const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.body.refreshToken);
  return ApiResponse.success(res, {
    message: 'تم تحديث الجلسة بنجاح',
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
  });
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.user.id, req.user.jti, req.body.refreshToken);
  return ApiResponse.success(res, {
    message: 'تم تسجيل الخروج بنجاح',
  });
});

const getMe = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user.id);
  return ApiResponse.success(res, {
    message: 'تم جلب بيانات المستخدم بنجاح',
    data: user,
  });
});

const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(
    req.user.id,
    req.body.currentPassword,
    req.body.newPassword
  );
  return ApiResponse.success(res, {
    message: 'تم تغيير كلمة المرور بنجاح',
  });
});

module.exports = {
  register,
  login,
  refresh,
  logout,
  getMe,
  changePassword,
};
