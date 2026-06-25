/**
 * P0 Regression Tests — User Role Escalation
 *
 * - admin_cannot_promote_user_to_admin_without_super_admin
 * - admin_cannot_enable_login_for_other_user_without_sensitive_permission
 * - super_admin_can_perform_sensitive_user_update
 */

jest.mock('../../src/config/redis', () => ({
  get: jest.fn().mockResolvedValue(null),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  isFallback: true,
  status: 'ready',
  on: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/services/storage/storage.service', () => ({
  uploadFile: jest.fn(),
  deleteFile: jest.fn(),
}));

const mongoose = require('mongoose');
const { ROLES } = require('../../src/constants/roles');
const { PERMISSIONS } = require('../../src/constants/permissions');
const { ACCOUNT_STATUSES } = require('../../src/constants/accountStatuses');
const ApiError = require('../../src/utils/ApiError');

describe('User Role Escalation — _isChangingSensitiveAuthFields', () => {
  let userService;

  beforeAll(() => {
    userService = require('../../src/modules/users/user.service');
  });

  describe('role promotion', () => {
    it('should flag promoting USER to ADMIN as sensitive', () => {
      const target = { role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { role: ROLES.ADMIN },
        target
      );
      expect(result).toBe(true);
    });

    it('should flag promoting USER to SUPER_ADMIN as sensitive', () => {
      const target = { role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { role: ROLES.SUPER_ADMIN },
        target
      );
      expect(result).toBe(true);
    });

    it('should flag downgrading ADMIN to USER as sensitive', () => {
      const target = { role: ROLES.ADMIN };
      const result = userService._isChangingSensitiveAuthFields(
        { role: ROLES.USER },
        target
      );
      expect(result).toBe(true);
    });

    it('should NOT flag keeping USER as USER as sensitive', () => {
      const target = { role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { role: ROLES.USER },
        target
      );
      expect(result).toBe(false);
    });
  });

  describe('login and password', () => {
    it('should flag enabling login for a user without login as sensitive', () => {
      const target = { hasLogin: false, role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { hasLogin: true },
        target
      );
      expect(result).toBe(true);
    });

    it('should flag setting a password as sensitive', () => {
      const target = { hasLogin: true, role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { password: 'NewPass123!' },
        target
      );
      expect(result).toBe(true);
    });

    it('should NOT flag setting hasLogin to false as sensitive', () => {
      const target = { hasLogin: true, role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { hasLogin: false },
        target
      );
      expect(result).toBe(false);
    });

    it('should NOT flag disabling login with no change as sensitive', () => {
      const target = { hasLogin: false, role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { hasLogin: false },
        target
      );
      expect(result).toBe(false);
    });
  });

  describe('account status', () => {
    it('should flag changing account status as sensitive', () => {
      const target = { accountStatus: ACCOUNT_STATUSES.APPROVED, role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { accountStatus: ACCOUNT_STATUSES.REJECTED },
        target
      );
      expect(result).toBe(true);
    });
  });

  describe('permission overrides', () => {
    it('should flag changing extraPermissions as sensitive', () => {
      const target = { role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { extraPermissions: [PERMISSIONS.USERS_VIEW] },
        target
      );
      expect(result).toBe(true);
    });

    it('should flag changing deniedPermissions as sensitive', () => {
      const target = { role: ROLES.USER };
      const result = userService._isChangingSensitiveAuthFields(
        { deniedPermissions: [PERMISSIONS.USERS_VIEW] },
        target
      );
      expect(result).toBe(true);
    });
  });

  describe('super_admin target', () => {
    it('should flag any modification to SUPER_ADMIN user as sensitive', () => {
      const target = { role: ROLES.SUPER_ADMIN };
      const result = userService._isChangingSensitiveAuthFields(
        { fullName: 'New Name' },
        target
      );
      expect(result).toBe(true);
    });
  });

  describe('non-sensitive fields', () => {
    it('should NOT flag updating fullName or phone as sensitive', () => {
      const target = { role: ROLES.USER, hasLogin: true, accountStatus: ACCOUNT_STATUSES.APPROVED };
      const result = userService._isChangingSensitiveAuthFields(
        { fullName: 'New Name', phonePrimary: '01000000000' },
        target
      );
      expect(result).toBe(false);
    });
  });
});

describe('User Role Escalation — createUser & updateUser guards', () => {
  let userService;
  let mockFindById;

  beforeEach(() => {
    jest.resetModules();

    // Mock the User model — findById must support chaining .select().lean()
    let resolvedActor = null;
    mockFindById = jest.fn().mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockImplementation(() => Promise.resolve(resolvedActor)),
    }));
    // Allow tests to set the actor that findById resolves to
    mockFindById._setActor = (actor) => { resolvedActor = actor; };

    jest.mock('../../src/modules/users/user.model', () => {
      const mockModel = function (data) {
        Object.assign(this, data);
        this.save = jest.fn().mockResolvedValue(this);
        this.toSafeObject = function () { return { ...this }; };
        this.toObject = function () { return { ...this }; };
      };
      mockModel.findById = mockFindById;
      mockModel.findOne = jest.fn().mockReturnThis();
      mockModel.find = jest.fn().mockReturnThis();
      mockModel.countDocuments = jest.fn();
      mockModel.aggregate = jest.fn().mockReturnThis();
      mockModel.distinct = jest.fn();
      mockModel.sort = jest.fn().mockReturnThis();
      mockModel.select = jest.fn().mockReturnThis();
      mockModel.lean = jest.fn();
      mockModel.skip = jest.fn().mockReturnThis();
      mockModel.limit = jest.fn().mockReturnThis();
      mockModel.exec = jest.fn().mockResolvedValue([]);
      mockModel.insertMany = jest.fn();
      mockModel.deleteMany = jest.fn();
      return mockModel;
    });

    // Must re-require service after mocking model
    userService = require('../../src/modules/users/user.service');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('admin_cannot_promote_user_to_admin_without_super_admin', () => {
    it('should throw FORBIDDEN when ADMIN tries to promote a USER to ADMIN', async () => {
      mockFindById._setActor({ _id: 'actor1', role: ROLES.ADMIN });

      await expect(
        userService._assertRoleAndPermissionManagementAllowed({
          actorUserId: 'actor1',
          targetUser: { role: ROLES.USER },
          updateData: { role: ROLES.ADMIN },
        })
      ).rejects.toThrow('فقط مدير النظام');
    });
  });

  describe('admin_cannot_enable_login_for_other_user_without_sensitive_permission', () => {
    it('should throw FORBIDDEN when ADMIN tries to enable login for another user', async () => {
      mockFindById._setActor({ _id: 'actor1', role: ROLES.ADMIN });

      await expect(
        userService._assertRoleAndPermissionManagementAllowed({
          actorUserId: 'actor1',
          targetUser: { role: ROLES.USER, hasLogin: false },
          updateData: { hasLogin: true },
        })
      ).rejects.toThrow('فقط مدير النظام');
    });

    it('should throw FORBIDDEN when ADMIN tries to set a password for another user', async () => {
      mockFindById._setActor({ _id: 'actor1', role: ROLES.ADMIN });

      await expect(
        userService._assertRoleAndPermissionManagementAllowed({
          actorUserId: 'actor1',
          targetUser: { role: ROLES.USER, hasLogin: true },
          updateData: { password: 'NewPass123!' },
        })
      ).rejects.toThrow('فقط مدير النظام');
    });

    it('should throw FORBIDDEN when ADMIN tries to change account status', async () => {
      mockFindById._setActor({ _id: 'actor1', role: ROLES.ADMIN });

      await expect(
        userService._assertRoleAndPermissionManagementAllowed({
          actorUserId: 'actor1',
          targetUser: { role: ROLES.USER, accountStatus: ACCOUNT_STATUSES.APPROVED },
          updateData: { accountStatus: ACCOUNT_STATUSES.REJECTED },
        })
      ).rejects.toThrow('فقط مدير النظام');
    });
  });

  describe('super_admin_can_perform_sensitive_user_update', () => {
    it('should NOT throw when SUPER_ADMIN promotes USER to ADMIN', async () => {
      mockFindById._setActor({ _id: 'actor1', role: ROLES.SUPER_ADMIN });

      await expect(
        userService._assertRoleAndPermissionManagementAllowed({
          actorUserId: 'actor1',
          targetUser: { role: ROLES.USER },
          updateData: { role: ROLES.ADMIN },
        })
      ).resolves.toBeUndefined();
    });

    it('should NOT throw when SUPER_ADMIN enables login for another user', async () => {
      mockFindById._setActor({ _id: 'actor1', role: ROLES.SUPER_ADMIN });

      await expect(
        userService._assertRoleAndPermissionManagementAllowed({
          actorUserId: 'actor1',
          targetUser: { role: ROLES.USER, hasLogin: false },
          updateData: { hasLogin: true },
        })
      ).resolves.toBeUndefined();
    });

    it('should NOT throw when SUPER_ADMIN sets a password for another user', async () => {
      mockFindById._setActor({ _id: 'actor1', role: ROLES.SUPER_ADMIN });

      await expect(
        userService._assertRoleAndPermissionManagementAllowed({
          actorUserId: 'actor1',
          targetUser: { role: ROLES.USER, hasLogin: true },
          updateData: { password: 'NewPass123!' },
        })
      ).resolves.toBeUndefined();
    });

    it('should NOT throw when SUPER_ADMIN changes account status', async () => {
      mockFindById._setActor({ _id: 'actor1', role: ROLES.SUPER_ADMIN });

      await expect(
        userService._assertRoleAndPermissionManagementAllowed({
          actorUserId: 'actor1',
          targetUser: { role: ROLES.USER, accountStatus: ACCOUNT_STATUSES.APPROVED },
          updateData: { accountStatus: ACCOUNT_STATUSES.REJECTED },
        })
      ).resolves.toBeUndefined();
    });

    it('should NOT throw when SUPER_ADMIN changes permission overrides', async () => {
      mockFindById._setActor({ _id: 'actor1', role: ROLES.SUPER_ADMIN });

      await expect(
        userService._assertRoleAndPermissionManagementAllowed({
          actorUserId: 'actor1',
          targetUser: { role: ROLES.USER },
          updateData: { extraPermissions: [PERMISSIONS.USERS_VIEW] },
        })
      ).resolves.toBeUndefined();
    });
  });
});
