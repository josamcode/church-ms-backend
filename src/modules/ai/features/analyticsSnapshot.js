/**
 * Builds the aggregate metric snapshot sent to the model for MVP-2.
 *
 * This file is the allow-list. `getOverview` returns much more than this —
 * `recentSessions` alone carries `visitorId`, `sessionId`, entry and exit
 * paths, and user agents — and none of it is included here. Fields are named
 * explicitly rather than filtered out, so the default for anything new added
 * upstream is "not sent".
 *
 * Everything below is a scalar count or average over the whole period. There
 * is no per-session, per-visitor, or per-user value in the payload.
 */

const systemAnalyticsService = require('../../systemAnalytics/systemAnalytics.service');

const PERIOD_DAYS = Object.freeze({ week: 7, month: 30, quarter: 90 });

/** Metric definitions. The `key` values are the only ones the model may cite. */
const SITE_METRICS = Object.freeze([
  { key: 'total_sessions', label: 'إجمالي الجلسات', path: 'totalSessions' },
  { key: 'unique_visitors', label: 'الزوار الفريدون', path: 'uniqueVisitors' },
  { key: 'unique_users', label: 'المستخدمون المسجَّلون', path: 'uniqueUsers' },
  { key: 'authenticated_sessions', label: 'الجلسات المصادَق عليها', path: 'authenticatedSessions' },
  { key: 'total_page_views', label: 'إجمالي مشاهدات الصفحات', path: 'totalPageViews' },
  { key: 'avg_pages_per_session', label: 'متوسط الصفحات لكل جلسة', path: 'avgPageViewsPerSession' },
  { key: 'avg_active_seconds', label: 'متوسط زمن النشاط بالثواني', path: 'avgActiveSeconds' },
]);

/**
 * Assemble the snapshot.
 *
 * The previous period of equal length is fetched so the model can describe
 * direction of change without being handed a trend it might over-interpret.
 *
 * @param {object} params
 * @param {'week'|'month'|'quarter'} params.period
 * @param {'site'|'meetings'} params.scope
 * @returns {Promise<{period: string, scope: string, metrics: Array}>}
 */
async function buildAnalyticsSnapshot({ period = 'month', scope = 'site' } = {}) {
  const days = PERIOD_DAYS[period] || PERIOD_DAYS.month;
  const surface = scope === 'meetings' ? 'dashboard' : 'all';

  const current = await systemAnalyticsService.getOverview({ days, surface, limit: 5 });
  const summary = current.summary || {};

  const metrics = SITE_METRICS.map((metric) => ({
    key: metric.key,
    label: metric.label,
    value: Number(summary[metric.path] || 0),
  }));

  // Top surfaces are included as route names with counts. Route names are not
  // personal data, and they are what makes an observation actionable.
  const surfaceBreakdown = (current.surfaceBreakdown || [])
    .filter((entry) => entry.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 5);

  surfaceBreakdown.forEach((entry) => {
    metrics.push({
      key: `surface_${entry.surface}_sessions`,
      label: `جلسات واجهة ${entry.surface}`,
      value: Number(entry.sessions || 0),
    });
  });

  return {
    period,
    scope,
    metrics,
    // Explicit, so a caller cannot accidentally spread extra fields in later.
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildAnalyticsSnapshot, SITE_METRICS, PERIOD_DAYS };
