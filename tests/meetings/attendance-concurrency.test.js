/**
 * P0 Regression Tests — Meeting Attendance Concurrency
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

jest.mock('../../src/config/env', () => ({
  env: 'test', isProduction: false, isDevelopmentLike: true,
  jwt: { accessSecret: 'test', refreshSecret: 'test', accessExpiresIn: '15m' },
  redis: { enabled: false }, push: { enabled: false },
  cors: { allowedOrigins: [] },
}));

jest.mock('../../src/modules/users/user.model', () => ({
  findById: jest.fn().mockImplementation((id) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: id, fullName: 'Actor', avatar: null }),
  })),
  find: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  }),
  updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
}));

jest.mock('../../src/modules/meetings/meetingDocumentationConfig.model', () => ({}));
jest.mock('../../src/modules/meetings/meeting.model', () => {
  let midCounter = 0;
  function newMid() { return 'mtg-' + (++midCounter); }
  const MockMeeting = function (data) {
    this._id = data._id || newMid();
    this.name = data.name || 'Test Meeting';
    this.day = data.day || 'Wednesday';
    this.attendanceRecords = data.attendanceRecords || [];
    this.attendanceAuditLog = data.attendanceAuditLog || [];
    this.updatedAt = data.updatedAt || new Date();
    this.updatedBy = data.updatedBy || null;
    this.createdBy = data.createdBy || null;
    this.isDeleted = data.isDeleted !== undefined ? data.isDeleted : false;
    this.servants = data.servants || [];
    this.servedUserIds = data.servedUserIds || [];
    this.groupAssignments = data.groupAssignments || [];
    this.save = jest.fn().mockResolvedValue(this);
  };

  MockMeeting.findById = jest.fn();
  MockMeeting.findOne = jest.fn();
  MockMeeting.findOneAndUpdate = jest.fn();
  MockMeeting.DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return MockMeeting;
});

jest.mock('../../src/modules/divineLiturgies/divineLiturgyRecurring.model', () => ({
  SERVICE_TYPES: { DIVINE_LITURGY: 'DIVINE_LITURGY', VESPERS: 'VESPERS' },
}));

jest.mock('../../src/modules/divineLiturgies/divineLiturgyException.model', () => ({}));

jest.mock('../../src/constants/permissions', () => {
  const actual = jest.requireActual('../../src/constants/permissions');
  return { ...actual, filterAssignablePermissions: actual.filterAssignablePermissions };
});

jest.mock('../../src/modules/chats/chat.realtime', () => ({
  disconnectUserSockets: jest.fn(),
}));

jest.mock('../../src/services/storage/storage.service', () => ({
  uploadFile: jest.fn(), deleteFile: jest.fn(), deleteFiles: jest.fn(),
}));

jest.mock('../../src/modules/settings/platformSettings.service', () => ({
  renderMeetingReminderNotification: jest.fn().mockResolvedValue({}),
}));

// ═══════════════════════════════════════════════

describe('Meeting Attendance Concurrency', () => {
  let meetingsService;
  let MeetingModel;
  let UserModel;

  beforeAll(() => {
    meetingsService = require('../../src/modules/meetings/meetings.service');
    MeetingModel = require('../../src/modules/meetings/meeting.model');
    UserModel = require('../../src/modules/users/user.model');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeMeeting(overrides = {}) {
    return new MeetingModel({
      _id: overrides._id || new mongoose.Types.ObjectId(),
      name: overrides.name || 'Wednesday Bible Study',
      day: overrides.day || 'Wednesday',
      attendanceRecords: overrides.attendanceRecords || [],
      attendanceAuditLog: overrides.attendanceAuditLog || [],
      updatedAt: overrides.updatedAt || new Date('2026-06-20T10:00:00Z'),
      servants: overrides.servants || [
        { userId: overrides.actorUserId || new mongoose.Types.ObjectId(), role: 'secretary' },
      ],
      servedUserIds: overrides.servedUserIds || [],
    });
  }

  function mockMeetingLoad(meeting) {
    // _getMeetingForAttendance uses Meeting.findOne().select(...).lean()
    MeetingModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      then: (resolve) => resolve(meeting),
    });
  }

  // ═══════════════════════════════════════════════
  //  1. meeting_attendance_fresh_update_succeeds
  // ═══════════════════════════════════════════════
  describe('meeting_attendance_fresh_update_succeeds', () => {
    it('should create a new attendance record on first update', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const memberId = new mongoose.Types.ObjectId();

      const meeting = makeMeeting({ _id: meetingId, actorUserId: actorId, servedUserIds: [memberId] });
      mockMeetingLoad(meeting);

      // Successful conditional update
      MeetingModel.findOneAndUpdate.mockResolvedValue({ _id: meetingId });

      const result = await meetingsService.updateMeetingAttendance(
        String(meetingId), '2026-06-17',
        [String(memberId)],
        { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
      );

      expect(result).toBeDefined();
      expect(result.attendedMemberUserIds).toContain(String(memberId));
    });

    it('should update an existing record on second update', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const m1 = new mongoose.Types.ObjectId();
      const m2 = new mongoose.Types.ObjectId();

      // Meeting with existing attendance record
      const meeting = makeMeeting({
        _id: meetingId, actorUserId: actorId, servedUserIds: [m1, m2],
        attendanceRecords: [{
          attendanceDate: '2026-06-17',
          attendedMemberUserIds: [m1],
          recordedBy: actorId,
          updatedBy: actorId,
          updatedAt: new Date('2026-06-20T10:00:00Z'),
        }],
      });
      mockMeetingLoad(meeting);
      MeetingModel.findOneAndUpdate.mockResolvedValue({ _id: meetingId });

      const result = await meetingsService.updateMeetingAttendance(
        String(meetingId), '2026-06-17',
        [String(m1), String(m2)],
        { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
      );

      expect(result.attendedMemberUserIds).toContain(String(m1));
      expect(result.attendedMemberUserIds).toContain(String(m2));
    });
  });

  // ═══════════════════════════════════════════════
  //  2. meeting_attendance_stale_update_returns_conflict
  // ═══════════════════════════════════════════════
  describe('meeting_attendance_stale_update_returns_conflict', () => {
    it('should return 409 when meeting was modified concurrently', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const memberId = new mongoose.Types.ObjectId();

      const meeting = makeMeeting({ _id: meetingId, actorUserId: actorId, servedUserIds: [memberId] });
      mockMeetingLoad(meeting);

      // Simulate concurrent write — findOneAndUpdate returns null
      MeetingModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        meetingsService.updateMeetingAttendance(
          String(meetingId), '2026-06-17',
          [String(memberId)],
          { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
        )
      ).rejects.toThrow('modified by another user');
    });

    it('should use error code ATTENDANCE_CONCURRENT_MODIFICATION', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const memberId = new mongoose.Types.ObjectId();

      const meeting = makeMeeting({ _id: meetingId, actorUserId: actorId, servedUserIds: [memberId] });
      mockMeetingLoad(meeting);
      MeetingModel.findOneAndUpdate.mockResolvedValue(null);

      try {
        await meetingsService.updateMeetingAttendance(
          String(meetingId), '2026-06-17',
          [String(memberId)],
          { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
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
  describe('meeting_attendance_rejected_update_does_not_update_user_snapshots', () => {
    it('should not call User.updateMany when attendance update is rejected', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const memberId = new mongoose.Types.ObjectId();

      const meeting = makeMeeting({ _id: meetingId, actorUserId: actorId, servedUserIds: [memberId] });
      mockMeetingLoad(meeting);
      MeetingModel.findOneAndUpdate.mockResolvedValue(null);

      try {
        await meetingsService.updateMeetingAttendance(
          String(meetingId), '2026-06-17',
          [String(memberId)],
          { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
        );
      } catch (_) {}

      expect(UserModel.updateMany).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════
  //  4. parallel_updates_do_not_silently_overwrite
  // ═══════════════════════════════════════════════
  describe('meeting_attendance_parallel_updates_do_not_silently_overwrite', () => {
    it('should reject the second update when concurrent writes collide', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const m1 = new mongoose.Types.ObjectId();
      const m2 = new mongoose.Types.ObjectId();

      const meeting = makeMeeting({ _id: meetingId, actorUserId: actorId, servedUserIds: [m1, m2] });
      mockMeetingLoad(meeting);

      // First update succeeds
      MeetingModel.findOneAndUpdate.mockResolvedValueOnce({ _id: meetingId });
      await meetingsService.updateMeetingAttendance(
        String(meetingId), '2026-06-17',
        [String(m1)],
        { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
      );

      // Second update fails (concurrent modification)
      MeetingModel.findOneAndUpdate.mockResolvedValueOnce(null);
      await expect(
        meetingsService.updateMeetingAttendance(
          String(meetingId), '2026-06-17',
          [String(m1), String(m2)],
          { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
        )
      ).rejects.toThrow('modified by another user');
    });
  });

  // ═══════════════════════════════════════════════
  //  5. meeting_attendance_new_date_create_is_safe
  // ═══════════════════════════════════════════════
  describe('meeting_attendance_new_date_create_is_safe', () => {
    it('should safely create a record for a new date without conflict', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const memberId = new mongoose.Types.ObjectId();

      const meeting = makeMeeting({ _id: meetingId, actorUserId: actorId, servedUserIds: [memberId] });
      mockMeetingLoad(meeting);
      MeetingModel.findOneAndUpdate.mockResolvedValue({ _id: meetingId });

      const result = await meetingsService.updateMeetingAttendance(
        String(meetingId), '2026-06-17',
        [String(memberId)],
        { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
      );

      expect(result.attendanceDate).toBe('2026-06-17');
      expect(result.attendedMemberUserIds).toContain(String(memberId));
    });
  });

  // ═══════════════════════════════════════════════
  //  6. existing_happy_path_still_passes
  // ═══════════════════════════════════════════════
  describe('meeting_attendance_existing_happy_path_still_passes', () => {
    it('should create and update records without conflict when no concurrency issue', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const m1 = new mongoose.Types.ObjectId();
      const m2 = new mongoose.Types.ObjectId();
      const m3 = new mongoose.Types.ObjectId();

      const meeting = makeMeeting({ _id: meetingId, actorUserId: actorId, servedUserIds: [m1, m2, m3] });

      // All updates succeed
      mockMeetingLoad(meeting);
      MeetingModel.findOneAndUpdate.mockResolvedValue({ _id: meetingId });

      // Create
      const r1 = await meetingsService.updateMeetingAttendance(
        String(meetingId), '2026-06-17',
        [String(m1)],
        { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
      );
      expect(r1.attendedMemberUserIds).toHaveLength(1);

      // Update
      MeetingModel.findOneAndUpdate.mockResolvedValue({ _id: meetingId });
      const r2 = await meetingsService.updateMeetingAttendance(
        String(meetingId), '2026-06-17',
        [String(m1), String(m2)],
        { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
      );
      expect(r2.attendedMemberUserIds).toHaveLength(2);

      // Update — all three
      MeetingModel.findOneAndUpdate.mockResolvedValue({ _id: meetingId });
      const r3 = await meetingsService.updateMeetingAttendance(
        String(meetingId), '2026-06-17',
        [String(m1), String(m2), String(m3)],
        { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
      );
      expect(r3.attendedMemberUserIds).toHaveLength(3);
    });

    it('should handle different dates for the same meeting independently', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const m1 = new mongoose.Types.ObjectId();
      const m2 = new mongoose.Types.ObjectId();

      const meeting = makeMeeting({ _id: meetingId, actorUserId: actorId, servedUserIds: [m1, m2] });
      mockMeetingLoad(meeting);
      MeetingModel.findOneAndUpdate.mockResolvedValue({ _id: meetingId });

      // Date 1
      await meetingsService.updateMeetingAttendance(
        String(meetingId), '2026-06-10',
        [String(m1)],
        { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
      );

      // Date 2 — different date
      MeetingModel.findOneAndUpdate.mockResolvedValue({ _id: meetingId });
      await meetingsService.updateMeetingAttendance(
        String(meetingId), '2026-06-17',
        [String(m2)],
        { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
      );
    });
  });

  // ═══════════════════════════════════════════════
  //  7. conflict_error_shape_is_ApiError_409
  // ═══════════════════════════════════════════════
  describe('conflict_error_shape_is_ApiError_409', () => {
    it('should be an ApiError with statusCode 409 and proper errorCode', async () => {
      const meetingId = new mongoose.Types.ObjectId();
      const actorId = new mongoose.Types.ObjectId();
      const memberId = new mongoose.Types.ObjectId();

      const meeting = makeMeeting({ _id: meetingId, actorUserId: actorId, servedUserIds: [memberId] });
      mockMeetingLoad(meeting);
      MeetingModel.findOneAndUpdate.mockResolvedValue(null);

      try {
        await meetingsService.updateMeetingAttendance(
          String(meetingId), '2026-06-17',
          [String(memberId)],
          { actorUserId: String(actorId), userPermissions: ['MEETINGS_VIEW', 'MEETINGS_ATTENDANCE_MANAGE'] }
        );
        fail('Expected conflict');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err.statusCode).toBe(409);
        expect(err.errorCode).toBe('ATTENDANCE_CONCURRENT_MODIFICATION');
        expect(err.isOperational).toBe(true);
      }
    });
  });
});
