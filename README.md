# نظام إدارة الكنيسة - الخادم الخلفي (Backend)

## نظرة عامة

نظام خلفي متكامل وجاهز للإنتاج لإدارة بيانات الكنيسة، مبني باستخدام:

- **Node.js** + **Express** — إطار العمل الأساسي
- **MongoDB** (Mongoose) — قاعدة البيانات
- **Redis** (ioredis) — التخزين المؤقت، تحديد المعدل، القائمة السوداء للرموز
- **Cloudinary** — رفع الوسائط (الصور الشخصية)
- **JWT** — المصادقة (رمز وصول + رمز تحديث)

جميع الرسائل والاستجابات وأخطاء التحقق باللغة **العربية**.

---

## المتطلبات الأساسية

| الأداة  | الإصدار الأدنى |
| ------- | -------------- |
| Node.js | 18+            |
| MongoDB | 6+             |
| Redis   | 6+             |

---

## التثبيت والتشغيل

### 1. نسخ المستودع والدخول للمجلد

```bash
cd backend
```

### 2. تثبيت المكتبات

```bash
npm install
```

### 3. إعداد متغيرات البيئة

```bash
cp .env.example .env
```

عدّل ملف `.env` بالقيم الصحيحة:

| المتغير                     | الوصف                                      |
| --------------------------- | ------------------------------------------ |
| `MONGO_URI`                 | رابط اتصال MongoDB                         |
| `REDIS_HOST` / `REDIS_PORT` | إعدادات Redis                              |
| `JWT_ACCESS_SECRET`         | مفتاح سري لرمز الوصول (غيّره في الإنتاج!)  |
| `JWT_REFRESH_SECRET`        | مفتاح سري لرمز التحديث (غيّره في الإنتاج!) |
| `CLOUDINARY_CLOUD_NAME`     | اسم حساب Cloudinary                        |
| `CLOUDINARY_API_KEY`        | مفتاح API لـ Cloudinary                    |
| `CLOUDINARY_API_SECRET`     | المفتاح السري لـ Cloudinary                |

### 4. تشغيل الخادم

```bash
# بيئة التطوير (مع إعادة التحميل التلقائي)
npm run dev

# بيئة الإنتاج
npm start
```

الخادم يعمل على `http://localhost:5000` افتراضياً.

### 5. فتح التوثيق

افتح المتصفح على: `http://localhost:5000/api/docs`

### 6. (اختياري) إدراج بيانات تجريبية

```bash
npm run seed
```

كلمة المرور الموحدة للحسابات التجريبية: `Test123!@#` — راجع قسم "بيانات تجريبية" في `How to use/01-getting-started.md`.

---

## هيكل المشروع

```
src/
├── app.js                    # إعداد Express والوسطاء
├── server.js                 # نقطة البداية وتشغيل الخادم
├── config/
│   ├── env.js                # متغيرات البيئة
│   ├── db.js                 # اتصال MongoDB
│   ├── redis.js              # اتصال Redis
│   └── cloudinary.js         # إعداد Cloudinary
├── constants/
│   ├── roles.js              # الأدوار (SUPER_ADMIN, ADMIN, USER)
│   ├── permissions.js        # الصلاحيات وربطها بالأدوار
│   ├── errorCodes.js         # رموز الأخطاء
│   ├── ageGroups.js          # الفئات العمرية
│   ├── lockReasons.js        # أسباب قفل الحساب
│   └── cacheKeys.js          # مفاتيح وأوقات التخزين المؤقت
├── modules/
│   ├── auth/
│   │   ├── auth.routes.js    # مسارات المصادقة
│   │   ├── auth.controller.js
│   │   ├── auth.service.js   # منطق الأعمال
│   │   └── auth.validators.js
│   └── users/
│       ├── user.model.js     # نموذج Mongoose
│       ├── user.routes.js
│       ├── user.controller.js
│       ├── user.service.js
│       └── user.validators.js
├── middlewares/
│   ├── auth.js               # التحقق من JWT
│   ├── permissions.js        # التحقق من الصلاحيات
│   ├── validate.js           # التحقق من البيانات (Joi)
│   ├── errorHandler.js       # معالجة الأخطاء المركزية
│   ├── notFound.js           # معالجة المسارات غير الموجودة
│   ├── requestId.js          # إضافة معرّف فريد لكل طلب
│   └── rateLimit.js          # تحديد معدل الطلبات
├── utils/
│   ├── ApiError.js           # فئة الأخطاء المخصصة
│   ├── apiResponse.js        # تنسيق الاستجابات الموحد
│   ├── asyncHandler.js       # معالج الأخطاء غير المتزامنة
│   ├── logger.js             # تسجيل الأحداث (Winston)
│   ├── pagination.js         # ترقيم المؤشر
│   └── pick.js               # اختيار حقول من كائن
└── docs/
    └── swagger.js            # إعداد Swagger/OpenAPI
```

---

## نظام الأدوار والصلاحيات

### الأدوار

| الدور         | الوصف                           |
| ------------- | ------------------------------- |
| `SUPER_ADMIN` | مدير النظام - جميع الصلاحيات    |
| `ADMIN`       | مسؤول - معظم الصلاحيات          |
| `USER`        | مستخدم عادي - صلاحيات ذاتية فقط |

### الصلاحيات

| الصلاحية                   | الوصف                    |
| -------------------------- | ------------------------ |
| `USERS_VIEW`               | عرض قائمة المستخدمين     |
| `USERS_VIEW_SELF`          | عرض بيانات الحساب الشخصي |
| `USERS_CREATE`             | إنشاء مستخدم جديد        |
| `USERS_UPDATE`             | تحديث بيانات أي مستخدم   |
| `USERS_UPDATE_SELF`        | تحديث البيانات الشخصية   |
| `USERS_DELETE`             | حذف مستخدم               |
| `USERS_LOCK`               | قفل حساب                 |
| `USERS_UNLOCK`             | فتح حساب مغلق            |
| `USERS_TAGS_MANAGE`        | إدارة الوسوم             |
| `USERS_FAMILY_LINK`        | ربط أفراد العائلة        |
| `USERS_UPLOAD_AVATAR`      | رفع صورة لأي مستخدم      |
| `USERS_UPLOAD_AVATAR_SELF` | رفع صورة شخصية           |
| `AUTH_VIEW_SELF`           | عرض بيانات الجلسة        |
| `AUTH_MANAGE_SESSIONS`     | إدارة الجلسات            |
| `AUTH_CHANGE_PASSWORD`     | تغيير كلمة المرور        |

### الصلاحيات الفعّالة

```
الصلاحيات الفعّالة = (صلاحيات الدور + الصلاحيات الإضافية) - الصلاحيات المرفوضة
```

---

## شكل الاستجابة الموحد

### نجاح

```json
{
  "success": true,
  "message": "رسالة عربية واضحة",
  "data": { "..." },
  "meta": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "2024-01-01T00:00:00.000Z",
    "count": 20
  },
  "requestId": "uuid",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### خطأ

```json
{
  "success": false,
  "message": "رسالة عربية واضحة للمستخدم",
  "error": {
    "code": "VALIDATION_ERROR",
    "details": [{ "field": "body.fullName", "message": "الاسم الكامل مطلوب" }]
  },
  "requestId": "uuid",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

## إضافة وحدة جديدة (Module)

1. أنشئ مجلد `src/modules/[module-name]/`
2. أنشئ الملفات: `model.js`, `routes.js`, `controller.js`, `service.js`, `validators.js`
3. أضف الصلاحيات في `src/constants/permissions.js`
4. سجّل المسارات في `src/app.js`
5. أضف التوثيق في `src/docs/swagger.js`

---

## الأمان

- Helmet (حماية HTTP headers)
- CORS (مُعدّ بشكل صحيح)
- MongoDB Sanitize (حماية من حقن NoSQL)
- XSS Clean (حماية من هجمات XSS)
- HPP (حماية من HTTP Parameter Pollution)
- Rate Limiting (تحديد معدل الطلبات عبر Redis)
- JWT مع قائمة سوداء للرموز المبطلة
- bcrypt لتشفير كلمات المرور (12 rounds)
- عدم إرجاع كلمات المرور أو البيانات الحساسة

---

## الترخيص

ISC
