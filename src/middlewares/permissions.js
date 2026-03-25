const ApiError = require('../utils/ApiError');
const redisClient = require('../config/redis');
const { CACHE_KEYS, CACHE_TTL } = require('../constants/cacheKeys');
const { getEffectivePermissions } = require('../constants/permissions');
const { ACCOUNT_STATUSES } = require('../constants/accountStatuses');

const getUserEffectivePermissions = async (userId, role, extraPermissions = [], deniedPermissions = []) => {
  try {
    const cached = await redisClient.get(CACHE_KEYS.USER_PERMISSIONS(userId));
    if (cached) return JSON.parse(cached);
  } catch (_err) {
    // فشل قراءة الكاش لا يوقف التنفيذ.
  }

  const effective = getEffectivePermissions(role, extraPermissions, deniedPermissions);

  try {
    await redisClient.setex(
      CACHE_KEYS.USER_PERMISSIONS(userId),
      CACHE_TTL.USER_PERMISSIONS,
      JSON.stringify(effective)
    );
  } catch (_err) {
    // فشل كتابة الكاش لا يوقف التنفيذ.
  }

  return effective;
};

const resolveRequestPermissions = async (req) => {
  if (!req.user) {
    throw ApiError.unauthorized('يجب تسجيل الدخول أولًا', 'AUTH_UNAUTHORIZED');
  }

  const User = require('mongoose').model('User');
  const user = await User.findById(req.user.id)
    .select('role extraPermissions deniedPermissions isLocked lockReason isDeleted hasLogin accountStatus')
    .lean();

  if (!user || user.isDeleted) {
    throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
  }

  const accountStatus = user.accountStatus || ACCOUNT_STATUSES.APPROVED;
  if (accountStatus === ACCOUNT_STATUSES.PENDING) {
    throw ApiError.forbidden(
      'طلب تسجيل الحساب ما زال قيد المراجعة. يرجى انتظار موافقة المسؤول.',
      'AUTH_ACCOUNT_PENDING'
    );
  }

  if (accountStatus === ACCOUNT_STATUSES.REJECTED) {
    throw ApiError.forbidden(
      'تم رفض طلب تسجيل الحساب. يرجى التواصل مع الإدارة للمساعدة.',
      'AUTH_ACCOUNT_REJECTED'
    );
  }

  if (!user.hasLogin) {
    throw ApiError.forbidden(
      'هذا الحساب لا يملك صلاحية تسجيل الدخول حاليًا.',
      'AUTH_NO_LOGIN_ACCESS'
    );
  }

  if (user.isLocked) {
    throw ApiError.forbidden(
      'الحساب مغلق. يرجى التواصل مع المسؤول.',
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
          'ليس لديك صلاحية لتنفيذ هذا الإجراء.',
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
          'ليس لديك صلاحية لتنفيذ هذا الإجراء.',
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
