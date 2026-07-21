const asyncHandler = require('../../utils/asyncHandler');
const authService = require('./auth.service');
const ApiResponse = require('../../utils/apiResponse');
const userService = require('../users/user.service');
const auditService = require('../audit/audit.service');

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

const getRegistrationOptions = asyncHandler(async (_req, res) => {
  const [familyNames, houseNames, profileOptionValues] = await Promise.all([
    userService.getFamilyNames(),
    userService.getHouseNames(),
    userService.getProfileOptionValues(),
  ]);

  return ApiResponse.success(res, {
    message: 'Registration form options loaded successfully',
    data: {
      familyNames,
      houseNames,
      profileOptionValues: {
        travelDestinations: profileOptionValues?.travelDestinations || [],
        travelReasons: profileOptionValues?.travelReasons || [],
        healthConditions: profileOptionValues?.healthConditions || [],
      },
    },
  });
});

const login = asyncHandler(async (req, res) => {
  // Audited at the controller because the service layer is deliberately
  // request-free: `req.ip` / `req.requestId` / user-agent exist only here.
  let result;
  try {
    result = await authService.login(req.body);
  } catch (error) {
    await auditService.recordLoginFailure(req, {
      identifier: req.body?.identifier,
      reason: error.errorCode || error.message,
    });
    throw error;
  }

  await auditService.recordLoginSuccess(req, {
    userId: result.user?.id,
    role: result.user?.role,
  });

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
  await auditService.recordLogout(req);
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
  await auditService.recordPasswordChanged(req);
  return ApiResponse.success(res, {
    message: 'Password changed successfully',
  });
});

module.exports = {
  register,
  getRegistrationOptions,
  login,
  refresh,
  logout,
  getMe,
  updateMySettings,
  changePassword,
};
