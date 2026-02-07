const LOCK_REASONS = Object.freeze({
  ADMIN_DECISION: 'قرار إداري',
  SECURITY_BREACH: 'اختراق أمني',
  INAPPROPRIATE_BEHAVIOR: 'سلوك غير لائق',
  INACTIVE: 'عدم نشاط',
  MULTIPLE_FAILED_LOGINS: 'محاولات دخول فاشلة متعددة',
  DATA_INTEGRITY: 'مشاكل في سلامة البيانات',
  OTHER: 'سبب آخر',
});

const LOCK_REASONS_ARRAY = Object.values(LOCK_REASONS);

module.exports = { LOCK_REASONS, LOCK_REASONS_ARRAY };
