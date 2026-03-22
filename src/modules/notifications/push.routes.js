const express = require('express');
const { authenticateJWT } = require('../../middlewares/auth');
const validate = require('../../middlewares/validate');
const pushController = require('./push.controller');
const pushValidators = require('./push.validators');

const router = express.Router();

router.get('/public-key', authenticateJWT, pushController.getPublicKey);

router.post(
  '/subscribe',
  authenticateJWT,
  validate(pushValidators.subscribe),
  pushController.subscribe
);

router.post(
  '/unsubscribe',
  authenticateJWT,
  validate(pushValidators.unsubscribe),
  pushController.unsubscribe
);

module.exports = router;
