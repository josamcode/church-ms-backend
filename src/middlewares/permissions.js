const ApiError = require('../utils/ApiError');
const redisClient = require('../config/redis');
const { CACHE_KEYS, CACHE_TTL } = require('../constants/cacheKeys');
const { ROLE_PERMISSIONS, PERMISSIONS_ARRAY } = require('../constants/permissions');
const { ROLES } = require('../constants/roles');

const getUserEffectivePermissions = async (userId, role, extraPermissions = [], deniedPermissions = []) => {
  try {
    const cached = await redisClient.get(CACHE_KEYS.USER_PERMISSIONS(userId));
    if (cached) return JSON.parse(cached);
  } catch (err) {
    // Cache miss is not fatal
  }

  const effective =
    role === ROLES.SUPER_ADMIN
      ? [...PERMISSIONS_ARRAY]
      : (() => {
          const rolePerms = ROLE_PERMISSIONS[role] || [];
          const effectiveSet = new Set([...rolePerms, ...extraPermissions]);
          deniedPermissions.forEach((p) => effectiveSet.delete(p));
          return [...effectiveSet];
        })();

  try {
    await redisClient.setex(
      CACHE_KEYS.USER_PERMISSIONS(userId),
      CACHE_TTL.USER_PERMISSIONS,
      JSON.stringify(effective)
    );
  } catch (err) {
    // Cache write failure is not fatal
  }

  return effective;
};

const resolveRequestPermissions = async (req) => {
  if (!req.user) {
    throw ApiError.unauthorized('ظٹط¬ط¨ طھط³ط¬ظٹظ„ ط§ظ„ط¯ط®ظˆظ„ ط£ظˆظ„ط§ظ‹', 'AUTH_UNAUTHORIZED');
  }

  const User = require('mongoose').model('User');
  const user = await User.findById(req.user.id)
    .select('role extraPermissions deniedPermissions isLocked isDeleted')
    .lean();

  if (!user || user.isDeleted) {
    throw ApiError.notFound('ط§ظ„ظ…ط³طھط®ط¯ظ… ط؛ظٹط± ظ…ظˆط¬ظˆط¯', 'USER_NOT_FOUND');
  }

  if (user.isLocked) {
    throw ApiError.forbidden(
      'ط§ظ„ط­ط³ط§ط¨ ظ…ط؛ظ„ظ‚. ظٹط±ط¬ظ‰ ط§ظ„طھظˆط§طµظ„ ظ…ط¹ ط§ظ„ظ…ط³ط¤ظˆظ„',
      'AUTH_ACCOUNT_LOCKED'
    );
  }

  const effective = await getUserEffectivePermissions(
    req.user.id,
    user.role,
    user.extraPermissions || [],
    user.deniedPermissions || []
  );

  req.userPermissions = effective;
  return effective;
};

const authorizePermissions = (...requiredPermissions) => {
  return async (req, res, next) => {
    try {
      const effective = await resolveRequestPermissions(req);

      const hasPermission = requiredPermissions.every((perm) => effective.includes(perm));
      if (!hasPermission) {
        throw ApiError.forbidden(
          'ظ„ظٹط³ ظ„ط¯ظٹظƒ طµظ„ط§ط­ظٹط© ظ„طھظ†ظپظٹط° ظ‡ط°ط§ ط§ظ„ط¥ط¬ط±ط§ط،',
          'PERMISSION_DENIED'
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

const authorizeAnyPermissions = (...requiredPermissions) => {
  return async (req, res, next) => {
    try {
      const effective = await resolveRequestPermissions(req);

      const hasPermission = requiredPermissions.some((perm) => effective.includes(perm));
      if (!hasPermission) {
        throw ApiError.forbidden(
          'ظ„ظٹط³ ظ„ط¯ظٹظƒ طµظ„ط§ط­ظٹط© ظ„طھظ†ظپظٹط° ظ‡ط°ط§ ط§ظ„ط¥ط¬ط±ط§ط،',
          'PERMISSION_DENIED'
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

module.exports = { authorizePermissions, authorizeAnyPermissions, getUserEffectivePermissions };
