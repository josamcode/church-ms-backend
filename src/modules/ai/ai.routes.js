const express = require('express');

const router = express.Router();
const aiController = require('./ai.controller');
const aiValidators = require('./ai.validators');
const validate = require('../../middlewares/validate');
const { authenticateJWT } = require('../../middlewares/auth');
const { aiLimiter } = require('../../middlewares/rateLimit');
const { authorizePermissions } = require('../../middlewares/permissions');
const { PERMISSIONS } = require('../../constants/permissions');

/**
 * AI routes.
 *
 * Every generation endpoint requires TWO permissions: the AI permission and
 * the matching domain permission. `authorizePermissions` is `every`, so both
 * must be present. This is what makes the AI permissions additive — holding
 * `AI_DRAFT_CONTENT` alone grants nothing, and AI can never become a path to
 * data the user could not already reach through the normal UI.
 */

// Status is a read of feature flags and the caller's own quota. It needs
// authentication but no AI permission — the UI must be able to ask "should I
// render the AI button" without the answer itself being gated.
router.get('/status', authenticateJWT, aiController.getStatus);

// `apiMutationLimiter` is NOT repeated on these routes: `app.js` already
// applies it to all of `/api`, so listing it again would charge two units of
// the mutation budget for one request. The effective chain still matches the
// spec — generalLimiter and apiMutationLimiter (global) → aiLimiter (here) →
// authenticateJWT → authorizePermissions → validate.
router.post(
  '/notifications/draft',
  aiLimiter,
  authenticateJWT,
  authorizePermissions(PERMISSIONS.AI_DRAFT_CONTENT, PERMISSIONS.NOTIFICATIONS_CREATE),
  validate(aiValidators.draftNotificationBody),
  aiController.draftNotificationContent
);

router.post(
  '/analytics/narrate',
  aiLimiter,
  authenticateJWT,
  authorizePermissions(PERMISSIONS.AI_EXPLAIN_ANALYTICS, PERMISSIONS.SYSTEM_ANALYTICS_VIEW),
  validate(aiValidators.narrateAnalyticsBody),
  aiController.narrateAnalyticsOverview
);

// Feedback annotates the caller's OWN usage record. It needs no AI permission:
// someone who was granted a draft must be able to say it was unusable even if
// their AI permission is revoked afterwards, and the query is scoped to their
// own userId so it cannot touch anyone else's record. It carries no aiLimiter
// (it reaches no provider); the global mutation limiter bounds it.
router.post(
  '/feedback',
  authenticateJWT,
  validate(aiValidators.feedbackBody),
  aiController.submitFeedback
);

module.exports = router;
