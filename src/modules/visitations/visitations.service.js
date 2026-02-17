const mongoose = require('mongoose');
const User = require('../users/user.model');
const ApiError = require('../../utils/ApiError');
const { buildPaginationMeta } = require('../../utils/pagination');
const PastoralVisitation = require('./pastoralVisitation.model');

class VisitationsService {
  _toObjectId(id, fieldName = 'id') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return new mongoose.Types.ObjectId(id);
  }

  _mapVisitation(visitation) {
    const recorder = visitation.recordedBy || null;
    const recorderIsPopulated = recorder && typeof recorder === 'object' && recorder.fullName;
    const recorderId = recorderIsPopulated ? recorder._id : visitation.recordedBy;

    return {
      id: visitation._id,
      houseName: visitation.houseName,
      durationMinutes: visitation.durationMinutes ?? 10,
      visitedAt: visitation.visitedAt,
      notes: visitation.notes || '',
      recordedAt: visitation.createdAt,
      recordedBy: recorderId
        ? {
            id: recorderId,
            fullName: recorderIsPopulated ? recorder.fullName : null,
            phonePrimary: recorderIsPopulated ? recorder.phonePrimary || null : null,
          }
        : null,
      createdAt: visitation.createdAt,
      updatedAt: visitation.updatedAt,
    };
  }

  async createVisitation(payload, actorUserId) {
    const visitedAt = new Date(payload.visitedAt);
    if (Number.isNaN(visitedAt.getTime())) {
      throw ApiError.badRequest('Visitation date is invalid', 'VALIDATION_ERROR');
    }

    const durationMinutes =
      Number.isFinite(payload.durationMinutes) && payload.durationMinutes > 0
        ? payload.durationMinutes
        : 10;

    const visitation = await PastoralVisitation.create({
      houseName: payload.houseName,
      durationMinutes,
      visitedAt,
      notes: payload.notes || undefined,
      recordedBy: actorUserId,
    });

    const populated = await PastoralVisitation.findById(visitation._id)
      .populate('recordedBy', 'fullName phonePrimary')
      .lean();

    return this._mapVisitation(populated);
  }

  async listVisitations({ cursor, limit = 20, order = 'desc', filters = {} }) {
    const query = {};

    if (filters.houseName) {
      query.houseName = { $regex: filters.houseName.trim(), $options: 'i' };
    }
    if (filters.recordedByUserId) {
      query.recordedBy = this._toObjectId(filters.recordedByUserId, 'recordedByUserId');
    }

    const visitedAtQuery = {};
    if (filters.dateFrom) {
      const dateFrom = new Date(filters.dateFrom);
      if (!Number.isNaN(dateFrom.getTime())) {
        visitedAtQuery.$gte = dateFrom;
      }
    }
    if (filters.dateTo) {
      const dateTo = new Date(filters.dateTo);
      if (!Number.isNaN(dateTo.getTime())) {
        visitedAtQuery.$lte = dateTo;
      }
    }
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        const operator = order === 'desc' ? '$lt' : '$gt';
        visitedAtQuery[operator] = cursorDate;
      }
    }
    if (Object.keys(visitedAtQuery).length > 0) {
      query.visitedAt = visitedAtQuery;
    }

    const sortDirection = order === 'desc' ? -1 : 1;
    const visitations = await PastoralVisitation.find(query)
      .sort({ visitedAt: sortDirection, _id: sortDirection })
      .limit(limit)
      .populate('recordedBy', 'fullName phonePrimary')
      .lean();

    const meta = buildPaginationMeta(visitations, limit, 'visitedAt');

    return {
      visitations: visitations.map((visitation) => this._mapVisitation(visitation)),
      meta,
    };
  }

  async getVisitationById(id) {
    const visitation = await PastoralVisitation.findById(this._toObjectId(id))
      .populate('recordedBy', 'fullName phonePrimary')
      .lean();

    if (!visitation) {
      throw ApiError.notFound('Pastoral visitation not found', 'RESOURCE_NOT_FOUND');
    }

    return this._mapVisitation(visitation);
  }

  async getAnalytics({ months = 6 }) {
    const safeMonths = Number.isFinite(months) ? Math.min(Math.max(months, 1), 24) : 6;
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth() - (safeMonths - 1), 1);

    const [
      totalVisitations,
      visitationsInPeriod,
      uniqueHousesAgg,
      avgDurationAgg,
      monthlyTrendAgg,
      topHousesAgg,
      topRecordersAgg,
    ] = await Promise.all([
      PastoralVisitation.countDocuments({}),
      PastoralVisitation.countDocuments({ visitedAt: { $gte: periodStart, $lte: now } }),
      PastoralVisitation.aggregate([{ $group: { _id: '$normalizedHouseName' } }, { $count: 'count' }]),
      PastoralVisitation.aggregate([{ $group: { _id: null, value: { $avg: '$durationMinutes' } } }]),
      PastoralVisitation.aggregate([
        { $match: { visitedAt: { $gte: periodStart, $lte: now } } },
        {
          $group: {
            _id: {
              year: { $year: '$visitedAt' },
              month: { $month: '$visitedAt' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
      PastoralVisitation.aggregate([
        {
          $group: {
            _id: '$houseName',
            count: { $sum: 1 },
            avgDuration: { $avg: '$durationMinutes' },
            lastVisitedAt: { $max: '$visitedAt' },
          },
        },
        { $sort: { count: -1, lastVisitedAt: -1, _id: 1 } },
        { $limit: 7 },
      ]),
      PastoralVisitation.aggregate([
        {
          $group: {
            _id: '$recordedBy',
            count: { $sum: 1 },
            totalDuration: { $sum: '$durationMinutes' },
            lastRecordedAt: { $max: '$createdAt' },
          },
        },
        { $sort: { count: -1, lastRecordedAt: -1 } },
        { $limit: 7 },
      ]),
    ]);

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

    const recorderIds = topRecordersAgg.map((entry) => entry._id).filter(Boolean);
    const recorderUsers = recorderIds.length
      ? await User.find({ _id: { $in: recorderIds } }).select('fullName').lean()
      : [];
    const recorderMap = new Map(recorderUsers.map((user) => [String(user._id), user.fullName]));

    return {
      summary: {
        totalVisitations,
        visitationsInPeriod,
        uniqueHouses: uniqueHousesAgg[0]?.count || 0,
        avgDurationMinutes: Number((avgDurationAgg[0]?.value || 0).toFixed(1)),
      },
      monthlyTrend,
      topHouses: topHousesAgg.map((entry) => ({
        houseName: entry._id || 'Unknown house',
        count: entry.count,
        avgDurationMinutes: Number((entry.avgDuration || 0).toFixed(1)),
        lastVisitedAt: entry.lastVisitedAt || null,
      })),
      topRecorders: topRecordersAgg.map((entry) => ({
        userId: entry._id,
        fullName: recorderMap.get(String(entry._id)) || 'Unknown user',
        count: entry.count,
        totalDuration: entry.totalDuration || 0,
        lastRecordedAt: entry.lastRecordedAt || null,
      })),
    };
  }
}

module.exports = new VisitationsService();
