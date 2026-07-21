/**
 * Fields and content classes that must never reach a model provider.
 *
 * This is the Level-4 list from the strategy: not "minimize", not "prefer not
 * to" — never. A match is a hard failure of the request, not a filtered field,
 * because a denylisted value appearing in an outbound payload means an upstream
 * caller did something the design does not allow, and silently stripping it
 * would hide that defect.
 */

/**
 * Object keys that may never appear in an outbound AI payload.
 * Matched case-insensitively, at any nesting depth.
 */
const DENIED_FIELD_NAMES = Object.freeze([
  // Identity — a person's name is PII even though it is not "sensitive".
  // The MVP payloads never carry these; a future feature passing a user
  // subdocument is exactly what this list is here to stop.
  'fullName', 'firstName', 'lastName', 'middleName', 'nameSnapshot',
  'attendeeNameSnapshot', 'requesterName',
  // Pastoral and confession records
  'notes', 'note', 'confessionNotes', 'pastoralNotes', 'sessionNotes',
  'confessionFatherUserId', 'confessionFatherName', 'confessionSessionIds',
  // Private messaging
  'message', 'messages', 'chatMessage', 'messageBody', 'content',
  // Health
  'health', 'healthConditions', 'diseases', 'disease', 'medicalNotes',
  'conditions', 'chronic',
  // Financial and aid
  'financial', 'income', 'monthlyIncome', 'salary', 'amount', 'aidAmount',
  'incomeSources', 'currency', 'disbursement', 'jobTitle', 'employerName',
  'employment',
  // Government and strong identifiers
  'nationalId', 'nationalID', 'passportNumber', 'ssn',
  // Direct contact details
  'phone', 'phonePrimary', 'phoneSecondary', 'mobile', 'whatsappNumber',
  'email', 'address', 'streetAddress', 'houseAddress', 'street', 'city',
  'governorate', 'location', 'coordinates',
  // Education (school/university names identify a person's institution)
  'schoolName', 'universityName',
  // Travel
  'travelDestination', 'travelReason',
  // Family graph
  'father', 'mother', 'spouse', 'siblings', 'children', 'familyMembers',
  'guardianName', 'relationRole',
  // Free-form container that can hold anything
  'customDetails',
  // Credentials
  'password', 'passwordHash', 'token', 'accessToken', 'refreshToken',
  'apiKey', 'api_key', 'secret', 'authorization', 'cookie',
  // Raw uploads
  'buffer', 'fileBuffer', 'attachment', 'attachments', 'storageKey',
  // Children
  'birthDate', 'dateOfBirth', 'age',
]);

/**
 * Value patterns that must never appear in outbound text, whatever the key.
 * These catch personal data pasted into a free-text field, which is the
 * realistic leak path once the field-name gate is in place.
 */
const DENIED_VALUE_PATTERNS = Object.freeze([
  Object.freeze({
    name: 'egyptian_national_id',
    // 14 digits, century digit 2 or 3, plausible month/day.
    pattern: /\b[23]\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{7}\b/g,
  }),
  Object.freeze({
    name: 'egyptian_mobile',
    pattern: /\b(?:\+?20)?0?1[0125]\d{8}\b/g,
  }),
  Object.freeze({
    name: 'email_address',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  }),
  Object.freeze({
    name: 'iban',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  }),
  Object.freeze({
    name: 'credit_card',
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
  }),
  Object.freeze({
    name: 'provider_api_key',
    pattern: /\b(?:sk-ant-|sk-proj-|sk-svcacct-|sk-|AIza|gsk_|xai-)[A-Za-z0-9\-_]{16,}/g,
  }),
  Object.freeze({
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  }),
]);

const DENIED_FIELD_SET = new Set(DENIED_FIELD_NAMES.map((name) => name.toLowerCase()));

function isDeniedFieldName(key) {
  return DENIED_FIELD_SET.has(String(key).toLowerCase());
}

module.exports = {
  DENIED_FIELD_NAMES,
  DENIED_VALUE_PATTERNS,
  DENIED_FIELD_SET,
  isDeniedFieldName,
};
