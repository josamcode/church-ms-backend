/**
 * P0 Regression Tests — Divine Liturgy Attendance Concurrency
 *
 * 1. divine_liturgy_attendance_fresh_update_succeeds
 * 2. divine_liturgy_attendance_stale_update_returns_conflict
 * 3. divine_liturgy_attendance_rejected_update_does_not_update_user_snapshots
 * 4. divine_liturgy_attendance_parallel_updates_do_not_silently_overwrite
 * 5. existing_divine_liturgy_attendance_happy_path_still_passes
 */

const mongoose = require('mongoose');
const ApiError = require('../../src/utils/ApiError');

// ── Mocks ──

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../src/config/redis', () => ({
  get: jest.fn().mockResolvedValue(null), setex: jest.fn(), del: jest.fn(),
  isFallback: true, status: 'ready', on: jest.fn(), call: jest.fn(),
  ensureRedisReady: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/constants/cacheKeys', () => ({
  CACHE_KEYS: { USER_PROFILE: (id) => `user:profile:${id}` },
}));

jest.mock('../../src/config/env', () => ({
  env: 'test', isProduction: false, isDevelopmentLike: true,
  jwt: { accessSecret: 'test', refreshSecret: 'test', accessExpiresIn: '15m' },
  redis: { enabled: false },
  push: { enabled: false },
}));

jest.mock('../../src/modules/settings/platformSettings.service', () => ({
  renderDashboardNotificationPublishedNotification: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../src/modules/users/user.model', () => {
  const UserMock = {
    find: jest.fn().mockImplementation((query) => {
      // Return matching users for _assertAttendanceUsersExist
      let matchedIds = [];
      if (query && query._id && query._id.$in) {
        matchedIds = query._id.$in.map((id) => ({ _id: id }));
      }
      return {
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(matchedIds),
      };
    }),
    findById: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  return UserMock;
});

jest.mock('../../src/modules/meetings/meeting.model', () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
}));

jest.mock('../../src/modules/divineLiturgies/divineLiturgyRecurring.model', () => {
  const mod = function () {};
  mod.findById = jest.fn();
  mod.findOne = jest.fn();
  mod.SERVICE_TYPES = { DIVINE_LITURGY: 'DIVINE_LITURGY', VESPERS: 'VESPERS' };
  mod.DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return mod;
});

jest.mock('../../src/modules/divineLiturgies/divineLiturgyException.model', () => {
  const mod = function () {};
  mod.findById = jest.fn();
  return mod;
});

jest.mock('../../src/modules/divineLiturgies/churchPriest.model', () => ({
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) }),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/modules/notifications/userNotifications.service', () => ({
  notifyUsersWithAnyPermissions: jest.fn().mockResolvedValue({ recipientCount: 0 }),
}));

// ── Mock DivineLiturgyAttendance with atomic findOneAndUpdate ──
const mockAttendanceStore = new Map();

function mockAttendanceDoc(data = {}) {
  return {
    _id: data._id || new mongoose.Types.ObjectId(),
    entryType: data.entryType || 'recurring',
    serviceId: data.serviceId || new mongoose.Types.ObjectId(),
    serviceType: data.serviceType || 'DIVINE_LITURGY',
    attendanceDate: data.attendanceDate || '2026-06-20',
    attendedUserIds: data.attendedUserIds || [],
    recordedBy: data.recordedBy || new mongoose.Types.ObjectId(),
    updatedBy: data.updatedBy || null,
    updatedAt: data.updatedAt || new Date('2026-06-20T10:00:00Z'),
    auditLog: data.auditLog || [],
    createdAt: data.createdAt || new Date('2026-06-20T10:00:00Z'),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

jest.mock('../../src/modules/divineLiturgies/divineLiturgyAttendance.model', () => {
  const MockAttendance = function (data) {
    Object.assign(this, mockAttendanceDoc(data));
  };

  MockAttendance.findOne = jest.fn().mockImplementation(async (query) => {
    // Look up by entryType + serviceId + attendanceDate
    const key = `${query.entryType}|${String(query.serviceId)}|${query.attendanceDate}`;
    return mockAttendanceStore.get(key) || null;
  });

  // Flag: when set, findOneAndUpdate for existing records returns null
  // (simulating a concurrent modification between load and save).
  let mockConflictNextUpdate = false;

  MockAttendance.findOneAndUpdate = jest.fn().mockImplementation(async (query, update, opts) => {
    if (query._id) {
      for (const [key, doc] of mockAttendanceStore) {
        if (String(doc._id) === String(query._id)) {
          if (mockConflictNextUpdate) {
            mockConflictNextUpdate = false;
            return null; // Stale update rejected
          }
          if (update.$set) {
            if (update.$set.attendedUserIds) doc.attendedUserIds = update.$set.attendedUserIds;
            if (update.$set.updatedBy) doc.updatedBy = update.$set.updatedBy;
            if (update.$set.updatedAt) doc.updatedAt = update.$set.updatedAt;
          }
          if (update.$push && update.$push.auditLog) {
            doc.auditLog = doc.auditLog || [];
            doc.auditLog.push(update.$push.auditLog);
          }
          return { ...doc, toObject: () => ({ ...doc }) };
        }
      }
      return null;
    }

    // New record — upsert
    const key = `${query.entryType}|${String(query.serviceId)}|${query.attendanceDate}`;
    if (opts && opts.upsert) {
      let doc = mockAttendanceStore.get(key);
      if (!doc) {
        doc = mockAttendanceDoc(update.$setOnInsert || {});
        mockAttendanceStore.set(key, doc);
      }
      return { ...doc, toObject: () => ({ ...doc }) };
    }

    return null;
  });

  MockAttendance._setConflictNextUpdate = (val) => { mockConflictNextUpdate = val; };

  MockAttendance.DIVINE_LITURGY_ATTENDANCE_ENTRY_TYPES = ['recurring', 'exception'];

  // Expose store for test management
  MockAttendance._store = mockAttendanceStore;
  MockAttendance._clearStore = () => mockAttendanceStore.clear();

  return MockAttendance;
});

// ═══════════════════════════════════════════════

describe('Divine Liturgy Attendance Concurrency', () => {
  let divineLiturgiesService;
  let DivineLiturgyRecurring;
  let AttendanceModel;
  let UserModel;

  beforeAll(() => {
    divineLiturgiesService = require('../../src/modules/divineLiturgies/divineLiturgies.service');
    DivineLiturgyRecurring = require('../../src/modules/divineLiturgies/divineLiturgyRecurring.model');
    AttendanceModel = require('../../src/modules/divineLiturgies/divineLiturgyAttendance.model');
    UserModel = require('../../src/modules/users/user.model');
  });

  beforeEach(() => {
    mockAttendanceStore.clear();
    jest.clearAllMocks();
  });

  function setupRecurringService(dayOfWeek = 'Sunday') {
    const serviceId = new mongoose.Types.ObjectId();
    DivineLiturgyRecurring.findById.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: serviceId, name: 'Sunday Liturgy', serviceType: 'DIVINE_LITURGY',
        dayOfWeek, isActive: true, priestUserIds: [],
      }),
    });
    return serviceId;
  }

  // ═══════════════════════════════════════════════
  //  1. divine_liturgy_attendance_fresh_update_succeeds
  // ═══════════════════════════════════════════════
  describe('divine_liturgy_attendance_fresh_update_succeeds', () => {
    it('should create a new attendance record on first update', async () => {
      const serviceId = setupRecurringService('Wednesday');
      const userId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();

      const result = await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(userId)],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );

      expect(result).toBeDefined();
      expect(result.attendedUserIds).toContain(String(userId));
    });

    it('should update an existing record on second update', async () => {
      const serviceId = setupRecurringService('Wednesday');
      const userId1 = new mongoose.Types.ObjectId();
      const userId2 = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();

      // First update
      await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(userId1)],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );

      // Second update with different users
      const result = await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(userId1), String(userId2)],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );

      expect(result.attendedUserIds).toContain(String(userId1));
      expect(result.attendedUserIds).toContain(String(userId2));
    });
  });

  // ═══════════════════════════════════════════════
  //  2. divine_liturgy_attendance_stale_update_returns_conflict
  // ═══════════════════════════════════════════════
  describe('divine_liturgy_attendance_stale_update_returns_conflict', () => {
    it('should return 409 when record was modified concurrently', async () => {
      const serviceId = setupRecurringService('Wednesday');
      const userId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();

      // Create initial record
      await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(userId)],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );

      // Flag that the next findOneAndUpdate should simulate a conflict
      AttendanceModel._setConflictNextUpdate(true);

      const userId2 = new mongoose.Types.ObjectId();
      await expect(
        divineLiturgiesService.updateAttendance(
          'recurring', String(serviceId), '2026-06-17',
          [String(userId), String(userId2)],
          { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
        )
      ).rejects.toThrow('modified by another user');
    });

    it('should use error code ATTENDANCE_CONCURRENT_MODIFICATION', async () => {
      const serviceId = setupRecurringService('Wednesday');
      const userId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();

      await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(userId)],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );

      AttendanceModel._setConflictNextUpdate(true);

      try {
        await divineLiturgiesService.updateAttendance(
          'recurring', String(serviceId), '2026-06-17',
          [String(userId)],
          { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
        );
        fail('Expected conflict error');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(409);
        expect(err.errorCode).toBe('ATTENDANCE_CONCURRENT_MODIFICATION');
      }
    });
  });

  // ═══════════════════════════════════════════════
  //  3. rejected_update_does_not_update_user_snapshots
  // ═══════════════════════════════════════════════
  describe('divine_liturgy_attendance_rejected_update_does_not_update_user_snapshots', () => {
    it('should not call User.updateMany when attendance update is rejected as stale', async () => {
      const serviceId = setupRecurringService('Wednesday');
      const userId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();

      await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(userId)],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );

      // Clear call history after the first successful update
      UserModel.updateMany.mockClear();

      // Flag a concurrent conflict on the next write
      AttendanceModel._setConflictNextUpdate(true);

      try {
        await divineLiturgiesService.updateAttendance(
          'recurring', String(serviceId), '2026-06-17',
          [String(userId)],
          { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
        );
      } catch (_) {
        // Expected — the conflict error
      }

      // User.updateMany must NOT have been called for this rejected update
      expect(UserModel.updateMany).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════
  //  4. parallel_updates_do_not_silently_overwrite
  // ═══════════════════════════════════════════════
  describe('divine_liturgy_attendance_parallel_updates_do_not_silently_overwrite', () => {
    it('should reject the second update when both load concurrently then save', async () => {
      const serviceId = setupRecurringService('Wednesday');
      const actor1 = new mongoose.Types.ObjectId();
      const userA = new mongoose.Types.ObjectId();
      const userB = new mongoose.Types.ObjectId();

      // First actor creates the record
      await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(userA)],
        { actorUserId: String(actor1), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );

      // Flag a conflict — simulating a concurrent write between load and save
      AttendanceModel._setConflictNextUpdate(true);

      // Second write should be rejected
      await expect(
        divineLiturgiesService.updateAttendance(
          'recurring', String(serviceId), '2026-06-17',
          [String(userA), String(userB)],
          { actorUserId: String(actor1), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
        )
      ).rejects.toThrow('modified by another user');

      // Stored data preserved (not overwritten by the rejected update)
      const stored = mockAttendanceStore.get(`recurring|${String(serviceId)}|2026-06-17`);
      expect(stored.attendedUserIds.map(String)).toEqual([String(userA)]);
    });
  });

  // ═══════════════════════════════════════════════
  //  5. existing_happy_path_still_passes
  // ═══════════════════════════════════════════════
  describe('existing_divine_liturgy_attendance_happy_path_still_passes', () => {
    it('should create and update records without conflict when no concurrency issue', async () => {
      const serviceId = setupRecurringService('Wednesday');
      const actorId = new mongoose.Types.ObjectId();
      const userIds = [
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
      ];

      // Create
      const r1 = await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(userIds[0])],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );
      expect(r1.attendedUserIds).toHaveLength(1);

      // Update — add more users
      const r2 = await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(userIds[0]), String(userIds[1])],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );
      expect(r2.attendedUserIds).toHaveLength(2);

      // Update — all three users
      const r3 = await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        userIds.map(String),
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );
      expect(r3.attendedUserIds).toHaveLength(3);
    });

    it('should handle different dates for the same service independently', async () => {
      const serviceId = setupRecurringService('Wednesday');
      const actorId = new mongoose.Types.ObjectId();
      const user1 = new mongoose.Types.ObjectId();
      const user2 = new mongoose.Types.ObjectId();

      // Date 1
      await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-10',
        [String(user1)],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );

      // Date 2 — different date, no conflict
      await divineLiturgiesService.updateAttendance(
        'recurring', String(serviceId), '2026-06-17',
        [String(user2)],
        { actorUserId: String(actorId), userPermissions: ['DIVINE_LITURGIES_ATTENDANCE_MANAGE'] }
      );

      // Both dates should have their records
      const key1 = `recurring|${String(serviceId)}|2026-06-10`;
      const key2 = `recurring|${String(serviceId)}|2026-06-17`;
      expect(mockAttendanceStore.has(key1)).toBe(true);
      expect(mockAttendanceStore.has(key2)).toBe(true);
    });
  });
});
