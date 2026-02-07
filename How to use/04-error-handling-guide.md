# دليل معالجة الأخطاء

## شكل استجابة الخطأ

جميع الأخطاء تُرجع بنفس الشكل:

```json
{
  "success": false,
  "message": "رسالة واضحة للمستخدم بالعربي",
  "error": {
    "code": "ERROR_CODE",
    "details": [
      {
        "field": "body.email",
        "message": "البريد الإلكتروني غير صالح"
      }
    ]
  },
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

## رموز الأخطاء الكاملة

### أخطاء المصادقة (4xx)

| الرمز                        | HTTP | الرسالة                                         |
| ---------------------------- | ---- | ----------------------------------------------- |
| `AUTH_INVALID_CREDENTIALS`   | 401  | بيانات الدخول غير صحيحة                         |
| `AUTH_ACCOUNT_LOCKED`        | 403  | الحساب مغلق. يرجى التواصل مع المسؤول            |
| `AUTH_NO_LOGIN_ACCESS`       | 403  | هذا الحساب لا يملك صلاحية تسجيل الدخول          |
| `AUTH_TOKEN_EXPIRED`         | 401  | انتهت صلاحية الجلسة. يرجى تسجيل الدخول مرة أخرى |
| `AUTH_TOKEN_INVALID`         | 401  | رمز المصادقة غير صالح                           |
| `AUTH_TOKEN_BLACKLISTED`     | 401  | تم إبطال رمز المصادقة                           |
| `AUTH_REFRESH_TOKEN_INVALID` | 401  | رمز التحديث غير صالح أو منتهي الصلاحية          |
| `AUTH_UNAUTHORIZED`          | 401  | يجب تسجيل الدخول أولاً                          |

### أخطاء التحقق (400)

| الرمز              | HTTP | الرسالة                 |
| ------------------ | ---- | ----------------------- |
| `VALIDATION_ERROR` | 400  | خطأ في البيانات المدخلة |

عند وجود `VALIDATION_ERROR`، تحقق من `error.details` للحصول على تفاصيل كل حقل:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "details": [
      { "field": "body.fullName", "message": "الاسم الكامل مطلوب" },
      {
        "field": "body.password",
        "message": "كلمة المرور يجب أن تحتوي على 8 أحرف على الأقل..."
      }
    ]
  }
}
```

### أخطاء الصلاحيات (403)

| الرمز               | HTTP | الرسالة                            |
| ------------------- | ---- | ---------------------------------- |
| `PERMISSION_DENIED` | 403  | ليس لديك صلاحية لتنفيذ هذا الإجراء |

### أخطاء الموارد (404)

| الرمز                | HTTP | الرسالة                  |
| -------------------- | ---- | ------------------------ |
| `RESOURCE_NOT_FOUND` | 404  | المورد المطلوب غير موجود |
| `USER_NOT_FOUND`     | 404  | المستخدم غير موجود       |

### أخطاء التكرار (409)

| الرمز                   | HTTP | الرسالة                       |
| ----------------------- | ---- | ----------------------------- |
| `DUPLICATE_VALUE`       | 409  | القيمة مكررة وموجودة مسبقاً   |
| `DUPLICATE_PHONE`       | 409  | رقم الهاتف مسجل مسبقاً        |
| `DUPLICATE_EMAIL`       | 409  | البريد الإلكتروني مسجل مسبقاً |
| `DUPLICATE_NATIONAL_ID` | 409  | الرقم القومي مسجل مسبقاً      |

### أخطاء تحديد المعدل (429)

| الرمز          | HTTP | الرسالة                             |
| -------------- | ---- | ----------------------------------- |
| `RATE_LIMITED` | 429  | تم تجاوز الحد المسموح به من الطلبات |

### أخطاء رفع الملفات (400/500)

| الرمز                   | HTTP | الرسالة                       |
| ----------------------- | ---- | ----------------------------- |
| `UPLOAD_FAILED`         | 500  | فشل رفع الملف                 |
| `UPLOAD_FILE_TOO_LARGE` | 400  | حجم الملف يتجاوز الحد المسموح |
| `UPLOAD_INVALID_TYPE`   | 400  | نوع الملف غير مسموح به        |

### أخطاء الخادم (500)

| الرمز            | HTTP | الرسالة             |
| ---------------- | ---- | ------------------- |
| `INTERNAL_ERROR` | 500  | خطأ داخلي في الخادم |

---

## معالجة الأخطاء في الواجهة الأمامية

### مثال شامل

```javascript
try {
  const response = await api.post("/auth/login", {
    identifier: phone,
    password: password,
  });

  // نجاح
  const { user, accessToken, refreshToken } = response.data.data;
  // حفظ الرموز...
} catch (error) {
  const errorData = error.response?.data;

  if (!errorData) {
    // خطأ في الشبكة
    showToast("خطأ في الاتصال بالخادم");
    return;
  }

  switch (errorData.error?.code) {
    case "AUTH_INVALID_CREDENTIALS":
      showToast("رقم الهاتف أو كلمة المرور غير صحيحة");
      break;

    case "AUTH_ACCOUNT_LOCKED":
      showToast(errorData.message);
      break;

    case "VALIDATION_ERROR":
      // عرض أخطاء الحقول
      const fieldErrors = {};
      errorData.error.details?.forEach((detail) => {
        const field = detail.field.replace("body.", "");
        fieldErrors[field] = detail.message;
      });
      setFormErrors(fieldErrors);
      break;

    case "RATE_LIMITED":
      showToast("الرجاء الانتظار قليلاً قبل المحاولة مرة أخرى");
      break;

    default:
      showToast(errorData.message || "حدث خطأ غير متوقع");
  }
}
```

---

## معرّف الطلب (Request ID)

كل استجابة تحتوي على `requestId`. احتفظ به لأغراض تتبع الأخطاء:

```javascript
catch (error) {
  console.error('Request ID:', error.response?.data?.requestId);
  // يمكنك عرضه للمستخدم لإرساله للدعم الفني
}
```
