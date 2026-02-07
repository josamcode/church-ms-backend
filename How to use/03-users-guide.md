# دليل إدارة المستخدمين

## نظرة عامة

جميع نقاط نهاية المستخدمين تتطلب **مصادقة** (Bearer Token) وصلاحيات محددة.

---

## نقاط النهاية

### 1. إنشاء مستخدم — `POST /api/users`

**صلاحية مطلوبة:** `USERS_CREATE`

يمكن إنشاء مستخدم مع أو بدون حساب دخول.

```json
// مستخدم بدون حساب دخول (ملف شخصي فقط)
{
  "fullName": "مريم يوسف",
  "phonePrimary": "01098765432",
  "birthDate": "2000-01-15",
  "gender": "female",
  "tags": ["خادمة", "كورال"],
  "familyName": "يوسف",
  "address": {
    "governorate": "القاهرة",
    "city": "مصر الجديدة",
    "street": "شارع الحرية",
    "details": "عمارة 5 شقة 12"
  }
}

// مستخدم مع حساب دخول
{
  "fullName": "بطرس حنا",
  "phonePrimary": "01112233445",
  "birthDate": "1988-03-20",
  "gender": "male",
  "password": "Pass@1234",
  "role": "ADMIN"
}
```

---

### 2. قائمة المستخدمين — `GET /api/users`

**صلاحية مطلوبة:** `USERS_VIEW`

#### ترقيم المؤشر (Cursor-based Pagination)

بدلاً من `page` و `offset`، يُستخدم **مؤشر** (cursor) يمثل قيمة آخر عنصر في الصفحة السابقة.

```
GET /api/users?limit=20

// الاستجابة
{
  "data": [ ... 20 مستخدم ... ],
  "meta": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "2024-01-15T10:30:00.000Z",
    "count": 20
  }
}

// الصفحة التالية
GET /api/users?limit=20&cursor=2024-01-15T10:30:00.000Z
```

#### الفلاتر المتاحة

| المعامل        | النوع   | الوصف                  | مثال                                 |
| -------------- | ------- | ---------------------- | ------------------------------------ |
| `cursor`       | string  | مؤشر الترقيم           | `2024-01-15T10:30:00.000Z`           |
| `limit`        | number  | عدد النتائج (1-100)    | `20`                                 |
| `sort`         | string  | حقل الترتيب            | `createdAt`, `fullName`, `birthDate` |
| `order`        | string  | اتجاه الترتيب          | `asc`, `desc`                        |
| `fullName`     | string  | بحث بالاسم (جزئي)      | `يوحنا`                              |
| `phonePrimary` | string  | بحث بالهاتف (جزئي)     | `0123`                               |
| `ageGroup`     | string  | الفئة العمرية          | `شاب`                                |
| `tags`         | string  | الوسوم (مفصولة بفاصلة) | `خادم,شماس`                          |
| `role`         | string  | الدور                  | `ADMIN`                              |
| `gender`       | string  | الجنس                  | `male`                               |
| `isLocked`     | boolean | حالة القفل             | `true`                               |

**مثال:**

```
GET /api/users?ageGroup=شاب&tags=خادم&sort=fullName&order=asc&limit=10
```

---

### 3. جلب مستخدم بالمعرّف — `GET /api/users/:id`

**صلاحية مطلوبة:** `USERS_VIEW`

```
GET /api/users/65a1b2c3d4e5f6g7h8i9j0k1
```

---

### 4. تحديث مستخدم — `PATCH /api/users/:id`

**صلاحية مطلوبة:** `USERS_UPDATE`

أرسل **فقط** الحقول المراد تحديثها. يتم تسجيل كل تغيير في سجل المراجعة (changeLog).

```json
// تحديث الاسم والعنوان
{
  "fullName": "يوحنا مرقس إبراهيم",
  "address": {
    "governorate": "الإسكندرية",
    "city": "سموحة"
  }
}
```

---

### 5. حذف مستخدم — `DELETE /api/users/:id`

**صلاحية مطلوبة:** `USERS_DELETE`

**حذف ناعم**: يُعلّم المستخدم بـ `isDeleted=true` ولا يُحذف من قاعدة البيانات.

```
DELETE /api/users/65a1b2c3d4e5f6g7h8i9j0k1
```

---

### 6. رفع صورة شخصية — `POST /api/users/:id/avatar`

**صلاحية مطلوبة:** `USERS_UPLOAD_AVATAR`

أرسل الصورة كـ **multipart/form-data** في حقل `avatar`.

```javascript
const formData = new FormData();
formData.append("avatar", fileInput.files[0]);

const response = await fetch(`/api/users/${userId}/avatar`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
  body: formData,
});
```

**القيود:**

- الأنواع المسموحة: JPEG, PNG, GIF, WEBP
- الحجم الأقصى: 5 ميجابايت
- يتم تحويل الصورة تلقائياً: 400×400 بكسل مع قص ذكي

**الاستجابة:**

```json
{
  "success": true,
  "message": "تم رفع الصورة الشخصية بنجاح",
  "data": {
    "url": "https://res.cloudinary.com/...",
    "publicId": "church/avatars/abc123"
  }
}
```

---

### 7. قفل حساب — `POST /api/users/:id/lock`

**صلاحية مطلوبة:** `USERS_LOCK`

```json
{
  "lockReason": "قرار إداري"
}
```

**أسباب القفل المتاحة:**

- `قرار إداري`
- `اختراق أمني`
- `سلوك غير لائق`
- `عدم نشاط`
- `محاولات دخول فاشلة متعددة`
- `مشاكل في سلامة البيانات`
- `سبب آخر`

---

### 8. فتح حساب — `POST /api/users/:id/unlock`

**صلاحية مطلوبة:** `USERS_UNLOCK`

```
POST /api/users/65a1b2c3d4e5f6g7h8i9j0k1/unlock
```

---

### 9. إدارة الوسوم — `POST /api/users/:id/tags`

**صلاحية مطلوبة:** `USERS_TAGS_MANAGE`

```json
{
  "add": ["شماس", "مرتل"],
  "remove": ["زائر"]
}
```

---

### 10. ربط فرد عائلة — `POST /api/users/:id/family/link`

**صلاحية مطلوبة:** `USERS_FAMILY_LINK`

النظام يبحث تلقائياً عن الشخص المستهدف:

1. بالهاتف (`targetPhone`)
2. بالرقم القومي (`targetNationalId`)
3. بالاسم + تاريخ الميلاد (`targetFullName` + `targetBirthDate`)

إذا وُجد → يُربط بالـ `userId`
إذا لم يُوجد → يُخزن الاسم فقط (ويمكن ربطه لاحقاً)

```json
// ربط أب موجود في النظام
{
  "relation": "father",
  "targetPhone": "01055566677",
  "relationRole": "أب"
}

// ربط أخ غير موجود في النظام
{
  "relation": "sibling",
  "name": "متى يوحنا",
  "relationRole": "أخ",
  "notes": "يعيش في الخارج"
}
```

**أنواع العلاقات:**

| القيمة    | الوصف                  |
| --------- | ---------------------- |
| `father`  | أب (علاقة مفردة)       |
| `mother`  | أم (علاقة مفردة)       |
| `spouse`  | زوج/زوجة (علاقة مفردة) |
| `sibling` | أخ/أخت (مصفوفة)        |
| `child`   | ابن/بنت (مصفوفة)       |
| `other`   | قريب آخر (مصفوفة)      |
