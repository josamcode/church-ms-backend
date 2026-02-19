const mongoose = require('mongoose');
const User = require('../users/user.model');
const ConfessionSession = require('./confessionSession.model');
const ConfessionSessionType = require('./confessionSessionType.model');
const ConfessionConfig = require('./confessionConfig.model');
const ApiError = require('../../utils/ApiError');
const { PERMISSIONS } = require('../../constants/permissions');
const { buildPaginationMeta } = require('../../utils/pagination');

const { seedDefaultSessionTypes } = ConfessionSessionType;
const { getOrCreateConfessionConfig } = ConfessionConfig;

const DAY_MS = 24 * 60 * 60 * 1000;

class ConfessionsService {
  _hasPermission(effectivePermissions = [], permission) {
    return Array.isArray(effectivePermissions) && effectivePermissions.includes(permission);
  }

  _toObjectId(id, fieldName = 'id') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return new mongoose.Types.ObjectId(id);
  }

  _mapSession(session) {
    const attendee = session.attendeeUserId || null;
    const attendeeIsPopulated = attendee && typeof attendee === 'object' && attendee.fullName;
    const attendeeId = attendeeIsPopulated ? attendee._id : session.attendeeUserId;

    const sessionType = session.sessionTypeId || null;
    const typeIsPopulated = sessionType && typeof sessionType === 'object' && sessionType.name;
    const sessionTypeId = typeIsPopulated ? sessionType._id : session.sessionTypeId;

    const creator = session.createdBy || null;
    const creatorIsPopulated = creator && typeof creator === 'object' && creator.fullName;
    const creatorId = creatorIsPopulated ? creator._id : session.createdBy;

    return {
      id: session._id,
      attendee: {
        id: attendeeId || null,
        fullName: attendeeIsPopulated ? attendee.fullName : session.attendeeNameSnapshot,
        phonePrimary: attendeeIsPopulated ? attendee.phonePrimary || null : null,
        avatar: attendeeIsPopulated ? attendee.avatar || null : null,
        role: attendeeIsPopulated ? attendee.role || null : null,
      },
      sessionType: {
        id: sessionTypeId || null,
        name: typeIsPopulated ? sessionType.name : session.sessionTypeNameSnapshot,
      },
      scheduledAt: session.scheduledAt,
      nextSessionAt: session.nextSessionAt || null,
      notes: session.notes || '',
      createdBy: creatorId || null,
      createdByUser: creatorId
        ? {
            id: creatorId,
            fullName: creatorIsPopulated ? creator.fullName : null,
          }
        : null,
      updatedBy: session.updatedBy || null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  async _resolveAttendee(attendeeUserId, actorUserId, actorPermissions) {
    const canAssign = this._hasPermission(actorPermissions, PERMISSIONS.CONFESSIONS_ASSIGN_USER);
    const resolvedAttendeeUserId = attendeeUserId || actorUserId;

    if (!canAssign && String(resolvedAttendeeUserId) !== String(actorUserId)) {
      throw ApiError.forbidden(
        'You do not have permission to assign confession sessions to other users',
        'PERMISSION_DENIED'
      );
    }

    const attendee = await User.findById(resolvedAttendeeUserId)
      .select('fullName phonePrimary avatar role')
      .lean();

    if (!attendee) {
      throw ApiError.notFound('Attendee user not found', 'USER_NOT_FOUND');
    }

    return attendee;
  }

  async _resolveSessionType(sessionTypeId) {
    await seedDefaultSessionTypes();
    const sessionType = await ConfessionSessionType.findById(sessionTypeId).lean();
    if (!sessionType) {
      throw ApiError.notFound('Session type not found', 'RESOURCE_NOT_FOUND');
    }
    return sessionType;
  }

  async _buildAlerts({ thresholdDays, fullName }) {
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - thresholdDays * DAY_MS);

    const userQuery = {};
    if (fullName) {
      userQuery.fullName = { $regex: fullName, $options: 'i' };
    }

    const users = await User.find(userQuery)
      .select('fullName phonePrimary avatar role')
      .sort({ fullName: 1 })
      .lean();

    if (users.length === 0) {
      return { alerts: [], cutoffDate, thresholdDays };
    }

    const userIds = users.map((u) => u._id);
    const latestSessions = await ConfessionSession.aggregate([
      { $match: { attendeeUserId: { $in: userIds } } },
      {
        $group: {
          _id: '$attendeeUserId',
          lastSessionAt: { $max: '$scheduledAt' },
          sessionsCount: { $sum: 1 },
        },
      },
    ]);

    const latestMap = new Map(latestSessions.map((entry) => [String(entry._id), entry]));
    const alerts = [];

    for (const user of users) {
      const latest = latestMap.get(String(user._id));
      const lastSessionAt = latest?.lastSessionAt || null;

      if (lastSessionAt && lastSessionAt >= cutoffDate) {
        continue;
      }

      const daysSinceLastSession = lastSessionAt
        ? Math.floor((now.getTime() - new Date(lastSessionAt).getTime()) / DAY_MS)
        : null;

      alerts.push({
        userId: user._id,
        fullName: user.fullName,
        phonePrimary: user.phonePrimary || null,
        avatar: user.avatar || null,
        role: user.role || null,
        lastSessionAt,
        daysSinceLastSession,
        sessionsCount: latest?.sessionsCount || 0,
      });
    }

    alerts.sort((a, b) => {
      const aDays = a.daysSinceLastSession ?? Number.MAX_SAFE_INTEGER;
      const bDays = b.daysSinceLastSession ?? Number.MAX_SAFE_INTEGER;
      return bDays - aDays;
    });

    return { alerts, cutoffDate, thresholdDays };
  }

  async listSessionTypes() {
    await seedDefaultSessionTypes();
    const types = await ConfessionSessionType.find().sort({ order: 1, name: 1 }).lean();
    return types.map((type) => ({
      id: type._id,
      name: type.name,
      isDefault: !!type.isDefault,
      order: type.order,
    }));
  }

  async createSessionType(name, createdByUserId) {
    await seedDefaultSessionTypes();

    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      throw ApiError.badRequest('Session type name is required', 'VALIDATION_ERROR');
    }

    const normalizedName = trimmedName.toLowerCase();
    const existing = await ConfessionSessionType.findOne({ normalizedName }).lean();
    if (existing) {
      throw ApiError.conflict('Session type already exists', 'DUPLICATE_VALUE');
    }

    const maxOrderDoc = await ConfessionSessionType.findOne()
      .sort({ order: -1 })
      .select('order')
      .lean();

    const created = await ConfessionSessionType.create({
      name: trimmedName,
      normalizedName,
      isDefault: false,
      order: (maxOrderDoc?.order ?? 99) + 1,
      createdBy: createdByUserId,
    });

    return {
      id: created._id,
      name: created.name,
      isDefault: !!created.isDefault,
      order: created.order,
    };
  }

  async createSession(payload, actorUserId, actorPermissions) {
    const scheduledAt = new Date(payload.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw ApiError.badRequest('Scheduled date is invalid', 'VALIDATION_ERROR');
    }

    const nextSessionAt = payload.nextSessionAt ? new Date(payload.nextSessionAt) : null;
    if (nextSessionAt && Number.isNaN(nextSessionAt.getTime())) {
      throw ApiError.badRequest('Next session date is invalid', 'VALIDATION_ERROR');
    }
    if (nextSessionAt && nextSessionAt <= scheduledAt) {
      throw ApiError.badRequest(
        'Next session date must be after scheduled date',
        'VALIDATION_ERROR'
      );
    }

    const attendee = await this._resolveAttendee(
      payload.attendeeUserId,
      actorUserId,
      actorPermissions
    );
    const sessionType = await this._resolveSessionType(payload.sessionTypeId);

    const session = await ConfessionSession.create({
      attendeeUserId: attendee._id,
      attendeeNameSnapshot: attendee.fullName,
      sessionTypeId: sessionType._id,
      sessionTypeNameSnapshot: sessionType.name,
      scheduledAt,
      nextSessionAt: nextSessionAt || undefined,
      notes: payload.notes || undefined,
      createdBy: actorUserId,
    });

    const populated = await ConfessionSession.findById(session._id)
      .populate('attendeeUserId', 'fullName phonePrimary avatar role')
      .populate('sessionTypeId', 'name')
      .populate('createdBy', 'fullName')
      .lean();

    return this._mapSession(populated);
  }

  async listSessions({ cursor, limit = 20, order = 'desc', filters = {} }) {
    const query = {};

    if (filters.attendeeUserId) {
      query.attendeeUserId = this._toObjectId(filters.attendeeUserId, 'attendeeUserId');
    }
    if (filters.sessionTypeId) {
      query.sessionTypeId = this._toObjectId(filters.sessionTypeId, 'sessionTypeId');
    }

    const scheduledAtQuery = {};
    if (filters.dateFrom) {
      const dateFrom = new Date(filters.dateFrom);
      if (!Number.isNaN(dateFrom.getTime())) {
        scheduledAtQuery.$gte = dateFrom;
      }
    }
    if (filters.dateTo) {
      const dateTo = new Date(filters.dateTo);
      if (!Number.isNaN(dateTo.getTime())) {
        scheduledAtQuery.$lte = dateTo;
      }
    }
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        const operator = order === 'desc' ? '$lt' : '$gt';
        scheduledAtQuery[operator] = cursorDate;
      }
    }
    if (Object.keys(scheduledAtQuery).length > 0) {
      query.scheduledAt = scheduledAtQuery;
    }

    const sortDirection = order === 'desc' ? -1 : 1;

    const sessions = await ConfessionSession.find(query)
      .sort({ scheduledAt: sortDirection, _id: sortDirection })
      .limit(limit)
      .populate('attendeeUserId', 'fullName phonePrimary avatar role')
      .populate('sessionTypeId', 'name')
      .populate('createdBy', 'fullName')
      .lean();

    const meta = buildPaginationMeta(sessions, limit, 'scheduledAt');

    return {
      sessions: sessions.map((session) => this._mapSession(session)),
      meta,
    };
  }

  async searchUsers({ fullName, phonePrimary, limit = 15 }) {
    const query = {};
    const orConditions = [];
    if (fullName) {
      orConditions.push({ fullName: { $regex: fullName, $options: 'i' } });
    }
    if (phonePrimary) {
      orConditions.push({ phonePrimary: { $regex: phonePrimary, $options: 'i' } });
    }
    if (orConditions.length === 1) {
      Object.assign(query, orConditions[0]);
    } else if (orConditions.length > 1) {
      query.$or = orConditions;
    }

    const users = await User.find(query)
      .select('fullName phonePrimary avatar role')
      .sort({ fullName: 1 })
      .limit(limit)
      .lean();

    return users.map((user) => ({
      id: user._id,
      fullName: user.fullName,
      phonePrimary: user.phonePrimary || null,
      avatar: user.avatar || null,
      role: user.role || null,
    }));
  }

  async getAlertConfig() {
    const config = await getOrCreateConfessionConfig();
    return {
      alertThresholdDays: config.alertThresholdDays,
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy || null,
    };
  }

  async updateAlertConfig(alertThresholdDays, updatedByUserId) {
    const config = await getOrCreateConfessionConfig();
    config.alertThresholdDays = alertThresholdDays;
    config.updatedBy = updatedByUserId;
    await config.save();

    return {
      alertThresholdDays: config.alertThresholdDays,
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy || null,
    };
  }

  async getAlerts({ thresholdDays, fullName }) {
    const config = await getOrCreateConfessionConfig();
    const effectiveThreshold = thresholdDays || config.alertThresholdDays;

    const { alerts, cutoffDate } = await this._buildAlerts({
      thresholdDays: effectiveThreshold,
      fullName,
    });

    return {
      thresholdDays: effectiveThreshold,
      cutoffDate,
      count: alerts.length,
      alerts,
    };
  }

  async getAnalytics({ months = 6 }) {
    const safeMonths = Number.isFinite(months) ? Math.min(Math.max(months, 1), 24) : 6;
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth() - (safeMonths - 1), 1);
    const config = await getOrCreateConfessionConfig();

    const [
      totalSessions,
      sessionsInPeriod,
      upcomingSessions,
      uniqueAttendeesAgg,
      typeBreakdownAgg,
      monthlyTrendAgg,
      topAttendeesAgg,
      alertsPayload,
    ] = await Promise.all([
      ConfessionSession.countDocuments({}),
      ConfessionSession.countDocuments({ scheduledAt: { $gte: periodStart, $lte: now } }),
      ConfessionSession.countDocuments({ scheduledAt: { $gt: now } }),
      ConfessionSession.aggregate([{ $group: { _id: '$attendeeUserId' } }, { $count: 'count' }]),
      ConfessionSession.aggregate([
        { $group: { _id: '$sessionTypeNameSnapshot', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
      ]),
      ConfessionSession.aggregate([
        { $match: { scheduledAt: { $gte: periodStart, $lte: now } } },
        {
          $group: {
            _id: {
              year: { $year: '$scheduledAt' },
              month: { $month: '$scheduledAt' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
      ConfessionSession.aggregate([
        {
          $group: {
            _id: '$attendeeUserId',
            sessionsCount: { $sum: 1 },
            lastSessionAt: { $max: '$scheduledAt' },
          },
        },
        { $sort: { sessionsCount: -1, lastSessionAt: -1 } },
        { $limit: 5 },
      ]),
      this._buildAlerts({ thresholdDays: config.alertThresholdDays }),
    ]);

    const uniqueAttendees = uniqueAttendeesAgg[0]?.count || 0;

    const trendMap = new Map(
      monthlyTrendAgg.map((entry) => [`${entry._id.year}-${entry._id.month}`, entry.count])
    );
    const monthlyTrend = [];
    for (let i = 0; i < safeMonths; i += 1) {
      const current = new Date(periodStart.getFullYear(), periodStart.getMonth() + i, 1);
      const key = `${current.getFullYear()}-${current.getMonth() + 1}`;
      monthlyTrend.push({
        year: current.getFullYear(),
        month: current.getMonth() + 1,
        label: current.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        count: trendMap.get(key) || 0,
      });
    }

    const topAttendeeIds = topAttendeesAgg.map((entry) => entry._id).filter(Boolean);
    const topUsers = topAttendeeIds.length
      ? await User.find({ _id: { $in: topAttendeeIds } }).select('fullName').lean()
      : [];
    const topUserMap = new Map(topUsers.map((u) => [String(u._id), u]));

    return {
      summary: {
        totalSessions,
        sessionsInPeriod,
        uniqueAttendees,
        upcomingSessions,
        overdueUsers: alertsPayload.alerts.length,
        alertThresholdDays: config.alertThresholdDays,
      },
      typeBreakdown: typeBreakdownAgg.map((entry) => ({
        sessionType: entry._id || 'Unknown',
        count: entry.count,
      })),
      monthlyTrend,
      topAttendees: topAttendeesAgg.map((entry) => ({
        userId: entry._id,
        fullName: topUserMap.get(String(entry._id))?.fullName || 'Unknown user',
        sessionsCount: entry.sessionsCount,
        lastSessionAt: entry.lastSessionAt,
      })),
    };
  }
}

module.exports = new ConfessionsService();
