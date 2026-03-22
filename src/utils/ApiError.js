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

  static unauthorized(
    message = 'Authentication is required',
    errorCode = 'AUTH_UNAUTHORIZED'
  ) {
    return new ApiError(401, message, errorCode);
  }

  static forbidden(message = 'Permission denied', errorCode = 'PERMISSION_DENIED') {
    return new ApiError(403, message, errorCode);
  }

  static notFound(message = 'Resource not found', errorCode = 'RESOURCE_NOT_FOUND') {
    return new ApiError(404, message, errorCode);
  }

  static conflict(message, errorCode = 'DUPLICATE_VALUE') {
    return new ApiError(409, message, errorCode);
  }

  static tooManyRequests(message = 'Too many requests') {
    return new ApiError(429, message, 'RATE_LIMITED');
  }

  static serviceUnavailable(
    message = 'The requested service is temporarily unavailable',
    errorCode = 'SERVICE_UNAVAILABLE'
  ) {
    return new ApiError(503, message, errorCode);
  }

  static internal(message = 'Internal server error') {
    return new ApiError(500, message, 'INTERNAL_ERROR');
  }
}

module.exports = ApiError;
