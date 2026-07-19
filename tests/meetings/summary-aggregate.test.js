/**
 * Regression tests — listMeetings summary fast path.
 *
 * `_listMeetingsSummaryAggregate` counts inside MongoDB instead of shipping the
 * servant / served-user id arrays to Node. These tests pin the two properties
 * that make that safe:
 *   1. For unscoped (full-access) viewers it produces EXACTLY what the original
 *      `_resolveMeetingAccess` -> `_mapMeetingByAccess` -> `_toMeetingSummary`
 *      chain produced.
 *   2. Scoped viewers (servant / member) never reach it, because their mappers
 *      filter collections and a raw $size would over-count and leak sizes.
 */

const mongoose = require('mongoose');
const { PERMISSIONS } = require('../../src/constants/permissions');

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
  findById: jest.fn(), find: jest.fn(), updateMany: jest.fn(),
}));

jest.mock('../../src/modules/meetings/meetingDocumentationConfig.model', () => ({}));

jest.mock('../../src/modules/meetings/meeting.model', () => {
  const MockMeeting = function () {};
  MockMeeting.find = jest.fn();
  MockMeeting.findById = jest.fn();
  MockMeeting.findOne = jest.fn();
  MockMeeting.findOneAndUpdate = jest.fn();
  MockMeeting.aggregate = jest.fn();
  MockMeeting.DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return MockMeeting;
});

jest.mock('../../src/modules/divineLiturgies/divineLiturgyRecurring.model', () => ({
  SERVICE_TYPES: { DIVINE_LITURGY: 'DIVINE_LITURGY', VESPERS: 'VESPERS' },
}));
jest.mock('../../src/modules/divineLiturgies/divineLiturgyException.model', () => ({}));
jest.mock('../../src/modules/chats/chat.realtime', () => ({ disconnectUserSockets: jest.fn() }));
jest.mock('../../src/services/storage/storage.service', () => ({
  uploadFile: jest.fn(), deleteFile: jest.fn(), deleteFiles: jest.fn(),
}));
// `_mapMeeting` normalizes reminderSettings through this service. The summary
// shape never exposes reminderSettings, but the mapper still runs it, so keep
// the real normalizers rather than stubbing them to arbitrary values.
jest.mock('../../src/modules/settings/platformSettings.service', () => {
  const actual = jest.requireActual('../../src/modules/settings/platformSettings.service');
  return {
    renderMeetingReminderNotification: jest.fn().mockResolvedValue({}),
    normalizeMeetingReminderLeadMinutes:
      actual.normalizeMeetingReminderLeadMinutes.bind(actual),
    normalizeMeetingReminderTemplate: actual.normalizeMeetingReminderTemplate.bind(actual),
  };
});

// ═══════════════════════════════════════════════

describe('listMeetings summary fast path', () => {
  let meetingsService;
  let Meeting;

  beforeAll(() => {
    meetingsService = require('../../src/modules/meetings/meetings.service');
    Meeting = require('../../src/modules/meetings/meeting.model');
  });

  beforeEach(() => jest.clearAllMocks());

  const oid = () => new mongoose.Types.ObjectId();

  /** A meeting shaped like a `.lean()` doc with `sectorId` populated. */
  function makeMeeting({ servedUserIds = [], servants = [], groups = [], sector = null } = {}) {
    return {
      _id: oid(),
      name: 'Wednesday Bible Study',
      day: 'Wednesday',
      time: '19:00',
      avatar: null,
      sectorId: sector,
      serviceSecretary: { name: 'Sec', userId: oid() },
      assistantSecretaries: [{ name: 'A1', userId: oid() }, { name: 'A2', userId: oid() }],
      servants,
      servedUserIds,
      groups,
      groupAssignments: groups.map((g) => ({ group: g, servedUserIds: servedUserIds.slice(0, 2) })),
      committees: [{ _id: oid(), name: 'C1', memberUserIds: [oid()] }],
      activities: [{ _id: oid(), name: 'Act1', type: 'trip' }],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    };
  }

  /**
   * Emulate what MongoDB returns for the $facet pipeline in
   * `_listMeetingsSummaryAggregate`, so we can diff the service's shaping of it
   * against the original mapper chain.
   */
  function emulateAggregate(docs) {
    const rows = docs.map((d) => ({
      _id: d._id,
      name: d.name,
      day: d.day,
      time: d.time,
      avatar: d.avatar,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      sectorId: d.sectorId ? d.sectorId._id : undefined,
      groupsCount: (d.groups || []).length,
      assistantsCount: (d.assistantSecretaries || []).length,
      servantsCount: (d.servants || []).length,
      committeesCount: (d.committees || []).length,
      activitiesCount: (d.activities || []).length,
      servedUsersCount: (d.servedUserIds || []).length,
      sectorDoc: d.sectorId ? [d.sectorId] : [],
    }));

    const unique = new Set();
    docs.forEach((d) => (d.servedUserIds || []).forEach((id) => id && unique.add(String(id))));

    return [{ rows, servedUsersUnique: unique.size ? [{ count: unique.size }] : [] }];
  }

  /** The pre-optimisation path, reproduced verbatim from `listMeetings`. */
  function legacySummary(docs, { actorUserId, userPermissions }) {
    const uniqueServedUserIds = new Set();
    const meetings = docs
      .map((meeting) => {
        const accessContext = meetingsService._resolveMeetingAccess({
          meeting, actorUserId, userPermissions,
        });
        if (!accessContext.allowed) return null;
        const mapped = meetingsService._mapMeetingByAccess(meeting, accessContext);
        (mapped.servedUsers || []).forEach((user) => {
          if (user?.id) uniqueServedUserIds.add(String(user.id));
        });
        return meetingsService._toMeetingSummary(mapped);
      })
      .filter(Boolean);
    return { meetings, servedUsersUnique: uniqueServedUserIds.size };
  }

  function fixtures() {
    const sector = { _id: oid(), name: 'North Sector', avatar: 'sector.png' };
    const sharedServed = [oid(), oid()];
    return [
      makeMeeting({
        sector,
        groups: ['Group A', 'Group B'],
        servedUserIds: [...sharedServed, oid(), oid(), oid()],
        servants: [
          { _id: oid(), name: 'S1', userId: oid(), groupsManaged: ['Group A'], servedUserIds: [oid(), oid()] },
          { _id: oid(), name: 'S2', userId: oid(), groupsManaged: ['Group B'], servedUserIds: [oid()] },
        ],
      }),
      // Overlapping served users — proves the unique total dedupes across meetings.
      makeMeeting({
        sector,
        groups: ['Group C'],
        servedUserIds: [...sharedServed, oid()],
        servants: [{ _id: oid(), name: 'S3', userId: oid(), groupsManaged: [], servedUserIds: [] }],
      }),
      // No sector, no members — exercises the empty/null branches.
      makeMeeting({ sector: null, groups: [], servedUserIds: [], servants: [] }),
    ];
  }

  const FULL_PERMS = [PERMISSIONS.MEETINGS_VIEW];

  describe('equivalence with the original mapper', () => {
    it('produces byte-identical summaries for a viewer with full-view permission', async () => {
      const docs = fixtures();
      Meeting.aggregate.mockResolvedValue(emulateAggregate(docs));

      const actorUserId = String(oid());
      const result = await meetingsService._listMeetingsSummaryAggregate({
        query: {}, sortDirection: -1, limit: 100,
      });
      const legacy = legacySummary(docs, { actorUserId, userPermissions: FULL_PERMS });

      expect(result.meetings).toEqual(legacy.meetings);
      expect(result.servedUsersUnique).toBe(legacy.servedUsersUnique);
    });

    it('matches for an anonymous viewer (no actorUserId)', async () => {
      const docs = fixtures();
      Meeting.aggregate.mockResolvedValue(emulateAggregate(docs));

      const result = await meetingsService._listMeetingsSummaryAggregate({
        query: {}, sortDirection: -1, limit: 100,
      });
      const legacy = legacySummary(docs, { actorUserId: null, userPermissions: [] });

      expect(result.meetings).toEqual(legacy.meetings);
      expect(result.servedUsersUnique).toBe(legacy.servedUsersUnique);
    });

    it('dedupes served users across meetings rather than summing them', async () => {
      const docs = fixtures();
      Meeting.aggregate.mockResolvedValue(emulateAggregate(docs));

      const result = await meetingsService._listMeetingsSummaryAggregate({
        query: {}, sortDirection: -1, limit: 100,
      });

      const summed = docs.reduce((n, d) => n + d.servedUserIds.length, 0);
      expect(result.servedUsersUnique).toBe(6); // 8 refs, 2 shared
      expect(result.servedUsersUnique).toBeLessThan(summed);
    });

    it('emits counts only — never the underlying id arrays', async () => {
      const docs = fixtures();
      Meeting.aggregate.mockResolvedValue(emulateAggregate(docs));

      const { meetings } = await meetingsService._listMeetingsSummaryAggregate({
        query: {}, sortDirection: -1, limit: 100,
      });

      meetings.forEach((m) => {
        expect(m).not.toHaveProperty('servedUsers');
        expect(m).not.toHaveProperty('servedUserIds');
        expect(m).not.toHaveProperty('servants');
        expect(m).not.toHaveProperty('groupAssignments');
      });
      expect(meetings[0].servantsCount).toBe(2);
      expect(meetings[0].groupsCount).toBe(2);
      expect(meetings[0].servedUsersCount).toBe(5);
    });

    it('does not request the heavy id arrays from MongoDB', async () => {
      Meeting.aggregate.mockResolvedValue(emulateAggregate(fixtures()));
      await meetingsService._listMeetingsSummaryAggregate({
        query: {}, sortDirection: -1, limit: 100,
      });

      const pipeline = Meeting.aggregate.mock.calls[0][0];
      const projected = pipeline.find((s) => s.$facet).$facet.rows.find((s) => s.$project).$project;

      ['servants', 'servedUserIds', 'groupAssignments', 'committees', 'activities'].forEach((f) => {
        expect(projected[f]).toBeUndefined();
      });
      expect(projected.servantsCount).toEqual({ $size: { $ifNull: ['$servants', []] } });
    });

    it('renders a dangling sector reference as null, like populate does', async () => {
      const docs = [makeMeeting({ sector: null })];
      Meeting.aggregate.mockResolvedValue(emulateAggregate(docs));

      const { meetings } = await meetingsService._listMeetingsSummaryAggregate({
        query: {}, sortDirection: -1, limit: 100,
      });
      expect(meetings[0].sector).toBeNull();
    });

    it('returns zero unique served users when no meeting has any', async () => {
      const docs = [makeMeeting({ servedUserIds: [] })];
      Meeting.aggregate.mockResolvedValue(emulateAggregate(docs));

      const result = await meetingsService._listMeetingsSummaryAggregate({
        query: {}, sortDirection: -1, limit: 100,
      });
      expect(result.servedUsersUnique).toBe(0);
    });
  });

  describe('access scoping is not weakened', () => {
    function mockFindChain(docs) {
      const chain = {
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(docs),
      };
      Meeting.find.mockReturnValue(chain);
      return chain;
    }

    it('routes servant viewers through the scoped mapper, not the aggregate', async () => {
      const docs = fixtures();
      mockFindChain(docs);
      const servantUserId = String(docs[0].servants[0].userId);

      await meetingsService.listMeetings({
        summary: true,
        actorUserId: servantUserId,
        userPermissions: [PERMISSIONS.MEETINGS_VIEW_OWN],
      });

      expect(Meeting.aggregate).not.toHaveBeenCalled();
      expect(Meeting.find).toHaveBeenCalled();
    });

    it('routes served-member viewers through the scoped mapper, not the aggregate', async () => {
      const docs = fixtures();
      mockFindChain(docs);
      const memberUserId = String(docs[0].servedUserIds[0]);

      await meetingsService.listMeetings({
        summary: true,
        actorUserId: memberUserId,
        userPermissions: [PERMISSIONS.MEETINGS_VIEW_OWN],
      });

      expect(Meeting.aggregate).not.toHaveBeenCalled();
      expect(Meeting.find).toHaveBeenCalled();
    });

    it('uses the aggregate for a full-view viewer', async () => {
      Meeting.aggregate.mockResolvedValue(emulateAggregate(fixtures()));

      await meetingsService.listMeetings({
        summary: true,
        actorUserId: String(oid()),
        userPermissions: FULL_PERMS,
      });

      expect(Meeting.aggregate).toHaveBeenCalled();
      expect(Meeting.find).not.toHaveBeenCalled();
    });

    it('leaves the non-summary path on find() even for full-view viewers', async () => {
      mockFindChain(fixtures());

      await meetingsService.listMeetings({
        summary: false,
        actorUserId: String(oid()),
        userPermissions: FULL_PERMS,
      });

      expect(Meeting.aggregate).not.toHaveBeenCalled();
      expect(Meeting.find).toHaveBeenCalled();
    });
  });
});
