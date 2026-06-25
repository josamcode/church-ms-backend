/**
 * P0 Regression Tests — Auth / Session Lifecycle
 *
 * 1. refresh_token_rotation_rejects_old_token
 * 2. locked_user_cannot_use_old_access_token
 * 3. pending_user_cannot_login
 * 4. rejected_user_cannot_login
 * 5. no_login_user_cannot_login
 * 6. auth_version_change_invalidates_existing_access_token
 * 7. deleted_or_soft_deleted_user_cannot_use_existing_access_token
 * 8. super_admin_sensitive_update_rules_still_pass (_existing tests)
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { ROLES } = require('../../src/constants/roles');
const { ACCOUNT_STATUSES } = require('../../src/constants/accountStatuses');

const ACCESS_SECRET = 'development_only_access_secret_change_before_production_123456';

// ═══════════════════════════════════════════════════════════════
//  jest.mock factories — ALL helpers/variables used inside a
//  factory must be DEFINED inside that same factory.
//  No outer-scope variables (except jest globals) are available
//  due to Jest's mock hoisting.
// ═══════════════════════════════════════════════════════════════

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../src/config/env', () => ({
  env: 'test',
  isProduction: false,
  isDevelopmentLike: true,
  port: 5000,
  mongo: { uri: 'mongodb://localhost:27017/church-test' },
  redis: { enabled: false, required: false },
  r2: { enabled: false, required: false },
  jwt: {
    accessSecret: 'development_only_access_secret_change_before_production_123456',
    refreshSecret: 'development_only_refresh_secret_change_before_production_123456',
    accessExpiresIn: '15m',
    refreshExpiresIn: '7d',
    refreshExpiresInMs: 7 * 24 * 60 * 60 * 1000,
  },
  cors: { origin: '', allowedOrigins: [], credentials: false },
  docs: { enabled: false },
  http: { trustProxy: false },
  site: { name: 'Test', tagline: '' },
  mail: { enabled: false },
  rateLimit: { windowMs: 900000, max: 1000 },
  upload: { maxFileSize: 5 * 1024 * 1024 },
  push: { enabled: false },
  cache: { userTTL: 3600, permissionsTTL: 1800 },
  aidReminders: { pollIntervalMs: 3600000 },
  meetingReminders: { pollIntervalMs: 60000 },
  backup: { enabled: false },
}));

jest.mock('../../src/modules/settings/platformSettings.service', () => ({
  isRegistrationEnabled: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../src/config/redis', () => {
  const store = new Map();
  return {
    get: jest.fn().mockImplementation(async (key) => store.get(String(key)) || null),
    setex: jest.fn().mockImplementation(async (key, _ttl, value) => {
      store.set(String(key), String(value)); return 'OK';
    }),
    del: jest.fn().mockImplementation(async (...keys) => {
      let c = 0; for (const k of keys.flat()) { if (store.delete(String(k))) c++; } return c;
    }),
    set: jest.fn().mockImplementation(async (key, value) => {
      store.set(String(key), String(value)); return 'OK';
    }),
    ping: jest.fn().mockResolvedValue('PONG'),
    isFallback: false, status: 'ready',
    on: jest.fn(), call: jest.fn(),
    ensureRedisReady: jest.fn().mockResolvedValue(undefined),
    _clearStore: () => store.clear(),
  };
});

jest.mock('../../src/modules/users/user.model', () => {
  // All helpers defined inside the factory
  function mockChainable(resolvedValue) {
    return {
      lean: jest.fn().mockResolvedValue(resolvedValue),
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
    };
  }

  const store = new Map();
  let idCounter = 0;
  function newId() { idCounter++; return 'mock-user-' + idCounter; }

  const MockUserModel = function (data = {}) {
    this._id = data._id || newId();
    this.fullName = data.fullName || 'Test User';
    this.email = data.email || '';
    this.phonePrimary = data.phonePrimary || '01000000000';
    this.birthDate = data.birthDate || new Date('1990-01-01');
    this.gender = data.gender || 'male';
    this.role = data.role || 'USER';
    this.avatar = data.avatar || null;
    this.ageGroup = data.ageGroup || 'adult';
    this.tags = data.tags || [];
    this.address = data.address || { governorate: '', city: '', street: '' };
    this.familyName = data.familyName || '';
    this.houseName = data.houseName || '';
    this.accountStatus = data.accountStatus || 'approved';
    this.isLocked = data.isLocked !== undefined ? data.isLocked : false;
    this.lockReason = data.lockReason || undefined;
    this.hasLogin = data.hasLogin !== undefined ? data.hasLogin : true;
    this.isDeleted = data.isDeleted !== undefined ? data.isDeleted : false;
    this.authVersion = data.authVersion || 0;
    this.passwordHash = data.passwordHash || '$2a$12$testhashedpasswordvalue';
    this.extraPermissions = data.extraPermissions || [];
    this.deniedPermissions = data.deniedPermissions || [];
    this.allowOthersToViewCreatedConfessionSessions = data.allowOthersToViewCreatedConfessionSessions !== false;
    this.allowOthersToViewCreatedChats = data.allowOthersToViewCreatedChats !== false;
    this.meetingIds = data.meetingIds || [];
    this.nationalId = data.nationalId || undefined;
    this.loginIdentifierType = data.loginIdentifierType || 'phone';
    this.lastLoginAt = data.lastLoginAt || null;
    this.changeLog = data.changeLog || [];
    this.createdAt = data.createdAt || new Date();
    this.updatedAt = data.updatedAt || new Date();
    this.notes = data.notes || '';
    this.confessionFatherName = data.confessionFatherName || undefined;
    this.confessionFatherUserId = data.confessionFatherUserId || undefined;
    this.confessionSessionIds = data.confessionSessionIds || [];
    this.customDetails = data.customDetails || {};

    this.save = jest.fn().mockImplementation(async () => {
      store.set(String(this._id), this); return this;
    });
    this.toObject = jest.fn().mockReturnValue({ ...this, passwordHash: undefined, authVersion: this.authVersion });
    this.toSafeObject = jest.fn().mockReturnValue({ ...this, passwordHash: undefined, authVersion: this.authVersion });
    this.comparePassword = jest.fn().mockImplementation(async (candidate) => {
      return candidate === 'correct-password';
    });

    store.set(String(this._id), this);
  };

  MockUserModel.findById = jest.fn().mockImplementation(
    (id) => mockChainable(store.get(String(id)) || null)
  );
  MockUserModel.findOne = jest.fn().mockReturnValue(mockChainable(null));
  MockUserModel.findByIdentifier = jest.fn();
  MockUserModel.find = jest.fn().mockReturnValue(mockChainable([]));
  MockUserModel.countDocuments = jest.fn().mockResolvedValue(0);
  MockUserModel.aggregate = jest.fn().mockReturnValue(mockChainable([]));
  MockUserModel.distinct = jest.fn().mockResolvedValue([]);
  MockUserModel._clearStore = () => store.clear();

  return MockUserModel;
});

// ═══════════════════════════════════════════════════════════════

describe('Auth Session Lifecycle', () => {
  let authService;
  let authenticateJWT;
  let UserModel;
  let redisMod;

  beforeAll(() => {
    authService = require('../../src/modules/auth/auth.service');
    authenticateJWT = require('../../src/middlewares/auth').authenticateJWT;
    UserModel = require('../../src/modules/users/user.model');
    redisMod = require('../../src/config/redis');
  });

  beforeEach(() => {
    if (redisMod._clearStore) redisMod._clearStore();
    if (UserModel._clearStore) UserModel._clearStore();
    jest.clearAllMocks();
  });

  // ── Helpers ──
  function signAccessToken(userData = {}) {
    return jwt.sign(
      {
        sub: String(userData._id || new mongoose.Types.ObjectId()),
        role: userData.role || ROLES.USER,
        authVersion: userData.authVersion || 0,
        jti: userData.jti || 'test-jti-' + Math.random().toString(36).slice(2),
      },
      ACCESS_SECRET,
      { expiresIn: '15m' }
    );
  }

  function mockReq(token) {
    return { headers: { authorization: token ? `Bearer ${token}` : undefined } };
  }
  function mockRes() {
    return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  }
  function mockFindByIdentifier(userDoc) {
    // login() calls: await User.findByIdentifier(id).select('+passwordHash')
    // Mongoose Query is thenable — select returns a Query, await triggers exec.
    // Our mock must be thenable so that `await` resolves to the userDoc.
    const thenable = {
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(userDoc),
      then: (resolve) => resolve(userDoc),
    };
    UserModel.findByIdentifier.mockReturnValue(thenable);
  }
  function mockFindById(userDoc) {
    // Mongoose findById returns a Query which is thenable.
    // `await Model.findById(id).select(...)` must resolve to the document.
    const thenable = {
      lean: jest.fn().mockResolvedValue(userDoc),
      select: jest.fn().mockReturnThis(),
      then: (resolve) => resolve(userDoc),
    };
    UserModel.findById.mockImplementation((_id) => thenable);
  }

  function defaultUserDoc(overrides = {}) {
    return {
      _id: overrides._id || new mongoose.Types.ObjectId(),
      role: overrides.role || ROLES.USER,
      authVersion: overrides.authVersion !== undefined ? overrides.authVersion : 0,
      isLocked: overrides.isLocked !== undefined ? overrides.isLocked : false,
      lockReason: overrides.lockReason || undefined,
      isDeleted: overrides.isDeleted !== undefined ? overrides.isDeleted : false,
      hasLogin: overrides.hasLogin !== undefined ? overrides.hasLogin : true,
      accountStatus: overrides.accountStatus || ACCOUNT_STATUSES.APPROVED,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  1. refresh_token_rotation_rejects_old_token
  // ═══════════════════════════════════════════════════════════════
  describe('refresh_token_rotation_rejects_old_token', () => {
    it('should reject the old refresh token after a successful rotation', async () => {
      const userId = new mongoose.Types.ObjectId();
      const userDoc = new UserModel({
        _id: userId, role: ROLES.USER, authVersion: 0,
        hasLogin: true, accountStatus: ACCOUNT_STATUSES.APPROVED,
      });
      userDoc.comparePassword = jest.fn().mockResolvedValue(true);

      mockFindByIdentifier(userDoc);
      mockFindById(userDoc);

      const loginResult = await authService.login({
        identifier: '01000000000', password: 'correct-password',
      });
      expect(loginResult.refreshToken).toBeTruthy();

      const refreshResult = await authService.refresh(loginResult.refreshToken);
      expect(refreshResult.refreshToken).toBeTruthy();
      expect(refreshResult.refreshToken).not.toBe(loginResult.refreshToken);

      mockFindById(userDoc);
      await expect(
        authService.refresh(loginResult.refreshToken)
      ).rejects.toThrow('invalid or expired');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  2. locked_user_cannot_use_old_access_token
  // ═══════════════════════════════════════════════════════════════
  describe('locked_user_cannot_use_old_access_token', () => {
    it('should reject access when user is locked after token issuance', async () => {
      const userId = new mongoose.Types.ObjectId();
      mockFindById(defaultUserDoc({
        _id: userId, isLocked: true, lockReason: 'Suspicious activity',
      }));

      const token = signAccessToken({ _id: userId });
      const next = jest.fn();
      await authenticateJWT(mockReq(token), mockRes(), next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('locked') })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  3. pending_user_cannot_login
  // ═══════════════════════════════════════════════════════════════
  describe('pending_user_cannot_login', () => {
    it('should reject login when account status is PENDING', async () => {
      const userDoc = new UserModel({
        accountStatus: ACCOUNT_STATUSES.PENDING, hasLogin: true,
      });
      userDoc.comparePassword = jest.fn().mockResolvedValue(true);
      mockFindByIdentifier(userDoc);

      await expect(
        authService.login({ identifier: '01000000000', password: 'correct-password' })
      ).rejects.toThrow('pending approval');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  4. rejected_user_cannot_login
  // ═══════════════════════════════════════════════════════════════
  describe('rejected_user_cannot_login', () => {
    it('should reject login when account status is REJECTED', async () => {
      const userDoc = new UserModel({
        accountStatus: ACCOUNT_STATUSES.REJECTED, hasLogin: true,
      });
      userDoc.comparePassword = jest.fn().mockResolvedValue(true);
      mockFindByIdentifier(userDoc);

      await expect(
        authService.login({ identifier: '01000000000', password: 'correct-password' })
      ).rejects.toThrow('rejected');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  5. no_login_user_cannot_login
  // ═══════════════════════════════════════════════════════════════
  describe('no_login_user_cannot_login', () => {
    it('should reject login when hasLogin=false', async () => {
      const userDoc = new UserModel({
        accountStatus: ACCOUNT_STATUSES.APPROVED, hasLogin: false,
      });
      userDoc.comparePassword = jest.fn().mockResolvedValue(true);
      mockFindByIdentifier(userDoc);

      await expect(
        authService.login({ identifier: '01000000000', password: 'correct-password' })
      ).rejects.toThrow('does not currently have permission to sign in');
    });

    it('should reject middleware access when hasLogin=false', async () => {
      const userId = new mongoose.Types.ObjectId();
      mockFindById(defaultUserDoc({ _id: userId, hasLogin: false }));

      const token = signAccessToken({ _id: userId });
      const next = jest.fn();
      await authenticateJWT(mockReq(token), mockRes(), next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'AUTH_NO_LOGIN_ACCESS' })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  6. auth_version_change_invalidates_existing_access_token
  // ═══════════════════════════════════════════════════════════════
  describe('auth_version_change_invalidates_existing_access_token', () => {
    it('should reject access token when authVersion differs', async () => {
      const userId = new mongoose.Types.ObjectId();
      mockFindById(defaultUserDoc({ _id: userId, authVersion: 2 }));

      const token = signAccessToken({ _id: userId, authVersion: 0 });
      const next = jest.fn();
      await authenticateJWT(mockReq(token), mockRes(), next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'AUTH_SESSION_INVALIDATED' })
      );
    });

    it('should accept token when authVersion matches', async () => {
      const userId = new mongoose.Types.ObjectId();
      mockFindById(defaultUserDoc({ _id: userId, authVersion: 3 }));

      const token = signAccessToken({ _id: userId, authVersion: 3 });
      const req = mockReq(token);
      const next = jest.fn();
      await authenticateJWT(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith(); // no error
      expect(req.user).toBeDefined();
      expect(req.user.id).toBe(String(userId));
      expect(req.user.role).toBe(ROLES.USER);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  7. deleted_or_soft_deleted_user_cannot_use_existing_access_token
  // ═══════════════════════════════════════════════════════════════
  describe('deleted_or_soft_deleted_user_cannot_use_existing_access_token', () => {
    it('should reject access token when user is soft-deleted', async () => {
      const userId = new mongoose.Types.ObjectId();
      mockFindById(defaultUserDoc({ _id: userId, isDeleted: true }));

      const token = signAccessToken({ _id: userId });
      const next = jest.fn();
      await authenticateJWT(mockReq(token), mockRes(), next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'AUTH_TOKEN_INVALID' })
      );
    });

    it('should reject access token when user does not exist', async () => {
      const userId = new mongoose.Types.ObjectId();
      mockFindById(null);

      const token = signAccessToken({ _id: userId });
      const next = jest.fn();
      await authenticateJWT(mockReq(token), mockRes(), next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'AUTH_TOKEN_INVALID' })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  _assertAccountCanAuthenticate exhaustive
  // ═══════════════════════════════════════════════════════════════
  describe('_assertAccountCanAuthenticate', () => {
    it('should pass for an active APPROVED user with hasLogin=true', () => {
      expect(() =>
        authService._assertAccountCanAuthenticate({
          accountStatus: ACCOUNT_STATUSES.APPROVED, hasLogin: true, isLocked: false,
        })
      ).not.toThrow();
    });

    it('should reject PENDING with AUTH_ACCOUNT_PENDING', () => {
      try {
        authService._assertAccountCanAuthenticate({
          accountStatus: ACCOUNT_STATUSES.PENDING, hasLogin: true, isLocked: false,
        });
        fail('Expected error');
      } catch (err) {
        expect(err.errorCode).toBe('AUTH_ACCOUNT_PENDING');
        expect(err.statusCode).toBe(403);
      }
    });

    it('should reject REJECTED with AUTH_ACCOUNT_REJECTED', () => {
      try {
        authService._assertAccountCanAuthenticate({
          accountStatus: ACCOUNT_STATUSES.REJECTED, hasLogin: true, isLocked: false,
        });
        fail('Expected error');
      } catch (err) {
        expect(err.errorCode).toBe('AUTH_ACCOUNT_REJECTED');
        expect(err.statusCode).toBe(403);
      }
    });

    it('should reject no-login with AUTH_NO_LOGIN_ACCESS', () => {
      try {
        authService._assertAccountCanAuthenticate({
          accountStatus: ACCOUNT_STATUSES.APPROVED, hasLogin: false, isLocked: false,
        });
        fail('Expected error');
      } catch (err) {
        expect(err.errorCode).toBe('AUTH_NO_LOGIN_ACCESS');
      }
    });

    it('should reject locked with AUTH_ACCOUNT_LOCKED', () => {
      try {
        authService._assertAccountCanAuthenticate({
          accountStatus: ACCOUNT_STATUSES.APPROVED, hasLogin: true, isLocked: true,
          lockReason: 'Test lock',
        });
        fail('Expected error');
      } catch (err) {
        expect(err.errorCode).toBe('AUTH_ACCOUNT_LOCKED');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  Refresh token invalidation on account state changes
  // ═══════════════════════════════════════════════════════════════
  describe('refresh_token_rejected_when_account_becomes_invalid', () => {
    it('should reject refresh when user becomes locked', async () => {
      const userId = new mongoose.Types.ObjectId();
      const userDoc = new UserModel({
        _id: userId, role: ROLES.USER, authVersion: 0,
        hasLogin: true, accountStatus: ACCOUNT_STATUSES.APPROVED,
      });
      userDoc.comparePassword = jest.fn().mockResolvedValue(true);

      mockFindByIdentifier(userDoc);
      mockFindById(userDoc);

      const loginResult = await authService.login({
        identifier: '01000000000', password: 'correct-password',
      });

      userDoc.isLocked = true;
      userDoc.lockReason = 'Security concern';
      mockFindById(userDoc);

      await expect(
        authService.refresh(loginResult.refreshToken)
      ).rejects.toThrow('locked');
    });

    it('should reject refresh when authVersion changes', async () => {
      const userId = new mongoose.Types.ObjectId();
      const userDoc = new UserModel({
        _id: userId, role: ROLES.USER, authVersion: 0,
        hasLogin: true, accountStatus: ACCOUNT_STATUSES.APPROVED,
      });
      userDoc.comparePassword = jest.fn().mockResolvedValue(true);

      mockFindByIdentifier(userDoc);
      mockFindById(userDoc);

      const loginResult = await authService.login({
        identifier: '01000000000', password: 'correct-password',
      });

      userDoc.authVersion = 1;
      mockFindById(userDoc);

      await expect(
        authService.refresh(loginResult.refreshToken)
      ).rejects.toThrow('session has been invalidated');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  effectivePermissions in auth responses
  // ═══════════════════════════════════════════════════════════════
  describe('backend login returns effectivePermissions', () => {
    it('should include effectivePermissions at the top level of login response', async () => {
      const userId = new mongoose.Types.ObjectId();
      const userDoc = new UserModel({
        _id: userId, role: 'ADMIN', authVersion: 0,
        hasLogin: true, accountStatus: 'approved',
        extraPermissions: [], deniedPermissions: [],
      });
      userDoc.comparePassword = jest.fn().mockResolvedValue(true);
      mockFindByIdentifier(userDoc);
      mockFindById(userDoc);

      const result = await authService.login({
        identifier: '01000000000', password: 'correct-password',
      });

      expect(result.effectivePermissions).toBeDefined();
      expect(Array.isArray(result.effectivePermissions)).toBe(true);
      // ADMIN should have HOUSEHOLD_CLASSIFICATIONS_MANAGE per backend role table
      expect(result.effectivePermissions).toContain('HOUSEHOLD_CLASSIFICATIONS_MANAGE');
      // ADMIN should have common admin permissions
      expect(result.effectivePermissions).toContain('USERS_VIEW');
      expect(result.effectivePermissions).toContain('USERS_CREATE');
    });
  });

  describe('backend me/current-user returns effectivePermissions', () => {
    it('should include effectivePermissions in the /me user object', async () => {
      const userId = new mongoose.Types.ObjectId();
      const userDoc = new UserModel({
        _id: userId, role: 'USER', authVersion: 0,
        hasLogin: true, accountStatus: 'approved',
        extraPermissions: [], deniedPermissions: [],
      });
      mockFindById(userDoc);

      const result = await authService.getMe(String(userId));

      expect(result.effectivePermissions).toBeDefined();
      expect(Array.isArray(result.effectivePermissions)).toBe(true);
      // USER should have self-permissions
      expect(result.effectivePermissions).toContain('AUTH_VIEW_SELF');
      expect(result.effectivePermissions).toContain('USERS_VIEW_SELF');
      // USER should NOT have admin permissions
      expect(result.effectivePermissions).not.toContain('USERS_CREATE');
      expect(result.effectivePermissions).not.toContain('USERS_DELETE');
    });
  });

  describe('backend refresh returns effectivePermissions', () => {
    it('should include effectivePermissions in the refresh response', async () => {
      const userId = new mongoose.Types.ObjectId();
      const userDoc = new UserModel({
        _id: userId, role: 'USER', authVersion: 0,
        hasLogin: true, accountStatus: 'approved',
        extraPermissions: [], deniedPermissions: [],
      });
      userDoc.comparePassword = jest.fn().mockResolvedValue(true);
      mockFindByIdentifier(userDoc);
      mockFindById(userDoc);

      const loginResult = await authService.login({
        identifier: '01000000000', password: 'correct-password',
      });

      mockFindById(userDoc);
      const refreshResult = await authService.refresh(loginResult.refreshToken);

      expect(refreshResult.effectivePermissions).toBeDefined();
      expect(Array.isArray(refreshResult.effectivePermissions)).toBe(true);
      expect(refreshResult.effectivePermissions).toContain('AUTH_VIEW_SELF');
    });
  });

  describe('deniedPermissions override role defaults and extraPermissions', () => {
    it('should remove a role-default permission when it appears in deniedPermissions', async () => {
      const userId = new mongoose.Types.ObjectId();
      const userDoc = new UserModel({
        _id: userId, role: 'ADMIN', authVersion: 0,
        hasLogin: true, accountStatus: 'approved',
        extraPermissions: ['HOUSEHOLD_CLASSIFICATIONS_MANAGE'],
        deniedPermissions: ['USERS_CREATE', 'USERS_DELETE'],
      });
      mockFindById(userDoc);

      const result = await authService.getMe(String(userId));

      // deniedPermissions should strip USERS_CREATE and USERS_DELETE
      expect(result.effectivePermissions).not.toContain('USERS_CREATE');
      expect(result.effectivePermissions).not.toContain('USERS_DELETE');
      // but other ADMIN permissions should remain
      expect(result.effectivePermissions).toContain('USERS_VIEW');
      expect(result.effectivePermissions).toContain('HOUSEHOLD_CLASSIFICATIONS_MANAGE');
    });

    it('should strip extraPermissions when denied', async () => {
      const userId = new mongoose.Types.ObjectId();
      const userDoc = new UserModel({
        _id: userId, role: 'USER', authVersion: 0,
        hasLogin: true, accountStatus: 'approved',
        extraPermissions: ['USERS_VIEW', 'MEETINGS_VIEW'],
        deniedPermissions: ['USERS_VIEW'],
      });
      mockFindById(userDoc);

      const result = await authService.getMe(String(userId));

      // denied USERS_VIEW — should be gone even though in extraPermissions
      expect(result.effectivePermissions).not.toContain('USERS_VIEW');
      // MEETINGS_VIEW should still be there
      expect(result.effectivePermissions).toContain('MEETINGS_VIEW');
    });
  });
});
