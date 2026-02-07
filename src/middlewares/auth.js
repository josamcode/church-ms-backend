const jwt = require('jsonwebtoken');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const redisClient = require('../config/redis');
const { CACHE_KEYS } = require('../constants/cacheKeys');

const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw ApiError.unauthorized('يجب تسجيل الدخول أولاً', 'AUTH_UNAUTHORIZED');
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.accessSecret);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw ApiError.unauthorized(
          'انتهت صلاحية الجلسة. يرجى تسجيل الدخول مرة أخرى',
          'AUTH_TOKEN_EXPIRED'
        );
      }
      throw ApiError.unauthorized('رمز المصادقة غير صالح', 'AUTH_TOKEN_INVALID');
    }

    if (decoded.jti) {
      try {
        const isBlacklisted = await redisClient.get(CACHE_KEYS.TOKEN_BLACKLIST(decoded.jti));
        if (isBlacklisted) {
          throw ApiError.unauthorized('تم إبطال رمز المصادقة', 'AUTH_TOKEN_BLACKLISTED');
        }
      } catch (error) {
        if (error.isOperational) throw error;
      }
    }

    req.user = {
      id: decoded.sub,
      role: decoded.role,
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
