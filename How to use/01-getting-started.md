# دليل البدء السريع

## المتطلبات

1. **Node.js** الإصدار 18 أو أحدث
2. **MongoDB** مُشغّل محلياً أو عبر Atlas
3. **Redis** مُشغّل محلياً أو عبر خدمة سحابية
4. **حساب Cloudinary** لرفع الصور (مجاني)

---

## خطوات التشغيل

### 1. تثبيت المكتبات

```bash
cd backend
npm install
```

### 2. إنشاء ملف `.env`

```bash
cp .env.example .env
```

### 3. تعديل `.env`

أهم المتغيرات التي يجب تعديلها:

```env
MONGO_URI=mongodb://localhost:27017/church
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
JWT_ACCESS_SECRET=مفتاح_سري_طويل_وعشوائي_هنا
JWT_REFRESH_SECRET=مفتاح_سري_آخر_طويل_وعشوائي
CLOUDINARY_CLOUD_NAME=اسم_حسابك
CLOUDINARY_API_KEY=مفتاح_API
CLOUDINARY_API_SECRET=المفتاح_السري
```

### 4. تشغيل الخادم

```bash
npm run dev
```

ستظهر رسائل:

```
قاعدة البيانات متصلة: localhost
Redis متصل
الخادم يعمل على المنفذ 5000 في بيئة development
التوثيق متاح على http://localhost:5000/api/docs
```

### 5. اختبار سريع

```bash
# فحص صحة الخادم
curl http://localhost:5000/api/health
```

### 6. فتح التوثيق التفاعلي

افتح `http://localhost:5000/api/docs` في المتصفح لرؤية جميع نقاط النهاية مع إمكانية اختبارها.

---

## بيانات تجريبية (Seed)

للمطورين والاختبار، يمكن إدراج مستخدمين تجريبيين جاهزين (مدير نظام، مسؤول، مستخدمون، وحساب مقفل):

```bash
# من مجلد backend
npm run seed
```

- **كلمة المرور لجميع الحسابات:** `Test123!@#`
- **مدير نظام:** `super@church.test` أو `01000000001`
- **مسؤول:** `admin@church.test` أو `01000000003`
- **مستخدمون:** مثلاً `mina@church.test`، `samira@church.test`، `locked@church.test` (مقفل)

للمسح ثم إعادة الإدراج من الصفر (مفيد عند تغيير شكل البيانات):

```bash
# Windows (PowerShell)
$env:SEED_CLEAR="1"; npm run seed

# Linux / macOS
SEED_CLEAR=1 npm run seed
```

---

## إنشاء أول مستخدم (Super Admin)

عند بدء النظام لأول مرة، تحتاج إنشاء مستخدم بدور `SUPER_ADMIN`.

### الطريقة 1: عبر API (التسجيل ثم الترقية)

```bash
# 1. تسجيل مستخدم عادي
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "المدير العام",
    "phonePrimary": "01000000000",
    "password": "Admin@123456",
    "birthDate": "1985-01-01",
    "gender": "male"
  }'
```

### الطريقة 2: عبر MongoDB مباشرة

بعد التسجيل، غيّر الدور في قاعدة البيانات:

```javascript
// في MongoDB Shell
db.users.updateOne(
  { phonePrimary: "01000000000" },
  { $set: { role: "SUPER_ADMIN" } }
);
```

---

## العنوان الأساسي (Base URL)

```
http://localhost:5000/api
```

جميع نقاط النهاية تبدأ بـ `/api/`.
