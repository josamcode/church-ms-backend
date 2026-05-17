const ApiError = require('../../utils/ApiError');
const User = require('../users/user.model');
const { SiteAnalyticsSession, ANALYTICS_SURFACES } = require('./siteAnalyticsSession.model');

const ANALYTICS_SURFACE_SET = new Set(ANALYTICS_SURFACES);

class SystemAnalyticsService {
  _normalizeString(value, maxLength = 255) {
    if (value === undefined || value === null) return '';
    return String(value).trim().slice(0, maxLength);
  }

  _normalizeIdentifier(value, fieldName) {
    const normalized = this._normalizeString(value, 128);
    if (!normalized || !/^[a-zA-Z0-9_-]+$/.test(normalized)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return normalized;
  }

  _normalizePath(value) {
    const normalized = this._normalizeString(value || '/', 255);
    if (!normalized) return '/';

    const trimmed = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return trimmed.slice(0, 255);
  }

  _normalizeTitle(value) {
    return this._normalizeString(value, 160);
  }

  _normalizeSurface(path) {
    const normalizedPath = this._normalizePath(path);

    if (normalizedPath.startsWith('/dashboard')) {
      return 'dashboard';
    }

    if (normalizedPath.startsWith('/auth')) {
      return 'auth';
    }

    if (normalizedPath === '/' || normalizedPath.startsWith('/bookings')) {
      return 'public';
    }

    return 'other';
  }

  _isTrackablePath(path) {
    const normalizedPath = this._normalizePath(path);
    return !normalizedPath.startsWith('/dashboard/system-analytics');
  }

  _normalizePositiveInteger(value, { min = 0, max = 100000, fallback = null } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
  }

  _parseDate(value, fallback = new Date()) {
    if (!value) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }

  _encodePathKey(path) {
    return Buffer.from(String(path || '/')).toString('base64url');
  }

  _normalizePageDeltas(pageDeltas = []) {
    const merged = new Map();

    (Array.isArray(pageDeltas) ? pageDeltas : []).forEach((entry) => {
      const path = this._normalizePath(entry?.path);
      if (!path) return;

      const title = this._normalizeTitle(entry?.title);
      const views = this._normalizePositiveInteger(entry?.views, {
        min: 0,
        max: 25,
        fallback: 0,
      });
      const activeSeconds = this._normalizePositiveInteger(entry?.activeSeconds, {
        min: 0,
        max: 1800,
        fallback: 0,
      });

      const existing = merged.get(path) || {
        path,
        title: '',
        views: 0,
        activeSeconds: 0,
      };

      if (title) {
        existing.title = title;
      }

      existing.views += views;
      existing.activeSeconds += activeSeconds;

      merged.set(path, existing);
    });

    return [...merged.values()];
  }

  _buildDailyTrend(rawTrend = [], days = 30, now = new Date()) {
    const trendMap = new Map(
      rawTrend.map((entry) => [
        entry.date,
        {
          sessions: entry.sessions || 0,
          uniqueVisitors: entry.uniqueVisitors || 0,
          activeSeconds: entry.activeSeconds || 0,
        },
      ])
    );

    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    const filled = [];
    for (let index = 0; index < days; index += 1) {
      const current = new Date(start);
      current.setDate(start.getDate() + index);
      const key = current.toISOString().slice(0, 10);
      const currentTrend = trendMap.get(key) || {
        sessions: 0,
        uniqueVisitors: 0,
        activeSeconds: 0,
      };

      filled.push({
        date: key,
        sessions: currentTrend.sessions,
        uniqueVisitors: currentTrend.uniqueVisitors,
        activeSeconds: currentTrend.activeSeconds,
      });
    }

    return filled;
  }

  async syncSession(payload, authUser = null, meta = {}) {
    const sessionId = this._normalizeIdentifier(payload.sessionId, 'sessionId');
    const visitorId = this._normalizeIdentifier(payload.visitorId, 'visitorId');
    const occurredAt = this._parseDate(payload.occurredAt, new Date());
    const pageDeltas = this._normalizePageDeltas(payload.pageDeltas);
    const currentPath = this._normalizePath(
      payload.currentPath || pageDeltas[pageDeltas.length - 1]?.path || '/'
    );
    const currentTitle = this._normalizeTitle(payload.currentTitle);
    const surface = this._normalizeSurface(currentPath);
    const referrer = this._normalizeString(payload.referrer, 500);
    const language = this._normalizeString(payload.language, 32);
    const timezone = this._normalizeString(payload.timezone, 64);
    const userAgent = this._normalizeString(meta.userAgent, 500);
    const screenWidth = this._normalizePositiveInteger(payload.screenWidth, {
      min: 0,
      max: 20000,
      fallback: undefined,
    });
    const screenHeight = this._normalizePositiveInteger(payload.screenHeight, {
      min: 0,
      max: 20000,
      fallback: undefined,
    });

    const totalPageViews = pageDeltas.reduce((sum, entry) => sum + (entry.views || 0), 0);
    const totalActiveSeconds = pageDeltas.reduce(
      (sum, entry) => sum + (entry.activeSeconds || 0),
      0
    );
    const uniquePathsSet = new Set(pageDeltas.map((entry) => entry.path));
    if (this._isTrackablePath(currentPath)) {
      uniquePathsSet.add(currentPath);
    }
    const uniquePaths = [...uniquePathsSet];

    const update = {
      $setOnInsert: {
        sessionId,
        visitorId,
        startedAt: occurredAt,
        entrySurface: surface,
        entryPath: currentPath,
        entryTitle: currentTitle,
        referrer,
        language,
        timezone,
        userAgent,
        screenWidth,
        screenHeight,
      },
      $set: {
        lastSeenAt: occurredAt,
        currentSurface: surface,
        currentPath,
        exitPath: currentPath,
        currentTitle,
      },
      $addToSet: {
        pathsVisited: { $each: uniquePaths },
      },
      $inc: {},
      $unset: {},
    };

    if (authUser?.id) {
      update.$set.userId = authUser.id;
      update.$set.userRole = authUser.role;
      update.$set.isAuthenticated = true;
    }

    if (payload.isFinal) {
      update.$set.endedAt = occurredAt;
    } else {
      update.$unset.endedAt = 1;
    }

    if (totalPageViews > 0) {
      update.$inc.totalPageViews = totalPageViews;
    }

    if (totalActiveSeconds > 0) {
      update.$inc.totalActiveSeconds = totalActiveSeconds;
    }

    pageDeltas.forEach((entry) => {
      const pathKey = this._encodePathKey(entry.path);

      update.$set[`pathStats.${pathKey}.path`] = entry.path;
      update.$set[`pathStats.${pathKey}.lastSeenAt`] = occurredAt;

      if (entry.title) {
        update.$set[`pathStats.${pathKey}.title`] = entry.title;
      }

      if (entry.views > 0) {
        update.$inc[`pathStats.${pathKey}.views`] =
          (update.$inc[`pathStats.${pathKey}.views`] || 0) + entry.views;
      }

      if (entry.activeSeconds > 0) {
        update.$inc[`pathStats.${pathKey}.activeSeconds`] =
          (update.$inc[`pathStats.${pathKey}.activeSeconds`] || 0) + entry.activeSeconds;
      }
    });

    if (!Object.keys(update.$inc).length) {
      delete update.$inc;
    }

    if (!Object.keys(update.$unset).length) {
      delete update.$unset;
    }

    await SiteAnalyticsSession.updateOne({ sessionId }, update, {
      upsert: true,
      setDefaultsOnInsert: true,
    });

    return {
      accepted: true,
      sessionId,
    };
  }

  async getOverview({ days = 30, surface = 'all', limit = 20 }) {
    const safeDays = this._normalizePositiveInteger(days, {
      min: 1,
      max: 90,
      fallback: 30,
    });
    const safeLimit = this._normalizePositiveInteger(limit, {
      min: 5,
      max: 50,
      fallback: 20,
    });
    const normalizedSurface = ANALYTICS_SURFACE_SET.has(surface) ? surface : 'all';

    const now = new Date();
    const periodStart = new Date(now);
    periodStart.setHours(0, 0, 0, 0);
    periodStart.setDate(periodStart.getDate() - (safeDays - 1));

    const match = {
      startedAt: {
        $gte: periodStart,
        $lte: now,
      },
    };

    if (normalizedSurface !== 'all') {
      match.entrySurface = normalizedSurface;
    }

    const [overview = {}] = await SiteAnalyticsSession.aggregate([
      { $match: match },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalSessions: { $sum: 1 },
                uniqueVisitorsSet: { $addToSet: '$visitorId' },
                uniqueUsersSet: { $addToSet: '$userId' },
                authenticatedSessions: {
                  $sum: { $cond: ['$isAuthenticated', 1, 0] },
                },
                totalActiveSeconds: { $sum: '$totalActiveSeconds' },
                avgActiveSeconds: { $avg: '$totalActiveSeconds' },
                totalPageViews: { $sum: '$totalPageViews' },
              },
            },
            {
              $project: {
                _id: 0,
                totalSessions: 1,
                uniqueVisitors: { $size: '$uniqueVisitorsSet' },
                uniqueUsers: {
                  $size: {
                    $setDifference: ['$uniqueUsersSet', [null]],
                  },
                },
                authenticatedSessions: 1,
                totalActiveSeconds: 1,
                avgActiveSeconds: { $round: ['$avgActiveSeconds', 1] },
                totalPageViews: 1,
              },
            },
          ],
          dailyTrend: [
            {
              $group: {
                _id: {
                  year: { $year: '$startedAt' },
                  month: { $month: '$startedAt' },
                  day: { $dayOfMonth: '$startedAt' },
                },
                sessions: { $sum: 1 },
                activeSeconds: { $sum: '$totalActiveSeconds' },
                visitorIds: { $addToSet: '$visitorId' },
              },
            },
            {
              $project: {
                _id: 0,
                date: {
                  $dateToString: {
                    format: '%Y-%m-%d',
                    date: {
                      $dateFromParts: {
                        year: '$_id.year',
                        month: '$_id.month',
                        day: '$_id.day',
                      },
                    },
                  },
                },
                sessions: 1,
                activeSeconds: 1,
                uniqueVisitors: { $size: '$visitorIds' },
              },
            },
            { $sort: { date: 1 } },
          ],
          topPages: [
            {
              $project: {
                pathEntries: {
                  $objectToArray: { $ifNull: ['$pathStats', {}] },
                },
              },
            },
            { $unwind: '$pathEntries' },
            {
              $group: {
                _id: '$pathEntries.v.path',
                title: { $last: '$pathEntries.v.title' },
                views: { $sum: { $ifNull: ['$pathEntries.v.views', 0] } },
                activeSeconds: {
                  $sum: { $ifNull: ['$pathEntries.v.activeSeconds', 0] },
                },
                sessions: { $sum: 1 },
              },
            },
            { $match: { _id: { $ne: null } } },
            { $sort: { activeSeconds: -1, views: -1, _id: 1 } },
            { $limit: 8 },
            {
              $project: {
                _id: 0,
                path: '$_id',
                title: 1,
                views: 1,
                activeSeconds: 1,
                sessions: 1,
              },
            },
          ],
          surfaceBreakdown: [
            {
              $group: {
                _id: '$entrySurface',
                sessions: { $sum: 1 },
                activeSeconds: { $sum: '$totalActiveSeconds' },
              },
            },
            { $sort: { sessions: -1, _id: 1 } },
            {
              $project: {
                _id: 0,
                surface: '$_id',
                sessions: 1,
                activeSeconds: 1,
              },
            },
          ],
          recentSessions: [
            { $sort: { startedAt: -1 } },
            { $limit: safeLimit },
            {
              $project: {
                _id: 0,
                sessionId: 1,
                visitorId: 1,
                userId: 1,
                userRole: 1,
                isAuthenticated: 1,
                entrySurface: 1,
                entryPath: 1,
                exitPath: 1,
                totalActiveSeconds: 1,
                totalPageViews: 1,
                pathStats: 1,
                pathsVisitedCount: { $size: { $ifNull: ['$pathsVisited', []] } },
                startedAt: 1,
                lastSeenAt: 1,
              },
            },
          ],
        },
      },
    ]);

    const summary = overview.summary?.[0] || {
      totalSessions: 0,
      uniqueVisitors: 0,
      uniqueUsers: 0,
      authenticatedSessions: 0,
      totalActiveSeconds: 0,
      avgActiveSeconds: 0,
      totalPageViews: 0,
    };

    const recentSessions = Array.isArray(overview.recentSessions) ? overview.recentSessions : [];
    const userIds = [...new Set(recentSessions.map((session) => String(session.userId || '')).filter(Boolean))];
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('fullName').lean()
      : [];
    const userMap = new Map(users.map((user) => [String(user._id), user.fullName]));

    const surfaceBreakdownMap = new Map(
      (overview.surfaceBreakdown || []).map((entry) => [entry.surface, entry])
    );

    return {
      filters: {
        days: safeDays,
        surface: normalizedSurface,
        periodStart,
        periodEnd: now,
      },
      summary: {
        totalSessions: summary.totalSessions || 0,
        uniqueVisitors: summary.uniqueVisitors || 0,
        uniqueUsers: summary.uniqueUsers || 0,
        authenticatedSessions: summary.authenticatedSessions || 0,
        totalActiveSeconds: summary.totalActiveSeconds || 0,
        avgActiveSeconds: Number(summary.avgActiveSeconds || 0),
        totalPageViews: summary.totalPageViews || 0,
        avgPageViewsPerSession:
          summary.totalSessions > 0
            ? Number((summary.totalPageViews / summary.totalSessions).toFixed(1))
            : 0,
      },
      dailyTrend: this._buildDailyTrend(overview.dailyTrend, safeDays, now),
      topPages: (overview.topPages || []).map((entry) => ({
        path: entry.path,
        title: entry.title || '',
        views: entry.views || 0,
        activeSeconds: entry.activeSeconds || 0,
        sessions: entry.sessions || 0,
      })),
      surfaceBreakdown: ANALYTICS_SURFACES.map((surfaceName) => ({
        surface: surfaceName,
        sessions: surfaceBreakdownMap.get(surfaceName)?.sessions || 0,
        activeSeconds: surfaceBreakdownMap.get(surfaceName)?.activeSeconds || 0,
      })),
      recentSessions: recentSessions.map((session) => ({
        sessionId: session.sessionId,
        visitorId: session.visitorId,
        surface: session.entrySurface || 'other',
        entryPath: session.entryPath || '/',
        exitPath: session.exitPath || '/',
        totalActiveSeconds: session.totalActiveSeconds || 0,
        totalPageViews: session.totalPageViews || 0,
        pathsVisitedCount: session.pathsVisitedCount || 0,
        paths: Object.values(session.pathStats || {})
          .map((entry) => ({
            path: entry.path || '/',
            title: entry.title || '',
            views: entry.views || 0,
            activeSeconds: entry.activeSeconds || 0,
            lastSeenAt: entry.lastSeenAt,
          }))
          .sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0)),
        startedAt: session.startedAt,
        lastSeenAt: session.lastSeenAt,
        isAuthenticated: Boolean(session.isAuthenticated),
        user: session.userId
          ? {
              id: session.userId,
              fullName: userMap.get(String(session.userId)) || 'Unknown user',
              role: session.userRole || '',
            }
          : null,
      })),
    };
  }
}

module.exports = new SystemAnalyticsService();
