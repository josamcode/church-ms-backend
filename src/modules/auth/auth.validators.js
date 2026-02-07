const Joi = require('joi');

const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_\-+=])[A-Za-z\d@$!%*?&#^()_\-+=]{8,}$/;

const register = {
  body: Joi.object({
    fullName: Joi.string().trim().min(2).max(100).required().messages({
      'string.empty': 'الاسم الكامل مطلوب',
      'string.min': 'الاسم يجب أن يكون حرفين على الأقل',
      'string.max': 'الاسم يجب ألا يتجاوز 100 حرف',
      'any.required': 'الاسم الكامل مطلوب',
    }),
    phonePrimary: Joi.string().trim().min(10).max(15).required().messages({
      'string.empty': 'رقم الهاتف الأساسي مطلوب',
      'string.min': 'رقم الهاتف يجب أن يكون 10 أرقام على الأقل',
      'string.max': 'رقم الهاتف يجب ألا يتجاوز 15 رقم',
      'any.required': 'رقم الهاتف الأساسي مطلوب',
    }),
    email: Joi.string().email().lowercase().trim().optional().messages({
      'string.email': 'البريد الإلكتروني غير صالح',
    }),
    password: Joi.string().pattern(PASSWORD_PATTERN).required().messages({
      'string.pattern.base':
        'كلمة المرور يجب أن تحتوي على 8 أحرف على الأقل وتشمل حرف كبير وحرف صغير ورقم ورمز خاص',
      'string.empty': 'كلمة المرور مطلوبة',
      'any.required': 'كلمة المرور مطلوبة',
    }),
    birthDate: Joi.date().iso().max('now').required().messages({
      'date.base': 'تاريخ الميلاد غير صالح',
      'date.format': 'تاريخ الميلاد يجب أن يكون بصيغة ISO',
      'date.max': 'تاريخ الميلاد لا يمكن أن يكون في المستقبل',
      'any.required': 'تاريخ الميلاد مطلوب',
    }),
    gender: Joi.string().valid('male', 'female', 'other').optional().messages({
      'any.only': 'الجنس يجب أن يكون ذكر أو أنثى أو آخر',
    }),
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
        'كلمة المرور الجديدة يجب أن تحتوي على 8 أحرف على الأقل وتشمل حرف كبير وحرف صغير ورقم ورمز خاص',
      'string.empty': 'كلمة المرور الجديدة مطلوبة',
      'any.required': 'كلمة المرور الجديدة مطلوبة',
    }),
  }),
};

module.exports = {
  register,
  login,
  refreshToken,
  logout,
  changePassword,
};
