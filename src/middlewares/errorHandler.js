const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  let error = err;

  logger.error({
    message: error.message,
    errorCode: error.errorCode,
    statusCode: error.statusCode,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    requestId: req.requestId,
    path: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });

  // Mongoose validation error
  if (error.name === 'ValidationError' && error.errors) {
    const details = Object.values(error.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    error = ApiError.badRequest('خطأ في البيانات المدخلة', 'VALIDATION_ERROR', details);
  }

  // Mongoose duplicate key error
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0];
    const fieldMessages = {
      phonePrimary: 'رقم الهاتف مسجل مسبقاً',
      email: 'البريد الإلكتروني مسجل مسبقاً',
      nationalId: 'الرقم القومي مسجل مسبقاً',
    };
    const message = fieldMessages[field] || 'القيمة مكررة وموجودة مسبقاً';
    const codeMap = {
      phonePrimary: 'DUPLICATE_PHONE',
      email: 'DUPLICATE_EMAIL',
      nationalId: 'DUPLICATE_NATIONAL_ID',
    };
    error = ApiError.conflict(message, codeMap[field] || 'DUPLICATE_VALUE');
  }

  // Mongoose CastError (invalid ObjectId)
  if (error.name === 'CastError') {
    error = ApiError.badRequest('معرّف غير صالح', 'VALIDATION_ERROR');
  }

  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    error = ApiError.unauthorized('رمز المصادقة غير صالح', 'AUTH_TOKEN_INVALID');
  }
  if (error.name === 'TokenExpiredError') {
    error = ApiError.unauthorized('انتهت صلاحية الجلسة', 'AUTH_TOKEN_EXPIRED');
  }

  // Multer errors
  if (error.code === 'LIMIT_FILE_SIZE') {
    error = ApiError.badRequest(
      'حجم الملف يتجاوز الحد المسموح',
      'UPLOAD_FILE_TOO_LARGE'
    );
  }
  if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    error = ApiError.badRequest('حقل الملف غير متوقع', 'UPLOAD_FAILED');
  }

  const statusCode = error.statusCode || 500;
  const message = error.isOperational ? error.message : 'خطأ داخلي في الخادم';
  const errorCode = error.errorCode || 'INTERNAL_ERROR';

  return ApiResponse.error(res, {
    message,
    errorCode,
    details: error.details || null,
    statusCode,
  });
};

module.exports = errorHandler;
