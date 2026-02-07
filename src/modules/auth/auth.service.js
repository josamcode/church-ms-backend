const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const config = require('../../config/env');
const redisClient = require('../../config/redis');
const User = require('../users/user.model');
const ApiError = require('../../utils/ApiError');
const { CACHE_KEYS, CACHE_TTL } = require('../../constants/cacheKeys');
const { ROLES } = require('../../constants/roles');
const logger = require('../../utils/logger');

class AuthService {
  /**
   * توليد رمز الوصول (Access Token)
   */
  generateAccessToken(user) {
    const jti = uuidv4();
    const token = jwt.sign(
      {
        sub: String(user._id),
        role: user.role,
        jti,
      },
      config.jwt.accessSecret,
      { expiresIn: config.jwt.accessExpiresIn }
    );
    return { token, jti };
  }

  /**
   * توليد رمز التحديث (Refresh Token)
   */
  generateRefreshToken() {
    return crypto.randomBytes(40).toString('hex');
  }

  /**
   * تشفير رمز التحديث للتخزين
   */
  hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * تخزين رمز التحديث في Redis
   */
  async storeRefreshToken(userId, refreshToken) {
    const hash = this.hashToken(refreshToken);
    try {
      await redisClient.setex(
        CACHE_KEYS.REFRESH_TOKEN(hash),
        CACHE_TTL.REFRESH_TOKEN,
        JSON.stringify({
          userId: String(userId),
          createdAt: new Date().toISOString(),
        })
      );
    } catch (err) {
      logger.error(`فشل تخزين رمز التحديث: ${err.message}`);
    }
  }

  /**
   * تسجيل مستخدم جديد
   */
  async register({ fullName, phonePrimary, email, password, birthDate, gender }) {
    const orConditions = [{ phonePrimary }];
    if (email) orConditions.push({ email });

    const existingUser = await User.findOne({ $or: orConditions }).lean();

    if (existingUser) {
      if (existingUser.phonePrimary === phonePrimary) {
        throw ApiError.conflict('رقم الهاتف مسجل مسبقاً', 'DUPLICATE_PHONE');
      }
      if (email && existingUser.email === email) {
        throw ApiError.conflict('البريد الإلكتروني مسجل مسبقاً', 'DUPLICATE_EMAIL');
      }
    }

    const user = new User({
      fullName,
      phonePrimary,
      email: email || undefined,
      birthDate,
      gender,
      hasLogin: true,
      loginIdentifierType: email ? 'email' : 'phone',
      passwordHash: password,
      role: ROLES.USER,
    });

    await user.save();

    const { token: accessToken } = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken();
    await this.storeRefreshToken(user._id, refreshToken);

    return {
      user: user.toSafeObject(),
      accessToken,
      refreshToken,
    };
  }

  /**
   * تسجيل الدخول
   */
  async login({ identifier, password }) {
    const user = await User.findOne({
      $or: [{ phonePrimary: identifier }, { email: identifier }],
    }).select('+passwordHash');

    if (!user) {
      throw ApiError.unauthorized('بيانات الدخول غير صحيحة', 'AUTH_INVALID_CREDENTIALS');
    }

    if (!user.hasLogin) {
      throw ApiError.forbidden(
        'هذا الحساب لا يملك صلاحية تسجيل الدخول',
        'AUTH_NO_LOGIN_ACCESS'
      );
    }

    if (user.isLocked) {
      throw ApiError.forbidden(
        `الحساب مغلق: ${user.lockReason || 'يرجى التواصل مع المسؤول'}`,
        'AUTH_ACCOUNT_LOCKED'
      );
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw ApiError.unauthorized('بيانات الدخول غير صحيحة', 'AUTH_INVALID_CREDENTIALS');
    }

    user.lastLoginAt = new Date();
    await user.save();

    const { token: accessToken } = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken();
    await this.storeRefreshToken(user._id, refreshToken);

    return {
      user: user.toSafeObject(),
      accessToken,
      refreshToken,
    };
  }

  /**
   * تحديث الجلسة (Refresh)
   */
  async refresh(refreshTokenValue) {
    if (!refreshTokenValue) {
      throw ApiError.unauthorized('رمز التحديث مطلوب', 'AUTH_REFRESH_TOKEN_INVALID');
    }

    const hash = this.hashToken(refreshTokenValue);
    let stored;

    try {
      stored = await redisClient.get(CACHE_KEYS.REFRESH_TOKEN(hash));
    } catch (err) {
      throw ApiError.internal('خطأ في التحقق من رمز التحديث');
    }

    if (!stored) {
      throw ApiError.unauthorized(
        'رمز التحديث غير صالح أو منتهي الصلاحية',
        'AUTH_REFRESH_TOKEN_INVALID'
      );
    }

    const { userId } = JSON.parse(stored);

    const user = await User.findById(userId);
    if (!user || user.isDeleted) {
      await redisClient.del(CACHE_KEYS.REFRESH_TOKEN(hash));
      throw ApiError.unauthorized('المستخدم غير موجود', 'AUTH_REFRESH_TOKEN_INVALID');
    }

    if (user.isLocked) {
      await redisClient.del(CACHE_KEYS.REFRESH_TOKEN(hash));
      throw ApiError.forbidden('الحساب مغلق', 'AUTH_ACCOUNT_LOCKED');
    }

    // Rotate: delete old, create new
    await redisClient.del(CACHE_KEYS.REFRESH_TOKEN(hash));

    const { token: accessToken } = this.generateAccessToken(user);
    const newRefreshToken = this.generateRefreshToken();
    await this.storeRefreshToken(user._id, newRefreshToken);

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  /**
   * تسجيل الخروج
   */
  async logout(userId, jti, refreshTokenValue) {
    // Blacklist the access token for its remaining TTL
    if (jti) {
      try {
        await redisClient.setex(
          CACHE_KEYS.TOKEN_BLACKLIST(jti),
          CACHE_TTL.TOKEN_BLACKLIST,
          '1'
        );
      } catch (err) {
        logger.warn(`فشل إضافة الرمز للقائمة السوداء: ${err.message}`);
      }
    }

    // Remove refresh token
    if (refreshTokenValue) {
      const hash = this.hashToken(refreshTokenValue);
      try {
        await redisClient.del(CACHE_KEYS.REFRESH_TOKEN(hash));
      } catch (err) {
        logger.warn(`فشل حذف رمز التحديث: ${err.message}`);
      }
    }

    // Clear user caches
    try {
      await redisClient.del(CACHE_KEYS.USER_PROFILE(userId));
      await redisClient.del(CACHE_KEYS.USER_PERMISSIONS(userId));
    } catch (err) {
      logger.warn(`فشل مسح ذاكرة التخزين المؤقت: ${err.message}`);
    }
  }

  /**
   * جلب بيانات المستخدم الحالي
   */
  async getMe(userId) {
    try {
      const cached = await redisClient.get(CACHE_KEYS.USER_PROFILE(userId));
      if (cached) return JSON.parse(cached);
    } catch (err) {
      // Cache miss
    }

    const user = await User.findById(userId)
      .select('-changeLog -__v')
      .lean();

    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    try {
      await redisClient.setex(
        CACHE_KEYS.USER_PROFILE(userId),
        CACHE_TTL.USER_PROFILE,
        JSON.stringify(user)
      );
    } catch (err) {
      // Cache write failure
    }

    return user;
  }

  /**
   * تغيير كلمة المرور
   */
  async changePassword(userId, currentPassword, newPassword) {
    const user = await User.findById(userId).select('+passwordHash');
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      throw ApiError.badRequest(
        'كلمة المرور الحالية غير صحيحة',
        'AUTH_INVALID_CREDENTIALS'
      );
    }

    user.passwordHash = newPassword;

    user.changeLog.push({
      by: userId,
      action: 'تغيير كلمة المرور',
      changes: [{ field: 'passwordHash', from: '[محمي]', to: '[محمي]' }],
    });

    await user.save();

    // Clear caches
    try {
      await redisClient.del(CACHE_KEYS.USER_PROFILE(userId));
    } catch (err) {
      // Non-fatal
    }
  }
}

module.exports = new AuthService();
