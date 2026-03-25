const jwt = require('jsonwebtoken');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const redisClient = require('../config/redis');
const { CACHE_KEYS } = require('../constants/cacheKeys');
const { ACCOUNT_STATUSES } = require('../constants/accountStatuses');
const User = require('../modules/users/user.model');

const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Authentication is required', 'AUTH_UNAUTHORIZED');
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.accessSecret);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw ApiError.unauthorized(
          'Your session has expired. Please sign in again.',
          'AUTH_TOKEN_EXPIRED'
        );
      }
      throw ApiError.unauthorized('Authentication token is invalid', 'AUTH_TOKEN_INVALID');
    }

    if (decoded.jti) {
      try {
        const isBlacklisted = await redisClient.get(CACHE_KEYS.TOKEN_BLACKLIST(decoded.jti));
        if (isBlacklisted) {
          throw ApiError.unauthorized(
            'Authentication token has been revoked',
            'AUTH_TOKEN_BLACKLISTED'
          );
        }
      } catch (error) {
        if (error.isOperational) throw error;
        throw ApiError.serviceUnavailable(
          'Unable to validate the current session. Please try again shortly.',
          'AUTH_SESSION_STORE_UNAVAILABLE'
        );
      }
    }

    const user = await User.findById(decoded.sub)
      .select('authVersion isDeleted isLocked lockReason hasLogin accountStatus')
      .lean();

    if (!user || user.isDeleted) {
      throw ApiError.unauthorized('User account was not found', 'AUTH_TOKEN_INVALID');
    }

    if (Number(decoded.authVersion || 0) !== Number(user.authVersion || 0)) {
      throw ApiError.unauthorized(
        'This session has been invalidated. Please sign in again.',
        'AUTH_SESSION_INVALIDATED'
      );
    }

    const accountStatus = user.accountStatus || ACCOUNT_STATUSES.APPROVED;
    if (accountStatus === ACCOUNT_STATUSES.PENDING) {
      throw ApiError.forbidden(
        'Your registration request is still pending approval. Please wait for an administrator to review it.',
        'AUTH_ACCOUNT_PENDING'
      );
    }
    if (accountStatus === ACCOUNT_STATUSES.REJECTED) {
      throw ApiError.forbidden(
        'Your registration request was rejected. Please contact an administrator for help.',
        'AUTH_ACCOUNT_REJECTED'
      );
    }
    if (!user.hasLogin) {
      throw ApiError.forbidden(
        'This account does not currently have permission to sign in.',
        'AUTH_NO_LOGIN_ACCESS'
      );
    }
    if (user.isLocked) {
      throw ApiError.forbidden(
        `This account is locked: ${user.lockReason || 'Please contact an administrator'}`,
        'AUTH_ACCOUNT_LOCKED'
      );
    }

    req.user = {
      id: decoded.sub,
      role: decoded.role,
      authVersion: Number(decoded.authVersion || 0),
      jti: decoded.jti,
    };

    next();
  } catch (error) {
    next(error);
  }
};

const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  return authenticateJWT(req, res, next);
};

module.exports = { authenticateJWT, optionalAuth };
