# دليل المصادقة (Authentication)

## نظرة عامة

النظام يستخدم **JWT** (JSON Web Tokens) مع استراتيجية **رمز وصول + رمز تحديث**:

- **رمز الوصول (Access Token)**: صالح لـ 15 دقيقة، يُرسل مع كل طلب
- **رمز التحديث (Refresh Token)**: صالح لـ 7 أيام، يُستخدم للحصول على رمز وصول جديد

---

## نقاط النهاية

### 1. التسجيل — `POST /api/auth/register`

**بدون مصادقة** | Rate limited (20 طلب / 15 دقيقة)

```json
// الطلب
{
  "fullName": "يوحنا مرقس",
  "phonePrimary": "01234567890",
  "email": "yohana@example.com",      // اختياري
  "password": "MyPass@123",
  "birthDate": "1990-05-15",
  "gender": "male"                     // اختياري: male | female | other
}

// الاستجابة (201)
{
  "success": true,
  "message": "تم التسجيل بنجاح",
  "data": {
    "user": { ... },
    "accessToken": "eyJhbGci...",
    "refreshToken": "a1b2c3d4e5..."
  },
  "requestId": "uuid",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

**سياسة كلمة المرور:**

- 8 أحرف على الأقل
- حرف كبير واحد على الأقل (A-Z)
- حرف صغير واحد على الأقل (a-z)
- رقم واحد على الأقل (0-9)
- رمز خاص واحد على الأقل (@$!%\*?&# إلخ)

---

### 2. تسجيل الدخول — `POST /api/auth/login`

**بدون مصادقة** | Rate limited

```json
// الطلب
{
  "identifier": "01234567890",  // رقم الهاتف أو البريد الإلكتروني
  "password": "MyPass@123"
}

// الاستجابة (200)
{
  "success": true,
  "message": "تم تسجيل الدخول بنجاح",
  "data": {
    "user": { ... },
    "accessToken": "eyJhbGci...",
    "refreshToken": "a1b2c3d4e5..."
  }
}
```

**أخطاء محتملة:**

- `AUTH_INVALID_CREDENTIALS` (401) — بيانات دخول غير صحيحة
- `AUTH_NO_LOGIN_ACCESS` (403) — الحساب لا يملك صلاحية دخول
- `AUTH_ACCOUNT_LOCKED` (403) — الحساب مغلق

---

### 3. تحديث الجلسة — `POST /api/auth/refresh`

```json
// الطلب
{
  "refreshToken": "a1b2c3d4e5..."
}

// الاستجابة (200)
{
  "success": true,
  "message": "تم تحديث الجلسة بنجاح",
  "data": {
    "accessToken": "eyJhbGci_new...",
    "refreshToken": "f6g7h8i9j0_new..."
  }
}
```

**ملاحظة:** يتم تدوير رمز التحديث (Token Rotation). الرمز القديم يُبطل ويُنشأ رمز جديد.

---

### 4. تسجيل الخروج — `POST /api/auth/logout`

**يتطلب مصادقة** (Bearer Token)

```json
// الطلب
{
  "refreshToken": "a1b2c3d4e5..."  // اختياري - لإبطال رمز التحديث
}

// الاستجابة (200)
{
  "success": true,
  "message": "تم تسجيل الخروج بنجاح"
}
```

عند تسجيل الخروج:

- يُضاف رمز الوصول للقائمة السوداء في Redis
- يُحذف رمز التحديث من Redis
- يُمسح التخزين المؤقت للمستخدم

---

### 5. جلب بيانات المستخدم الحالي — `GET /api/auth/me`

**يتطلب مصادقة** + صلاحية `AUTH_VIEW_SELF`

```json
// الاستجابة (200)
{
  "success": true,
  "message": "تم جلب بيانات المستخدم بنجاح",
  "data": {
    "_id": "...",
    "fullName": "يوحنا مرقس",
    "phonePrimary": "01234567890",
    "role": "USER",
    "ageGroup": "شاب",
    ...
  }
}
```

---

### 6. تغيير كلمة المرور — `POST /api/auth/change-password`

**يتطلب مصادقة** + صلاحية `AUTH_CHANGE_PASSWORD`

```json
// الطلب
{
  "currentPassword": "MyPass@123",
  "newPassword": "NewPass@456"
}

// الاستجابة (200)
{
  "success": true,
  "message": "تم تغيير كلمة المرور بنجاح"
}
```

---

## كيفية إرسال رمز الوصول

أرسل الرمز في Header كل طلب يتطلب مصادقة:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### مثال مع fetch (JavaScript)

```javascript
const response = await fetch("http://localhost:5000/api/auth/me", {
  method: "GET",
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  },
});
```

### مثال مع axios

```javascript
const api = axios.create({
  baseURL: "http://localhost:5000/api",
  headers: { "Content-Type": "application/json" },
});

// Interceptor لإضافة الرمز تلقائياً
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("accessToken");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Interceptor لتحديث الرمز تلقائياً عند الانتهاء
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (
      error.response?.status === 401 &&
      error.response?.data?.error?.code === "AUTH_TOKEN_EXPIRED"
    ) {
      const refreshToken = localStorage.getItem("refreshToken");
      const { data } = await axios.post("/api/auth/refresh", { refreshToken });

      localStorage.setItem("accessToken", data.data.accessToken);
      localStorage.setItem("refreshToken", data.data.refreshToken);

      error.config.headers.Authorization = `Bearer ${data.data.accessToken}`;
      return api.request(error.config);
    }
    return Promise.reject(error);
  }
);
```
