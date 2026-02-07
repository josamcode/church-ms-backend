class ApiResponse {
  static success(res, { message = 'تمت العملية بنجاح', data = null, meta = null, statusCode = 200 } = {}) {
    const response = {
      success: true,
      message,
      data,
      requestId: res.requestId,
      timestamp: new Date().toISOString(),
    };

    if (meta) {
      response.meta = meta;
    }

    return res.status(statusCode).json(response);
  }

  static created(res, { message = 'تم الإنشاء بنجاح', data = null } = {}) {
    return ApiResponse.success(res, { message, data, statusCode: 201 });
  }

  static noContent(res) {
    return res.status(204).send();
  }

  static error(res, { message = 'خطأ داخلي في الخادم', errorCode = 'INTERNAL_ERROR', details = null, statusCode = 500 } = {}) {
    const response = {
      success: false,
      message,
      error: {
        code: errorCode,
      },
      requestId: res.requestId,
      timestamp: new Date().toISOString(),
    };

    if (details && details.length > 0) {
      response.error.details = details;
    }

    return res.status(statusCode).json(response);
  }
}

module.exports = ApiResponse;
