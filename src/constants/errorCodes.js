const ERROR_CODES = Object.freeze({
  // المصادقة
  AUTH_INVALID_CREDENTIALS: {
    code: 'AUTH_INVALID_CREDENTIALS',
    message: 'بيانات الدخول غير صحيحة',
    statusCode: 401,
  },
  AUTH_ACCOUNT_LOCKED: {
    code: 'AUTH_ACCOUNT_LOCKED',
    message: 'الحساب مغلق. يرجى التواصل مع المسؤول',
    statusCode: 403,
  },
  AUTH_NO_LOGIN_ACCESS: {
    code: 'AUTH_NO_LOGIN_ACCESS',
    message: 'هذا الحساب لا يملك صلاحية تسجيل الدخول',
    statusCode: 403,
  },
  AUTH_TOKEN_EXPIRED: {
    code: 'AUTH_TOKEN_EXPIRED',
    message: 'انتهت صلاحية الجلسة. يرجى تسجيل الدخول مرة أخرى',
    statusCode: 401,
  },
  AUTH_TOKEN_INVALID: {
    code: 'AUTH_TOKEN_INVALID',
    message: 'رمز المصادقة غير صالح',
    statusCode: 401,
  },
  AUTH_TOKEN_BLACKLISTED: {
    code: 'AUTH_TOKEN_BLACKLISTED',
    message: 'تم إبطال رمز المصادقة',
    statusCode: 401,
  },
  AUTH_REFRESH_TOKEN_INVALID: {
    code: 'AUTH_REFRESH_TOKEN_INVALID',
    message: 'رمز التحديث غير صالح أو منتهي الصلاحية',
    statusCode: 401,
  },
  AUTH_UNAUTHORIZED: {
    code: 'AUTH_UNAUTHORIZED',
    message: 'يجب تسجيل الدخول أولاً',
    statusCode: 401,
  },

  // التحقق من البيانات
  VALIDATION_ERROR: {
    code: 'VALIDATION_ERROR',
    message: 'خطأ في البيانات المدخلة',
    statusCode: 400,
  },

  // الصلاحيات
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء',
    statusCode: 403,
  },

  // الموارد
  RESOURCE_NOT_FOUND: {
    code: 'RESOURCE_NOT_FOUND',
    message: 'المورد المطلوب غير موجود',
    statusCode: 404,
  },
  USER_NOT_FOUND: {
    code: 'USER_NOT_FOUND',
    message: 'المستخدم غير موجود',
    statusCode: 404,
  },

  // التكرار
  DUPLICATE_VALUE: {
    code: 'DUPLICATE_VALUE',
    message: 'القيمة مكررة وموجودة مسبقاً',
    statusCode: 409,
  },
  DUPLICATE_PHONE: {
    code: 'DUPLICATE_PHONE',
    message: 'رقم الهاتف مسجل مسبقاً',
    statusCode: 409,
  },
  DUPLICATE_EMAIL: {
    code: 'DUPLICATE_EMAIL',
    message: 'البريد الإلكتروني مسجل مسبقاً',
    statusCode: 409,
  },
  DUPLICATE_NATIONAL_ID: {
    code: 'DUPLICATE_NATIONAL_ID',
    message: 'الرقم القومي مسجل مسبقاً',
    statusCode: 409,
  },

  // تحديد المعدل
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    message: 'تم تجاوز الحد المسموح به من الطلبات. يرجى المحاولة لاحقاً',
    statusCode: 429,
  },

  // رفع الملفات
  UPLOAD_FAILED: {
    code: 'UPLOAD_FAILED',
    message: 'فشل رفع الملف',
    statusCode: 500,
  },
  UPLOAD_FILE_TOO_LARGE: {
    code: 'UPLOAD_FILE_TOO_LARGE',
    message: 'حجم الملف يتجاوز الحد المسموح',
    statusCode: 400,
  },
  UPLOAD_INVALID_TYPE: {
    code: 'UPLOAD_INVALID_TYPE',
    message: 'نوع الملف غير مسموح به',
    statusCode: 400,
  },

  // أخطاء الخادم
  INTERNAL_ERROR: {
    code: 'INTERNAL_ERROR',
    message: 'خطأ داخلي في الخادم',
    statusCode: 500,
  },
});

module.exports = ERROR_CODES;
