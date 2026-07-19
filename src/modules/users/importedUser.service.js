const User = require('./user.model');
const ApiError = require('../../utils/ApiError');
const { ROLES } = require('../../constants/roles');
const { ACCOUNT_STATUSES } = require('../../constants/accountStatuses');

const FORBIDDEN_IMPORT_FIELDS = Object.freeze([
  'password', 'passwordHash', 'loginIdentifierType', 'username',
  'nationalId', 'phonePrimary', 'phoneSecondary', 'whatsappNumber', 'email',
  'birthDate', 'ageGroup', 'father', 'mother', 'spouse', 'siblings', 'children',
  'familyMembers', 'familyName', 'houseName', 'meeting', 'meetings', 'group', 'groups',
]);

function hasProvidedValue(data, field) {
  if (!Object.prototype.hasOwnProperty.call(data || {}, field)) return false;
  const value = data[field];
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '';
}

function validateImportedUserData(data) {
  if (!data || typeof data !== 'object') throw ApiError.badRequest('Imported person payload is required', 'VALIDATION_ERROR');
  if (data.hasLogin !== false) throw ApiError.badRequest('Imported person records must have login disabled', 'IMPORT_CREDENTIALS_FORBIDDEN');
  if (['password', 'passwordHash', 'loginIdentifierType', 'username'].some((field) => Object.prototype.hasOwnProperty.call(data, field))) {
    throw ApiError.badRequest('Imported person records must not contain credential fields', 'IMPORT_CREDENTIALS_FORBIDDEN');
  }
  const forbidden = FORBIDDEN_IMPORT_FIELDS.filter((field) => hasProvidedValue(data, field));
  if (forbidden.length) throw ApiError.badRequest(`Imported person contains forbidden fields: ${forbidden.join(', ')}`, 'IMPORT_FIELD_FORBIDDEN');
  const sourceKey = String(data.customDetails?.importSourceKey || '').trim();
  if (!sourceKey) throw ApiError.badRequest('Imported person source key is required', 'VALIDATION_ERROR');
  return sourceKey;
}

async function assertImportActor(actorUserId, session = null) {
  let query = User.findOne({ _id: actorUserId, isDeleted: { $ne: true } }).select('_id role accountStatus isLocked');
  if (session) query = query.session(session);
  const actor = await query.lean();
  if (!actor || actor.role !== ROLES.SUPER_ADMIN || actor.accountStatus !== ACCOUNT_STATUSES.APPROVED || actor.isLocked) {
    throw ApiError.forbidden('Import actor must be an approved, unlocked SUPER_ADMIN', 'PERMISSION_DENIED');
  }
  return actor;
}

async function createImportedUser(data, createdByUserId, { session = null, actorAlreadyVerified = false } = {}) {
  const sourceKey = validateImportedUserData(data);
  if (!actorAlreadyVerified) await assertImportActor(createdByUserId, session);
  let existingQuery = User.find({ 'customDetails.importSourceKey': sourceKey, includeDeleted: true }).select('_id fullName isDeleted customDetails');
  if (session) existingQuery = existingQuery.session(session);
  const existing = await existingQuery.lean();
  if (existing.length) throw ApiError.conflict('Import source key already exists', 'IMPORT_SOURCE_KEY_EXISTS');

  const user = new User({
    ...data,
    role: ROLES.USER,
    accountStatus: ACCOUNT_STATUSES.APPROVED,
    hasLogin: false,
    isLocked: false,
    isDeleted: false,
    createdBy: createdByUserId,
    changeLog: [
      ...(Array.isArray(data.changeLog) ? data.changeLog : []),
      {
        by: createdByUserId,
        action: 'إنشاء مستخدم من استيراد معتمد',
        changes: [{ field: 'importSourceKey', from: null, to: sourceKey }],
      },
    ],
  });
  if (session) await user.save({ session });
  else await user.save();
  return user.toSafeObject();
}

module.exports = { FORBIDDEN_IMPORT_FIELDS, validateImportedUserData, assertImportActor, createImportedUser };
