const Joi = require('joi');
const { ROLES_ARRAY } = require('../../constants/roles');
const { AGE_GROUPS_ARRAY } = require('../../constants/ageGroups');
const { LOCK_REASONS_ARRAY } = require('../../constants/lockReasons');
const { PERMISSIONS_ARRAY } = require('../../constants/permissions');

const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_\-+=])[A-Za-z\d@$!%*?&#^()_\-+=]{8,}$/;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/* ──────── المعرّف ──────── */

const idParam = {
  params: Joi.object({
    id: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
      'string.pattern.base': 'معرّف المستخدم غير صالح',
      'any.required': 'معرّف المستخدم مطلوب',
    }),
  }),
};

/* ──────── العنوان ──────── */

const addressSchema = Joi.object({
  governorate: Joi.string().trim().allow('', null).optional(),
  city: Joi.string().trim().allow('', null).optional(),
  street: Joi.string().trim().allow('', null).optional(),
  details: Joi.string().trim().allow('', null).optional(),
});

/* ──────── فرد عائلة (للتحديث) ──────── */

const familyMemberSchema = Joi.object({
  userId: Joi.string().pattern(OBJECT_ID_PATTERN).allow(null).optional(),
  name: Joi.string().trim().allow('', null).optional(),
  relationRole: Joi.string().trim().allow('', null).optional(),
  notes: Joi.string().trim().allow('', null).optional(),
});

/* ──────── إنشاء مستخدم ──────── */

const createUser = {
  body: Joi.object({
    fullName: Joi.string().trim().min(2).max(100).required().messages({
      'string.empty': 'الاسم الكامل مطلوب',
      'string.min': 'الاسم يجب أن يكون حرفين على الأقل',
      'string.max': 'الاسم يجب ألا يتجاوز 100 حرف',
      'any.required': 'الاسم الكامل مطلوب',
    }),
    gender: Joi.string().valid('male', 'female', 'other').optional().messages({
      'any.only': 'الجنس يجب أن يكون ذكر أو أنثى أو آخر',
    }),
    birthDate: Joi.date().iso().max('now').required().messages({
      'date.base': 'تاريخ الميلاد غير صالح',
      'date.max': 'تاريخ الميلاد لا يمكن أن يكون في المستقبل',
      'any.required': 'تاريخ الميلاد مطلوب',
    }),
    nationalId: Joi.string().trim().min(10).max(20).optional().messages({
      'string.min': 'الرقم القومي يجب أن يكون 10 أرقام على الأقل',
      'string.max': 'الرقم القومي يجب ألا يتجاوز 20 رقم',
    }),
    notes: Joi.string().trim().max(1000).allow('', null).optional().messages({
      'string.max': 'الملاحظات يجب ألا تتجاوز 1000 حرف',
    }),
    phonePrimary: Joi.string().trim().min(10).max(15).required().messages({
      'string.empty': 'رقم الهاتف الأساسي مطلوب',
      'string.min': 'رقم الهاتف يجب أن يكون 10 أرقام على الأقل',
      'string.max': 'رقم الهاتف يجب ألا يتجاوز 15 رقم',
      'any.required': 'رقم الهاتف الأساسي مطلوب',
    }),
    phoneSecondary: Joi.string().trim().min(10).max(15).allow('', null).optional().messages({
      'string.min': 'رقم الهاتف الثانوي يجب أن يكون 10 أرقام على الأقل',
    }),
    whatsappNumber: Joi.string().trim().min(10).max(15).allow('', null).optional(),
    email: Joi.string().email().lowercase().trim().allow('', null).optional().messages({
      'string.email': 'البريد الإلكتروني غير صالح',
    }),
    address: addressSchema.optional(),
    tags: Joi.array().items(Joi.string().trim()).optional(),
    familyName: Joi.string().trim().allow('', null).optional(),
    houseName: Joi.string().trim().allow('', null).optional(),
    role: Joi.string().valid(...ROLES_ARRAY).optional().messages({
      'any.only': 'الدور غير صالح',
    }),
    password: Joi.string().pattern(PASSWORD_PATTERN).optional().messages({
      'string.pattern.base':
        'كلمة المرور يجب أن تحتوي على 8 أحرف على الأقل وتشمل حرف كبير وحرف صغير ورقم ورمز خاص',
    }),
    extraPermissions: Joi.array()
      .items(Joi.string().valid(...PERMISSIONS_ARRAY))
      .optional(),
    deniedPermissions: Joi.array()
      .items(Joi.string().valid(...PERMISSIONS_ARRAY))
      .optional(),
    confessionFatherName: Joi.string().trim().allow('', null).optional(),
    avatar: Joi.object({
      url: Joi.string().uri().required(),
      publicId: Joi.string().required(),
    }).optional(),
    customDetails: Joi.object()
      .pattern(Joi.string().trim().min(1), Joi.string().trim().allow(''))
      .optional(),
  }),
};

/* ──────── تحديث مستخدم ──────── */

const updateUser = {
  params: idParam.params,
  body: Joi.object({
    fullName: Joi.string().trim().min(2).max(100).optional(),
    gender: Joi.string().valid('male', 'female', 'other').optional(),
    birthDate: Joi.date().iso().max('now').optional(),
    nationalId: Joi.string().trim().min(10).max(20).allow(null, '').optional(),
    notes: Joi.string().trim().max(1000).allow(null, '').optional(),
    phonePrimary: Joi.string().trim().min(10).max(15).optional(),
    phoneSecondary: Joi.string().trim().min(10).max(15).allow(null, '').optional(),
    whatsappNumber: Joi.string().trim().min(10).max(15).allow(null, '').optional(),
    email: Joi.string().email().lowercase().trim().allow(null, '').optional(),
    address: addressSchema.optional(),
    tags: Joi.array().items(Joi.string().trim()).optional(),
    familyName: Joi.string().trim().allow(null, '').optional(),
    houseName: Joi.string().trim().allow(null, '').optional(),
    role: Joi.string().valid(...ROLES_ARRAY).optional(),
    extraPermissions: Joi.array()
      .items(Joi.string().valid(...PERMISSIONS_ARRAY))
      .optional(),
    deniedPermissions: Joi.array()
      .items(Joi.string().valid(...PERMISSIONS_ARRAY))
      .optional(),
    confessionFatherName: Joi.string().trim().allow(null, '').optional(),
    avatar: Joi.object({
      url: Joi.string().uri().allow(null),
      publicId: Joi.string().allow(null),
    }).optional(),
    customDetails: Joi.object()
      .pattern(Joi.string().trim().min(1), Joi.string().trim().allow(''))
      .optional(),
    father: familyMemberSchema.allow(null).optional(),
    mother: familyMemberSchema.allow(null).optional(),
    spouse: familyMemberSchema.allow(null).optional(),
    siblings: Joi.array().items(familyMemberSchema).optional(),
    children: Joi.array().items(familyMemberSchema).optional(),
    familyMembers: Joi.array().items(familyMemberSchema).optional(),
  })
    .min(1)
    .messages({ 'object.min': 'يجب تقديم حقل واحد على الأقل للتحديث' }),
};

/* ──────── قائمة المستخدمين ──────── */

const listUsers = {
  query: Joi.object({
    cursor: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).default(20).messages({
      'number.min': 'الحد الأدنى للنتائج هو 1',
      'number.max': 'الحد الأقصى للنتائج هو 100',
    }),
    sort: Joi.string().valid('createdAt', 'fullName', 'birthDate').default('createdAt'),
    order: Joi.string().valid('asc', 'desc').default('desc'),
    fullName: Joi.string().trim().optional(),
    phonePrimary: Joi.string().trim().optional(),
    ageGroup: Joi.string()
      .valid(...AGE_GROUPS_ARRAY)
      .optional(),
    tags: Joi.alternatives()
      .try(Joi.array().items(Joi.string()), Joi.string())
      .optional(),
    role: Joi.string().valid(...ROLES_ARRAY).optional(),
    familyName: Joi.string().trim().optional(),
    houseName: Joi.string().trim().optional(),
    gender: Joi.string().valid('male', 'female', 'other').optional(),
    isLocked: Joi.boolean().optional(),
  }),
};

/* ──────── قفل حساب ──────── */

const lockUser = {
  params: idParam.params,
  body: Joi.object({
    lockReason: Joi.string()
      .valid(...LOCK_REASONS_ARRAY)
      .required()
      .messages({
        'any.only': 'سبب القفل غير صالح',
        'any.required': 'سبب القفل مطلوب',
      }),
  }),
};

/* ──────── إدارة الوسوم ──────── */

const manageTags = {
  params: idParam.params,
  body: Joi.object({
    add: Joi.array().items(Joi.string().trim()).optional().default([]),
    remove: Joi.array().items(Joi.string().trim()).optional().default([]),
  })
    .or('add', 'remove')
    .messages({
      'object.missing': 'يجب تقديم وسوم للإضافة أو الإزالة',
    }),
};

/* ──────── ربط فرد عائلة ──────── */

const linkFamily = {
  params: idParam.params,
  body: Joi.object({
    relation: Joi.string()
      .valid('father', 'mother', 'spouse', 'sibling', 'child', 'other')
      .required()
      .messages({
        'any.only': 'نوع العلاقة غير صالح. القيم المسموحة: father, mother, spouse, sibling, child, other',
        'any.required': 'نوع العلاقة مطلوب',
      }),
    targetPhone: Joi.string().trim().optional(),
    targetNationalId: Joi.string().trim().optional(),
    targetFullName: Joi.string().trim().optional(),
    targetBirthDate: Joi.date().iso().optional(),
    name: Joi.string().trim().optional(),
    relationRole: Joi.string().trim().required().messages({
      'string.empty': 'وصف صلة القرابة مطلوب',
      'any.required': 'وصف صلة القرابة مطلوب',
    }),
    notes: Joi.string().trim().allow('', null).optional(),
  }),
};

/* ──────── إضافة وصف صلة قرابة ──────── */

const createRelationRole = {
  body: Joi.object({
    label: Joi.string().trim().min(1).required().messages({
      'string.empty': 'وصف صلة القرابة مطلوب',
      'any.required': 'وصف صلة القرابة مطلوب',
    }),
  }),
};

module.exports = {
  idParam,
  createUser,
  updateUser,
  listUsers,
  lockUser,
  manageTags,
  linkFamily,
  createRelationRole,
};
