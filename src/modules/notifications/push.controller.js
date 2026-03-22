const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/apiResponse');
const pushService = require('./push.service');

const getPublicKey = asyncHandler(async (_req, res) => {
  return ApiResponse.success(res, {
    message: 'Push public key loaded successfully',
    data: {
      publicKey: pushService.getPublicKey(),
    },
  });
});

const subscribe = asyncHandler(async (req, res) => {
  const subscription = await pushService.upsertSubscription({
    userId: req.user.id,
    subscription: req.body.subscription,
    userAgent: req.body.userAgent || req.get('user-agent') || '',
  });

  return ApiResponse.success(res, {
    message: 'Push subscription saved successfully',
    data: subscription,
  });
});

const unsubscribe = asyncHandler(async (req, res) => {
  const payload = await pushService.removeSubscription({
    userId: req.user.id,
    endpoint: req.body.endpoint,
  });

  return ApiResponse.success(res, {
    message: 'Push subscription removed successfully',
    data: payload,
  });
});

module.exports = {
  getPublicKey,
  subscribe,
  unsubscribe,
};
