const asyncHandler = require('../../utils/asyncHandler');
const authService = require('./auth.service');
const ApiResponse = require('../../utils/apiResponse');

const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);
  return ApiResponse.created(res, {
    message: result.requiresApproval
      ? 'Registration submitted successfully. Your account is pending approval.'
      : 'Registration completed successfully.',
    data: {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      requiresApproval: Boolean(result.requiresApproval),
    },
  });
});

const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body);
  return ApiResponse.success(res, {
    message: 'Signed in successfully',
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
    message: 'Session refreshed successfully',
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    },
  });
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.user.id, req.user.jti, req.body.refreshToken);
  return ApiResponse.success(res, {
    message: 'Signed out successfully',
  });
});

const getMe = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user.id);
  return ApiResponse.success(res, {
    message: 'User profile loaded successfully',
    data: user,
  });
});

const updateMySettings = asyncHandler(async (req, res) => {
  const user = await authService.updateMySettings(req.user.id, req.body);
  return ApiResponse.success(res, {
    message: 'Account settings updated successfully',
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
    message: 'Password changed successfully',
  });
});

module.exports = {
  register,
  login,
  refresh,
  logout,
  getMe,
  updateMySettings,
  changePassword,
};
