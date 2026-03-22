const Joi = require('joi');

const pushSubscriptionSchema = Joi.object({
  endpoint: Joi.string().uri({ scheme: ['https'] }).max(2000).required(),
  expirationTime: Joi.alternatives().try(Joi.number(), Joi.valid(null)).optional(),
  keys: Joi.object({
    p256dh: Joi.string().trim().min(1).max(512).required(),
    auth: Joi.string().trim().min(1).max(256).required(),
  }).required(),
});

const subscribe = {
  body: Joi.object({
    subscription: pushSubscriptionSchema.required(),
    userAgent: Joi.string().trim().allow('').max(500).optional(),
  }),
};

const unsubscribe = {
  body: Joi.object({
    endpoint: Joi.string().uri({ scheme: ['https'] }).max(2000).required(),
  }),
};

module.exports = {
  subscribe,
  unsubscribe,
};
