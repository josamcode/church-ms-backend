const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  USER: 'USER',
});

const ROLES_ARRAY = Object.values(ROLES);

const ROLES_ARABIC = Object.freeze({
  [ROLES.SUPER_ADMIN]: 'مدير النظام',
  [ROLES.ADMIN]: 'مسؤول',
  [ROLES.USER]: 'مستخدم',
});

module.exports = { ROLES, ROLES_ARRAY, ROLES_ARABIC };
