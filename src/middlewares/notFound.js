const ApiError = require('../utils/ApiError');

const notFound = (req, res, next) => {
  next(ApiError.notFound(`المسار ${req.originalUrl} غير موجود`));
};

module.exports = notFound;
