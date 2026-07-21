const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/ApiError');

const NotificationType = require('../notifications/notificationType.model');
const { draftNotification } = require('./features/notificationDraft.feature');
const { narrateAnalytics } = require('./features/analyticsNarrative.feature');
const { buildAnalyticsSnapshot } = require('./features/analyticsSnapshot');
const featureFlags = require('./ops/featureFlags');
const quotaService = require('./ops/quota.service');
const AiUsage = require('./aiUsage.model');
const auditService = require('../audit/audit.service');
const { AUDIT_EVENTS } = require('../audit/audit.constants');
const { AI_FEATURES, AI_SENSITIVITY } = require('./ai.constants');

/**
 * Build the request context every AI call receives.
 *
 * `permissions` comes from `req.userPermissions`, which the authorization
 * middleware set from a fresh database read — the same backend-authoritative
 * value it used to allow the request. Recomputing it here, or trusting anything
 * from the client, would create a second source of truth for authorization.
 */
function buildContext(req, feature, sensitivity) {
  return {
    userId: req.user.id,
    role: req.user.role,
    permissions: req.userPermissions || [],
    requestId: req.requestId,
    feature,
    sensitivity,
    language: req.body?.language || 'ar',
  };
}

const draftNotificationContent = asyncHandler(async (req, res) => {
  const { notificationTypeId, audienceType, bulletPoints, tone, eventDate } = req.body;

  // The type name is read server-side from its id. Accepting a caller-supplied
  // name would let arbitrary text into the prompt while looking like a lookup.
  const notificationType = await NotificationType.findById(notificationTypeId)
    .select('name')
    .lean();

  if (!notificationType) {
    throw ApiError.notFound('Notification type not found', 'RESOURCE_NOT_FOUND');
  }

  const result = await draftNotification(
    {
      notificationTypeName: notificationType.name,
      audienceLabel: audienceType === 'permissions' ? 'محدَّد بالصلاحيات' : 'كل المستخدمين',
      bulletPoints,
      tone,
      eventDate: eventDate || null,
    },
    buildContext(req, AI_FEATURES.NOTIFICATION_DRAFT, AI_SENSITIVITY.INTERNAL)
  );

  return ApiResponse.success(res, {
    message: 'Draft generated successfully',
    data: { draft: result.data, meta: result.meta },
  });
});

const narrateAnalyticsOverview = asyncHandler(async (req, res) => {
  const { period, scope } = req.body;

  // The server assembles the numbers; the client never supplies them.
  const snapshot = await buildAnalyticsSnapshot({ period, scope });

  if (snapshot.metrics.every((metric) => metric.value === 0)) {
    throw ApiError.badRequest(
      'There is not enough analytics data in this period to summarize',
      'AI_INSUFFICIENT_DATA'
    );
  }

  const result = await narrateAnalytics(
    snapshot,
    buildContext(req, AI_FEATURES.ANALYTICS_NARRATIVE, AI_SENSITIVITY.INTERNAL)
  );

  return ApiResponse.success(res, {
    message: 'Narrative generated successfully',
    data: {
      narrative: result.data,
      // Returned so the UI can show the figures beside the prose, letting a
      // reader check any statement against the source number.
      metrics: snapshot.metrics,
      meta: result.meta,
    },
  });
});

/**
 * Non-secret operational status. Used by the UI to decide whether to render AI
 * affordances at all, so a disabled feature shows no button rather than a
 * button that fails.
 */
const getStatus = asyncHandler(async (req, res) => {
  const flags = featureFlags.describeFlags();

  const usage = await quotaService.getUsage({
    userId: req.user.id,
    role: req.user.role,
    feature: AI_FEATURES.NOTIFICATION_DRAFT,
  });

  return ApiResponse.success(res, {
    message: 'AI status loaded successfully',
    data: {
      enabled: flags.aiEnabled,
      features: flags.features,
      // Provider booleans only — never names of keys, never key material.
      providersAvailable: Object.values(flags.providers).some(Boolean),
      quota: usage,
    },
  });
});

/**
 * Record whether a generated draft was actually used.
 *
 * Without this the rollout's governing metric — draft acceptance, and how
 * heavily accepted drafts were edited — is unmeasurable, and the stop
 * condition "acceptance below 30% after two weeks" could never be evaluated.
 *
 * Scoped to the caller's own usage record: a user may annotate a request they
 * made, never someone else's.
 */
const submitFeedback = asyncHandler(async (req, res) => {
  const { requestId, feedback, editDistance } = req.body;

  const updated = await AiUsage.findOneAndUpdate(
    { requestId, userId: req.user.id },
    {
      $set: {
        userFeedback: feedback,
        humanApproval: feedback === 'positive' ? 'approved' : 'rejected',
        ...(editDistance === undefined ? {} : { editDistance }),
      },
    },
    { new: true }
  ).lean();

  if (!updated) {
    throw ApiError.notFound('AI usage record not found', 'RESOURCE_NOT_FOUND');
  }

  await auditService.recordAiEvent({
    eventType: AUDIT_EVENTS.AI_COMPLETED,
    actorUserId: req.user.id,
    actorRole: req.user.role,
    requestId: req.requestId,
    feature: updated.feature,
    metadata: { userFeedback: feedback, editDistance: editDistance ?? null },
  });

  return ApiResponse.success(res, { message: 'Feedback recorded successfully' });
});

module.exports = {
  draftNotificationContent,
  narrateAnalyticsOverview,
  getStatus,
  submitFeedback,
};
