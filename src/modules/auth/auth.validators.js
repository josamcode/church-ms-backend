const Joi = require('joi');
const {
  EMPLOYMENT_STATUSES_ARRAY,
  PRESENCE_STATUSES_ARRAY,
} = require('../../constants/householdProfiles');
const { EDUCATION_STAGE_VALUES } = require('../../constants/education');

const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_\-+=])[A-Za-z\d@$!%*?&#^()_\-+=]{8,}$/;

const addressSchema = Joi.object({
  governorate: Joi.string().trim().allow('', null).optional(),
  city: Joi.string().trim().allow('', null).optional(),
  street: Joi.string().trim().allow('', null).optional(),
  details: Joi.string().trim().allow('', null).optional(),
});

const employmentSchema = Joi.object({
  status: Joi.string().valid(...EMPLOYMENT_STATUSES_ARRAY).allow('', null).optional(),
  jobTitle: Joi.string().trim().allow('', null).optional(),
  employerName: Joi.string().trim().allow('', null).optional(),
  notes: Joi.string().trim().allow('', null).optional(),
});

const presenceSchema = Joi.object({
  status: Joi.string().valid(...PRESENCE_STATUSES_ARRAY).allow('', null).optional(),
  travelDestination: Joi.string().trim().allow('', null).optional(),
  travelReason: Joi.string().trim().allow('', null).optional(),
});

const educationSchema = Joi.object({
  stage: Joi.string().valid(...EDUCATION_STAGE_VALUES).allow('', null).optional(),
  fieldOfStudy: Joi.string().trim().allow('', null).optional(),
  kindergartenName: Joi.string().trim().allow('', null).optional(),
  schoolName: Joi.string().trim().allow('', null).optional(),
  universityName: Joi.string().trim().allow('', null).optional(),
  facultyName: Joi.string().trim().allow('', null).optional(),
});

const healthConditionSchema = Joi.object({
  name: Joi.string().trim().min(1).required(),
  chronic: Joi.boolean().optional(),
  notes: Joi.string().trim().allow('', null).optional(),
});

const healthSchema = Joi.object({
  conditions: Joi.array().items(healthConditionSchema).optional(),
});

const register = {
  body: Joi.object({
    fullName: Joi.string().trim().min(2).max(100).required().messages({
      'string.empty': 'الاسم الكامل مطلوب',
      'string.min': 'يجب أن يتكون الاسم الكامل من حرفين على الأقل',
      'string.max': 'يجب ألا يزيد الاسم الكامل عن 100 حرف',
      'any.required': 'الاسم الكامل مطلوب',
    }),
    phonePrimary: Joi.string().trim().min(10).max(15).required().messages({
      'string.empty': 'رقم الهاتف الأساسي مطلوب',
      'string.min': 'يجب أن يتكون رقم الهاتف من 10 أرقام على الأقل',
      'string.max': 'يجب ألا يزيد رقم الهاتف عن 15 رقمًا',
      'any.required': 'رقم الهاتف الأساسي مطلوب',
    }),
    email: Joi.string().email().lowercase().trim().optional().messages({
      'string.email': 'البريد الإلكتروني غير صالح',
    }),
    password: Joi.string().pattern(PASSWORD_PATTERN).required().messages({
      'string.pattern.base':
        'يجب أن تحتوي كلمة المرور على 8 أحرف على الأقل، وتشمل حرفًا كبيرًا وحرفًا صغيرًا ورقمًا ورمزًا خاصًا',
      'string.empty': 'كلمة المرور مطلوبة',
      'any.required': 'كلمة المرور مطلوبة',
    }),
    birthDate: Joi.date().iso().max('now').required().messages({
      'date.base': 'تاريخ الميلاد غير صالح',
      'date.format': 'يجب أن يكون تاريخ الميلاد بصيغة ISO',
      'date.max': 'تاريخ الميلاد لا يمكن أن يكون في المستقبل',
      'any.required': 'تاريخ الميلاد مطلوب',
    }),
    gender: Joi.string().valid('male', 'female', 'other').optional().messages({
      'any.only': 'الجنس يجب أن يكون ذكر أو أنثى أو آخر',
    }),
    nationalId: Joi.string().trim().min(10).max(20).allow('', null).optional(),
    phoneSecondary: Joi.string().trim().min(10).max(15).allow('', null).optional(),
    whatsappNumber: Joi.string().trim().min(10).max(15).allow('', null).optional(),
    notes: Joi.string().trim().max(1000).allow('', null).optional(),
    familyName: Joi.string().trim().allow('', null).optional(),
    houseName: Joi.string().trim().allow('', null).optional(),
    address: addressSchema.optional(),
    education: educationSchema.optional(),
    employment: employmentSchema.optional(),
    presence: presenceSchema.optional(),
    health: healthSchema.optional(),
  }),
};

const login = {
  body: Joi.object({
    identifier: Joi.string().trim().required().messages({
      'string.empty': 'رقم الهاتف أو البريد الإلكتروني مطلوب',
      'any.required': 'رقم الهاتف أو البريد الإلكتروني مطلوب',
    }),
    password: Joi.string().required().messages({
      'string.empty': 'كلمة المرور مطلوبة',
      'any.required': 'كلمة المرور مطلوبة',
    }),
  }),
};

const refreshToken = {
  body: Joi.object({
    refreshToken: Joi.string().required().messages({
      'string.empty': 'رمز التحديث مطلوب',
      'any.required': 'رمز التحديث مطلوب',
    }),
  }),
};

const logout = {
  body: Joi.object({
    refreshToken: Joi.string().optional(),
  }),
};

const changePassword = {
  body: Joi.object({
    currentPassword: Joi.string().required().messages({
      'string.empty': 'كلمة المرور الحالية مطلوبة',
      'any.required': 'كلمة المرور الحالية مطلوبة',
    }),
    newPassword: Joi.string().pattern(PASSWORD_PATTERN).required().messages({
      'string.pattern.base':
        'يجب أن تحتوي كلمة المرور الجديدة على 8 أحرف على الأقل، وتشمل حرفًا كبيرًا وحرفًا صغيرًا ورقمًا ورمزًا خاصًا',
      'string.empty': 'كلمة المرور الجديدة مطلوبة',
      'any.required': 'كلمة المرور الجديدة مطلوبة',
    }),
  }),
};

const updateMySettings = {
  body: Joi.object({
    allowOthersToViewCreatedConfessionSessions: Joi.boolean().optional().messages({
      'boolean.base': 'قيمة إتاحة عرض جلسات الاعتراف يجب أن تكون صح أو خطأ',
    }),
    allowOthersToViewCreatedChats: Joi.boolean().optional().messages({
      'boolean.base': 'قيمة إتاحة عرض المحادثات يجب أن تكون صح أو خطأ',
    }),
  })
    .min(1)
    .messages({
      'object.min': 'يجب إرسال إعداد واحد على الأقل للحساب',
    }),
};

module.exports = {
  register,
  login,
  refreshToken,
  logout,
  changePassword,
  updateMySettings,
};
