const express = require('express');
const { authenticateJWT } = require('../../middlewares/auth');
const validate = require('../../middlewares/validate');
const { pushMutationLimiter } = require('../../middlewares/rateLimit');
const pushController = require('./push.controller');
const pushValidators = require('./push.validators');

const router = express.Router();

router.get('/public-key', authenticateJWT, pushController.getPublicKey);

router.post(
  '/subscribe',
  authenticateJWT,
  pushMutationLimiter,
  validate(pushValidators.subscribe),
  pushController.subscribe
);

router.post(
  '/unsubscribe',
  authenticateJWT,
  pushMutationLimiter,
  validate(pushValidators.unsubscribe),
  pushController.unsubscribe
);

module.exports = router;
