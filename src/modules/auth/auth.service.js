const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const config = require('../../config/env');
const redisClient = require('../../config/redis');
const User = require('../users/user.model');
const ApiError = require('../../utils/ApiError');
const { CACHE_KEYS, CACHE_TTL } = require('../../constants/cacheKeys');
const { ROLES } = require('../../constants/roles');
const { ACCOUNT_STATUSES } = require('../../constants/accountStatuses');
const { getEffectivePermissions } = require('../../constants/permissions');
const platformSettingsService = require('../settings/platformSettings.service');
const logger = require('../../utils/logger');

class AuthService {
  generateAccessToken(user) {
    const jti = uuidv4();
    const token = jwt.sign(
      {
        sub: String(user._id),
        role: user.role,
        authVersion: Number(user.authVersion || 0),
        jti,
      },
      config.jwt.accessSecret,
      { expiresIn: config.jwt.accessExpiresIn }
    );
    return { token, jti };
  }

  generateRefreshToken() {
    return crypto.randomBytes(40).toString('hex');
  }

  hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Compute effective permissions for a user-like object using the backend
   * authoritative permission tables.  deniedPermissions always override
   * role-defaults and extraPermissions.
   */
  _getEffectivePermissionsForUser(userLike = {}) {
    return getEffectivePermissions(
      userLike.role || ROLES.USER,
      Array.isArray(userLike.extraPermissions) ? userLike.extraPermissions : [],
      Array.isArray(userLike.deniedPermissions) ? userLike.deniedPermissions : []
    );
  }

  _buildClientUserDto(userLike) {
    const user =
      userLike && typeof userLike.toObject === 'function' ? userLike.toObject() : { ...userLike };
    const id = user?._id ? String(user._id) : user?.id ? String(user.id) : null;

    return {
      id,
      _id: id,
      fullName: user?.fullName || '',
      email: user?.email || '',
      phonePrimary: user?.phonePrimary || '',
      phoneSecondary: user?.phoneSecondary || '',
      birthDate: user?.birthDate || null,
      gender: user?.gender || '',
      role: user?.role || '',
      avatar: user?.avatar?.url ? { url: user.avatar.url } : null,
      ageGroup: user?.ageGroup || '',
      tags: Array.isArray(user?.tags) ? user.tags : [],
      address: {
        governorate: user?.address?.governorate || '',
        city: user?.address?.city || '',
        street: user?.address?.street || '',
      },
      familyName: user?.familyName || '',
      houseName: user?.houseName || '',
      accountStatus: user?.accountStatus || ACCOUNT_STATUSES.APPROVED,
      isLocked: Boolean(user?.isLocked),
      allowOthersToViewCreatedConfessionSessions:
        user?.allowOthersToViewCreatedConfessionSessions !== false,
      allowOthersToViewCreatedChats: user?.allowOthersToViewCreatedChats !== false,
      meetingIds: Array.isArray(user?.meetingIds)
        ? user.meetingIds.map((meetingId) => String(meetingId))
        : [],
      extraPermissions: Array.isArray(user?.extraPermissions) ? user.extraPermissions : [],
      deniedPermissions: Array.isArray(user?.deniedPermissions) ? user.deniedPermissions : [],
      effectivePermissions: this._getEffectivePermissionsForUser(user),
      createdAt: user?.createdAt || null,
      updatedAt: user?.updatedAt || null,
    };
  }

  async _clearUserCaches(userId) {
    try {
      await redisClient.del(CACHE_KEYS.USER_PROFILE(userId));
      await redisClient.del(CACHE_KEYS.USER_PERMISSIONS(userId));
    } catch (_error) {
      // Cache invalidation failure should not interrupt the main request path.
    }
  }

  _getNormalizedAccountStatus(userLike) {
    return userLike?.accountStatus || ACCOUNT_STATUSES.APPROVED;
  }

  _assertAccountCanAuthenticate(userLike, { requireLoginAccess = true } = {}) {
    const accountStatus = this._getNormalizedAccountStatus(userLike);

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

    if (requireLoginAccess && !userLike?.hasLogin) {
      throw ApiError.forbidden(
        'This account does not currently have permission to sign in.',
        'AUTH_NO_LOGIN_ACCESS'
      );
    }

    if (userLike?.isLocked) {
      throw ApiError.forbidden(
        `This account is locked: ${userLike.lockReason || 'Please contact an administrator'}`,
        'AUTH_ACCOUNT_LOCKED'
      );
    }
  }

  async _invalidateAllSessions(userId) {
    const user = await User.findById(userId);
    if (!user) return;

    user.authVersion = Number(user.authVersion || 0) + 1;
    await user.save();
    await this._clearUserCaches(userId);
  }

  async storeRefreshToken(userId, refreshToken, authVersion = 0) {
    const hash = this.hashToken(refreshToken);
    try {
      await redisClient.setex(
        CACHE_KEYS.REFRESH_TOKEN(hash),
        CACHE_TTL.REFRESH_TOKEN,
        JSON.stringify({
          userId: String(userId),
          authVersion: Number(authVersion || 0),
          createdAt: new Date().toISOString(),
        })
      );
    } catch (error) {
      logger.error(`Failed to persist refresh token: ${error.message}`);
      throw ApiError.serviceUnavailable(
        'Session storage is temporarily unavailable. Please try again.',
        'AUTH_SESSION_STORE_UNAVAILABLE'
      );
    }
  }

  async register({
    fullName,
    phonePrimary,
    email,
    password,
    birthDate,
    gender,
    nationalId,
    phoneSecondary,
    whatsappNumber,
    notes,
    familyName,
    houseName,
    address,
    education,
    employment,
    presence,
    health,
  }) {
    const registrationEnabled = await platformSettingsService.isRegistrationEnabled();
    if (!registrationEnabled) {
      throw ApiError.forbidden(
        'New account registration is currently disabled. Please contact an administrator.',
        'AUTH_REGISTRATION_DISABLED'
      );
    }

    const orConditions = [{ phonePrimary }];
    if (email) orConditions.push({ email });
    if (nationalId) orConditions.push({ nationalId });

    const existingUser = await User.findOne({ $or: orConditions }).lean();

    if (existingUser) {
      if (existingUser.phonePrimary === phonePrimary) {
        throw ApiError.conflict('Phone number is already registered', 'DUPLICATE_PHONE');
      }
      if (email && existingUser.email === email) {
        throw ApiError.conflict('Email address is already registered', 'DUPLICATE_EMAIL');
      }
      if (nationalId && existingUser.nationalId === nationalId) {
        throw ApiError.conflict('National ID is already registered', 'DUPLICATE_NATIONAL_ID');
      }
    }

    const user = new User({
      fullName,
      phonePrimary,
      email: email || undefined,
      birthDate,
      gender,
      nationalId: nationalId || undefined,
      phoneSecondary: phoneSecondary || undefined,
      whatsappNumber: whatsappNumber || undefined,
      notes: notes || undefined,
      familyName: familyName || undefined,
      houseName: houseName || undefined,
      address: address || undefined,
      education: education || undefined,
      employment: employment || undefined,
      presence: presence || undefined,
      health: health || undefined,
      accountStatus: ACCOUNT_STATUSES.PENDING,
      hasLogin: true,
      loginIdentifierType: email ? 'email' : 'phone',
      passwordHash: password,
      role: ROLES.USER,
    });

    await user.save();

    return {
      user: this._buildClientUserDto(user),
      accessToken: null,
      refreshToken: null,
      requiresApproval: true,
    };
  }

  async login({ identifier, password }) {
    const user = await User.findByIdentifier(identifier).select('+passwordHash');

    if (!user) {
      throw ApiError.unauthorized('Invalid credentials', 'AUTH_INVALID_CREDENTIALS');
    }

    this._assertAccountCanAuthenticate(user);

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw ApiError.unauthorized('Invalid credentials', 'AUTH_INVALID_CREDENTIALS');
    }

    user.lastLoginAt = new Date();
    await user.save();

    const { token: accessToken } = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken();
    await this.storeRefreshToken(user._id, refreshToken, user.authVersion);

    return {
      user: this._buildClientUserDto(user),
      accessToken,
      refreshToken,
      effectivePermissions: this._getEffectivePermissionsForUser(user),
    };
  }

  async refresh(refreshTokenValue) {
    if (!refreshTokenValue) {
      throw ApiError.unauthorized('Refresh token is required', 'AUTH_REFRESH_TOKEN_INVALID');
    }

    const hash = this.hashToken(refreshTokenValue);
    let stored;

    try {
      stored = await redisClient.get(CACHE_KEYS.REFRESH_TOKEN(hash));
    } catch (_error) {
      throw ApiError.serviceUnavailable(
        'Unable to verify the refresh token right now. Please try again.',
        'AUTH_SESSION_STORE_UNAVAILABLE'
      );
    }

    if (!stored) {
      throw ApiError.unauthorized(
        'Refresh token is invalid or expired',
        'AUTH_REFRESH_TOKEN_INVALID'
      );
    }

    const { userId, authVersion: storedAuthVersion = 0 } = JSON.parse(stored);

    const user = await User.findById(userId).select(
      'role authVersion isLocked lockReason isDeleted hasLogin accountStatus'
    );
    if (!user || user.isDeleted) {
      await redisClient.del(CACHE_KEYS.REFRESH_TOKEN(hash));
      throw ApiError.unauthorized('User account was not found', 'AUTH_REFRESH_TOKEN_INVALID');
    }

    if (Number(user.authVersion || 0) !== Number(storedAuthVersion || 0)) {
      await redisClient.del(CACHE_KEYS.REFRESH_TOKEN(hash));
      throw ApiError.unauthorized(
        'This session has been invalidated. Please sign in again.',
        'AUTH_SESSION_INVALIDATED'
      );
    }

    try {
      this._assertAccountCanAuthenticate(user);
    } catch (error) {
      await redisClient.del(CACHE_KEYS.REFRESH_TOKEN(hash));
      throw error;
    }

    try {
      await redisClient.del(CACHE_KEYS.REFRESH_TOKEN(hash));
    } catch (_error) {
      throw ApiError.serviceUnavailable(
        'Unable to rotate the current session. Please try again.',
        'AUTH_SESSION_STORE_UNAVAILABLE'
      );
    }

    const { token: accessToken } = this.generateAccessToken(user);
    const newRefreshToken = this.generateRefreshToken();
    await this.storeRefreshToken(user._id, newRefreshToken, user.authVersion);

    return {
      accessToken,
      refreshToken: newRefreshToken,
      effectivePermissions: this._getEffectivePermissionsForUser(user),
    };
  }

  async logout(userId, jti, refreshTokenValue) {
    let shouldInvalidateAllSessions = false;

    if (jti) {
      try {
        await redisClient.setex(
          CACHE_KEYS.TOKEN_BLACKLIST(jti),
          CACHE_TTL.TOKEN_BLACKLIST,
          '1'
        );
      } catch (error) {
        logger.error(`Failed to blacklist access token during logout: ${error.message}`);
        shouldInvalidateAllSessions = true;
      }
    }

    if (refreshTokenValue) {
      const hash = this.hashToken(refreshTokenValue);
      try {
        await redisClient.del(CACHE_KEYS.REFRESH_TOKEN(hash));
      } catch (error) {
        logger.error(`Failed to delete refresh token during logout: ${error.message}`);
        shouldInvalidateAllSessions = true;
      }
    }

    if (shouldInvalidateAllSessions) {
      await this._invalidateAllSessions(userId);
      return;
    }

    await this._clearUserCaches(userId);
  }

  async getMe(userId) {
    try {
      const cached = await redisClient.get(CACHE_KEYS.USER_PROFILE(userId));
      if (cached) return JSON.parse(cached);
    } catch (_error) {
      // Cache miss is not fatal.
    }

    const user = await User.findById(userId)
      .select([
        'fullName',
        'email',
        'phonePrimary',
        'phoneSecondary',
        'birthDate',
        'gender',
        'role',
        'avatar',
        'ageGroup',
        'tags',
        'address',
        'familyName',
        'houseName',
        'accountStatus',
        'isLocked',
        'allowOthersToViewCreatedConfessionSessions',
        'allowOthersToViewCreatedChats',
        'meetingIds',
        'extraPermissions',
        'deniedPermissions',
        'createdAt',
        'updatedAt',
      ].join(' '))
      .lean();

    if (!user) {
      throw ApiError.notFound('User account was not found', 'USER_NOT_FOUND');
    }

    const safeUser = this._buildClientUserDto(user);

    try {
      await redisClient.setex(
        CACHE_KEYS.USER_PROFILE(userId),
        CACHE_TTL.USER_PROFILE,
        JSON.stringify(safeUser)
      );
    } catch (_error) {
      // Cache write failure is not fatal.
    }

    return safeUser;
  }

  async updateMySettings(userId, data) {
    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('User account was not found', 'USER_NOT_FOUND');
    }

    const changes = [];
    if (data.allowOthersToViewCreatedConfessionSessions !== undefined) {
      const nextValue = Boolean(data.allowOthersToViewCreatedConfessionSessions);
      const previousValue = user.allowOthersToViewCreatedConfessionSessions !== false;

      if (previousValue !== nextValue) {
        changes.push({
          field: 'allowOthersToViewCreatedConfessionSessions',
          from: previousValue,
          to: nextValue,
        });
        user.allowOthersToViewCreatedConfessionSessions = nextValue;
      }
    }

    if (data.allowOthersToViewCreatedChats !== undefined) {
      const nextValue = Boolean(data.allowOthersToViewCreatedChats);
      const previousValue = user.allowOthersToViewCreatedChats !== false;

      if (previousValue !== nextValue) {
        changes.push({
          field: 'allowOthersToViewCreatedChats',
          from: previousValue,
          to: nextValue,
        });
        user.allowOthersToViewCreatedChats = nextValue;
      }
    }

    if (changes.length === 0) {
      return this._buildClientUserDto(user);
    }

    user.updatedBy = userId;
    user.changeLog.push({
      by: userId,
      action: 'Update account settings',
      changes,
    });

    await user.save();
    await this._clearUserCaches(userId);

    return this._buildClientUserDto(user);
  }

  async changePassword(userId, currentPassword, newPassword) {
    const user = await User.findById(userId).select('+passwordHash');
    if (!user) {
      throw ApiError.notFound('User account was not found', 'USER_NOT_FOUND');
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      throw ApiError.badRequest(
        'Current password is incorrect',
        'AUTH_INVALID_CREDENTIALS'
      );
    }

    user.passwordHash = newPassword;
    user.authVersion = Number(user.authVersion || 0) + 1;

    user.changeLog.push({
      by: userId,
      action: 'Change password',
      changes: [{ field: 'passwordHash', from: '[SECURED]', to: '[SECURED]' }],
    });

    await user.save();
    await this._clearUserCaches(userId);
  }
}

module.exports = new AuthService();
