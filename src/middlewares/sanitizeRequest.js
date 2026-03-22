const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const sanitizeValue = (value) => {
  if (Array.isArray(value)) {
    value.forEach((entry) => sanitizeValue(entry));
    return value;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  Object.keys(value).forEach((key) => {
    if (BLOCKED_KEYS.has(key)) {
      delete value[key];
      return;
    }

    sanitizeValue(value[key]);
  });

  return value;
};

module.exports = (req, _res, next) => {
  sanitizeValue(req.body);
  sanitizeValue(req.query);
  sanitizeValue(req.params);
  next();
};
