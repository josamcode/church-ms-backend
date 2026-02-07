# دليل الأدوار والصلاحيات

## نظام RBAC

النظام يستخدم **التحكم بالوصول المبني على الأدوار** (Role-Based Access Control) مع إمكانية تخصيص الصلاحيات لكل مستخدم.

---

## الأدوار الأساسية

### 1. `SUPER_ADMIN` — مدير النظام

- جميع الصلاحيات بدون استثناء
- لا يمكن تقييد صلاحياته

### 2. `ADMIN` — مسؤول

- إدارة المستخدمين كاملة (عرض، إنشاء، تعديل، حذف، قفل)
- إدارة الوسوم وربط العائلة
- تغيير كلمة المرور الخاصة
- **لا يمكنه** إدارة جلسات المستخدمين الآخرين

### 3. `USER` — مستخدم عادي

- عرض بيانات حسابه فقط
- تعديل بياناته الشخصية
- رفع صورته الشخصية
- تغيير كلمة مروره

---

## جدول الصلاحيات حسب الدور

| الصلاحية                   | SUPER_ADMIN | ADMIN | USER |
| -------------------------- | :---------: | :---: | :--: |
| `USERS_VIEW`               |     ✅      |  ✅   |  ❌  |
| `USERS_VIEW_SELF`          |     ✅      |  ✅   |  ✅  |
| `USERS_CREATE`             |     ✅      |  ✅   |  ❌  |
| `USERS_UPDATE`             |     ✅      |  ✅   |  ❌  |
| `USERS_UPDATE_SELF`        |     ✅      |  ✅   |  ✅  |
| `USERS_DELETE`             |     ✅      |  ✅   |  ❌  |
| `USERS_LOCK`               |     ✅      |  ✅   |  ❌  |
| `USERS_UNLOCK`             |     ✅      |  ✅   |  ❌  |
| `USERS_TAGS_MANAGE`        |     ✅      |  ✅   |  ❌  |
| `USERS_FAMILY_LINK`        |     ✅      |  ✅   |  ❌  |
| `USERS_UPLOAD_AVATAR`      |     ✅      |  ✅   |  ❌  |
| `USERS_UPLOAD_AVATAR_SELF` |     ✅      |  ✅   |  ✅  |
| `AUTH_VIEW_SELF`           |     ✅      |  ✅   |  ✅  |
| `AUTH_MANAGE_SESSIONS`     |     ✅      |  ❌   |  ❌  |
| `AUTH_CHANGE_PASSWORD`     |     ✅      |  ✅   |  ✅  |

---

## الصلاحيات المخصصة

### صلاحيات إضافية (`extraPermissions`)

يمكن منح مستخدم صلاحيات إضافية خارج دوره الأساسي:

```json
// PATCH /api/users/:id
{
  "extraPermissions": ["USERS_VIEW", "USERS_CREATE"]
}
```

### صلاحيات مرفوضة (`deniedPermissions`)

يمكن سحب صلاحيات محددة من مستخدم:

```json
// PATCH /api/users/:id
{
  "deniedPermissions": ["USERS_DELETE"]
}
```

### حساب الصلاحيات الفعّالة

```
الصلاحيات الفعّالة = (صلاحيات الدور + extraPermissions) - deniedPermissions
```

**مثال:**

- مستخدم بدور `ADMIN` لديه صلاحية `USERS_DELETE`
- إضافة `USERS_DELETE` في `deniedPermissions`
- النتيجة: لا يستطيع حذف المستخدمين

---

## التخزين المؤقت للصلاحيات

الصلاحيات الفعّالة تُخزّن في Redis لمدة **30 دقيقة**:

- مفتاح: `user:permissions:{userId}`
- تُمسح تلقائياً عند:
  - تحديث بيانات المستخدم (الدور أو الصلاحيات)
  - قفل/فتح الحساب
  - تسجيل الخروج
  - حذف المستخدم

---

## معالجة أخطاء الصلاحيات في الواجهة

```javascript
// عند تلقي PERMISSION_DENIED
if (error.response?.data?.error?.code === "PERMISSION_DENIED") {
  showToast("ليس لديك صلاحية لتنفيذ هذا الإجراء");
  // يمكنك توجيه المستخدم لصفحة رئيسية
}
```

---

## إضافة صلاحيات لوحدة جديدة

عند إضافة وحدة جديدة (مثل الاجتماعات)، أضف الصلاحيات في:

### 1. `src/constants/permissions.js`

```javascript
const PERMISSIONS = Object.freeze({
  // ... الصلاحيات الحالية ...

  // الاجتماعات (جديد)
  MEETINGS_VIEW: "MEETINGS_VIEW",
  MEETINGS_CREATE: "MEETINGS_CREATE",
  MEETINGS_UPDATE: "MEETINGS_UPDATE",
  MEETINGS_DELETE: "MEETINGS_DELETE",
});
```

### 2. تحديث `ROLE_PERMISSIONS` في نفس الملف

```javascript
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.SUPER_ADMIN]: [...PERMISSIONS_ARRAY],
  [ROLES.ADMIN]: [
    // ... الصلاحيات الحالية ...
    PERMISSIONS.MEETINGS_VIEW,
    PERMISSIONS.MEETINGS_CREATE,
    PERMISSIONS.MEETINGS_UPDATE,
  ],
  // ...
});
```

### 3. استخدام الصلاحية في المسارات

```javascript
router.get(
  "/",
  authenticateJWT,
  authorizePermissions(PERMISSIONS.MEETINGS_VIEW),
  meetingController.list
);
```
