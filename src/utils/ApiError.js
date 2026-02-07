class ApiError extends Error {
  constructor(statusCode, message, errorCode = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, errorCode = 'VALIDATION_ERROR', details = null) {
    return new ApiError(400, message, errorCode, details);
  }

  static unauthorized(message = 'يجب تسجيل الدخول أولاً', errorCode = 'AUTH_UNAUTHORIZED') {
    return new ApiError(401, message, errorCode);
  }

  static forbidden(message = 'ليس لديك صلاحية لتنفيذ هذا الإجراء', errorCode = 'PERMISSION_DENIED') {
    return new ApiError(403, message, errorCode);
  }

  static notFound(message = 'المورد المطلوب غير موجود', errorCode = 'RESOURCE_NOT_FOUND') {
    return new ApiError(404, message, errorCode);
  }

  static conflict(message, errorCode = 'DUPLICATE_VALUE') {
    return new ApiError(409, message, errorCode);
  }

  static tooManyRequests(message = 'تم تجاوز الحد المسموح به من الطلبات') {
    return new ApiError(429, message, 'RATE_LIMITED');
  }

  static internal(message = 'خطأ داخلي في الخادم') {
    return new ApiError(500, message, 'INTERNAL_ERROR');
  }
}

module.exports = ApiError;
